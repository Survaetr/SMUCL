'use strict';
/**
 * 整合包安装器（Modrinth / CurseForge 共用）
 *
 * 思路与 Prism / MultiMC 一致：整合包本身是一个「实例」，它的版本 JSON 只写
 * inheritsFrom: <加载器 id>，加载器再 inheritsFrom 原版。这样：
 *   - 不必复制客户端 jar 和 libraries
 *   - 实例目录里放 mods / config / saves，天然触发版本隔离（--gameDir 指过去）
 *
 * 三种来源最后都归一到同一个 spec：
 *   { name, mcVersion, loader, loaderVersion, files:[{path,url,sha1,size}],
 *     overridesZip, overridesPrefix }
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const net = require('./net');
const loadersLib = require('./loaders');
const installer = require('./install');
const versionLib = require('./version');
const safe = require('./safe');

/** 把整合包名压成目录名：保留中英文数字，其余换 - */
function slugify(name) {
  return (
    String(name || 'modpack')
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'modpack'
  );
}

function sha1File(file) {
  return new Promise((resolve) => {
    const h = crypto.createHash('sha1');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', () => resolve(''));
  });
}

function uniqueInstanceId(gameDir, base) {
  let id = base;
  let n = 1;
  while (fs.existsSync(path.join(gameDir, 'versions', id))) {
    n++;
    id = `${base}-${n}`;
  }
  return id;
}

/** 找已装好的加载器实例，避免重复安装 */
function findLoaderInstance(gameDir, loader, mcVersion, loaderVersion) {
  const dir = path.join(gameDir, 'versions');
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return null;
  }
  const lower = names.map((n) => n.toLowerCase());

  if (loader === 'fabric' || loader === 'quilt') {
    const want = `${loader}-loader-${loaderVersion}-${mcVersion}`.toLowerCase();
    const i = lower.indexOf(want);
    return i >= 0 ? names[i] : null;
  }
  // Forge / NeoForge：目录名形如 1.21.1-forge-52.1.20 / neoforge-21.1.234
  const key = loader === 'forge' ? `-forge-${loaderVersion}` : `neoforge-${loaderVersion}`;
  const i = lower.findIndex((n) => n.includes(key) && (loader !== 'forge' || n.includes(mcVersion)));
  return i >= 0 ? names[i] : null;
}

/** 摘出加载器版本 JSON 的 mainClass，给实例 JSON 用（版本列表靠它识别加载器） */
function loaderMainClass(gameDir, loaderId) {
  try {
    const json = JSON.parse(
      fs.readFileSync(path.join(gameDir, 'versions', loaderId, `${loaderId}.json`), 'utf8')
    );
    return json.mainClass || '';
  } catch {
    return '';
  }
}

function extractOverrides(zip, prefix, destDir) {
  let count = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    if (!entry.entryName.startsWith(prefix)) continue;
    const rel = entry.entryName.slice(prefix.length);
    if (!rel) continue;
    let dest;
    try {
      // 目录穿越用路径包含性判断，startsWith 前缀比较会被 <dir>-evil 绕过
      dest = safe.safeJoin(destDir, rel);
    } catch {
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      fs.writeFileSync(dest, entry.getData());
      count++;
    } catch {
      /* 单个文件写失败不影响整体 */
    }
  }
  return count;
}

/**
 * 安装一个整合包
 * @param {object} opts
 *  gameDir, spec, javaPath, source, baseUrl, onProgress
 */
async function install({ gameDir, spec, javaPath, source = 'bmcl', baseUrl = '', onProgress }) {
  const report = (patch) => onProgress && onProgress(patch);
  const { name, mcVersion, loader, loaderVersion, files = [] } = spec;

  if (!mcVersion) return { ok: false, error: '整合包没有声明游戏版本' };

  // 1) 原版底座
  const baseJson = path.join(gameDir, 'versions', mcVersion, `${mcVersion}.json`);
  if (!fs.existsSync(baseJson)) {
    if (!baseUrl) return { ok: false, error: `缺少原版 ${mcVersion}，请先在下载页安装它` };
    report({ stage: 'base', message: `补装原版 ${mcVersion}`, percent: 2 });
    await installer.install(mcVersion, { url: baseUrl }, source, (p) => {
      if (p && p.stage) report({ stage: 'base', percent: p.percent, message: `原版：${p.message || ''}` });
    });
  }

  // 2) 加载器
  let loaderId = spec.loaderId || findLoaderInstance(gameDir, loader, mcVersion, loaderVersion);
  if (!loaderId) {
    if (!loader) return { ok: false, error: '整合包没有声明加载器类型' };
    report({ stage: 'loader', message: `安装 ${loader} ${loaderVersion}`, percent: 12 });
    const r = await loadersLib.install({
      loader,
      mcVersion,
      loaderVersion,
      gameDir,
      javaPath,
      source,
      onProgress: (p) => {
        if (p && p.stage === 'libs') report({ stage: 'loader', message: `加载器依赖 ${p.done}/${p.total}`, percent: 15 });
        else if (p && p.message) report({ stage: 'loader', message: p.message, percent: 15 });
      },
    });
    if (!r.ok) return { ok: false, error: `加载器安装失败：${r.error}` };
    loaderId = r.data.id;
  } else {
    report({ stage: 'loader', message: `复用已安装的加载器 ${loaderId}`, percent: 15 });
  }

  // 3) 建实例
  const packId = safe.assertVersionId(uniqueInstanceId(gameDir, `${slugify(name)}-${mcVersion}`));
  const instanceDir = safe.safeJoin(path.join(gameDir, 'versions'), packId);
  await fsp.mkdir(instanceDir, { recursive: true });

  const mainClass = loaderMainClass(gameDir, loaderId);
  const versionJson = {
    id: packId,
    inheritsFrom: loaderId,
    type: 'release',
    mainClass: mainClass || undefined,
    libraries: [],
    _pack: { name, source: spec.source || '', version: spec.packVersion || '' },
  };
  await fsp.writeFile(
    path.join(instanceDir, `${packId}.json`),
    JSON.stringify(versionJson, null, 2),
    'utf8'
  );
  // 建 mods 目录：既是内容容器，也让 isIsolatedInstance 判定为隔离实例
  await fsp.mkdir(path.join(instanceDir, 'mods'), { recursive: true });

  // 4) 下载文件
  const usable = files.filter((f) => f && f.url && f.path && safe.isHttpUrl(f.url));
  let done = 0;
  const failed = [];

  await net.pool(usable, 4, async (f) => {
    let dest;
    try {
      dest = safe.safeJoin(instanceDir, String(f.path));
    } catch {
      failed.push({ path: f.path, reason: '文件路径越界' });
      done++;
      return;
    }
    try {
      await net.download(f.url, dest, {
        expectedSize: f.size || 0,
        retries: 3,
        timeout: 60000,
      });
      if (f.sha1) {
        const got = await sha1File(dest);
        if (got && got.toLowerCase() !== String(f.sha1).toLowerCase()) {
          // 校验不符就删掉重下一次
          try {
            fs.unlinkSync(dest);
          } catch {}
          await net.download(f.url, dest, { retries: 2, timeout: 60000 });
          const again = await sha1File(dest);
          if (again && again.toLowerCase() !== String(f.sha1).toLowerCase()) {
            failed.push({ path: f.path, reason: 'sha1 不匹配' });
          }
        }
      }
    } catch (e) {
      failed.push({ path: f.path, reason: e.message });
    }
    done++;
    if (done % 3 === 0 || done === usable.length) {
      report({
        stage: 'files',
        message: `下载文件 ${done}/${usable.length}`,
        percent: 20 + Math.round((done / Math.max(usable.length, 1)) * 70),
      });
    }
  });

  // 5) overrides
  let overridesCount = 0;
  if (spec.overridesZip && spec.overridesPrefix) {
    report({ stage: 'overrides', message: '解压配置与资源', percent: 92 });
    try {
      const zip = new AdmZip(spec.overridesZip);
      overridesCount = extractOverrides(zip, spec.overridesPrefix, instanceDir);
    } catch (e) {
      failed.push({ path: 'overrides', reason: e.message });
    }
  }

  report({ stage: 'done', message: '安装完成', percent: 100 });

  return {
    ok: true,
    data: {
      id: packId,
      name,
      instanceDir,
      loaderId,
      mcVersion,
      files: usable.length,
      overrides: overridesCount,
      failed,
    },
  };
}

module.exports = { install, slugify, findLoaderInstance };
