'use strict';
/**
 * 导出实例为可分享的整合包（zip）。
 *
 * 结构与 PCL / HMCL 的整包一致，因此导入端（包括本启动器的「导入整合包」）都能直接识别：
 *   <实例名>/versions/<id>/<id>.json
 *   <实例名>/mods/...
 *   <实例名>/config/...
 *
 * 两个关键设计：
 *   1. 版本 JSON 会被**展开成自包含**。SMUCL 自建的整合包实例是三层继承
 *      （整合包 → 加载器 → 原版），直接复制 JSON 会让接收方缺少中间层而无法启动。
 *      这里用 loadVersionJson 拿到合并结果并去掉 inheritsFrom，接收方只认这一层就够。
 *   2. libraries / assets 不进包。它们是公共资源，重复打包会让包体从几十 MB 涨到几百 MB，
 *      而接收方用任意启动器打开都会自动补齐。
 */
const fs = require('fs');
const path = require('path');
const safe = require('./safe');
const versionLib = require('./version');
const zipper = require('./zipper');

/** 可选项：键 → 说明。dir 表示整个目录，file 表示单个文件 */
const INCLUDES = {
  mods: { label: '模组', kind: 'dir', def: true },
  config: { label: '配置', kind: 'dir', def: true },
  defaultconfigs: { label: '默认配置', kind: 'dir', def: true },
  resourcepacks: { label: '资源包', kind: 'dir', def: false },
  shaderpacks: { label: '光影', kind: 'dir', def: false },
  saves: { label: '存档', kind: 'dir', def: false },
  options: { label: '游戏设置', kind: 'file', def: false, name: 'options.txt' },
};

/** 运行时产物，永远不导出 */
const ALWAYS_SKIP = new Set([
  'logs',
  'crash-reports',
  'screenshots',
  'natives',
  '.cache',
  '.mixin.out',
  'debug',
  'replay_recordings',
]);

function isSkippedDir(name) {
  if (ALWAYS_SKIP.has(name)) return true;
  // 某些 mod 会在实例目录里堆运行时缓存，目录名大小写不一
  return /^(natives|logs|cache)$/i.test(name);
}

/** 递归收集目录内的文件（相对路径 + 绝对路径 + 体积） */
function walk(root, sub, out, limit = 20000) {
  const base = path.join(root, sub);
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (out.length >= limit) return;
    const rel = sub ? path.join(sub, ent.name) : ent.name;
    const full = path.join(base, ent.name);
    if (ent.isDirectory()) {
      if (!sub && isSkippedDir(ent.name)) continue;
      walk(root, rel, out, limit);
      continue;
    }
    if (!ent.isFile()) continue;
    try {
      out.push({ rel, full, size: fs.statSync(full).size });
    } catch {
      /* 文件被占用/已删除，跳过 */
    }
  }
}

/** 从实例名猜 MC 版本，只用于写进 README 提示 */
function guessMc(id) {
  const m = String(id).match(/\b(1\.\d+(?:\.\d+)?)\b/);
  return m ? m[1] : '';
}

/**
 * 生成导出计划（不写文件）。
 * @returns {{ id, mc, loader, java, json, items }}
 */
function plan({ gameDir, id, include } = {}) {
  safe.assertVersionId(id);
  const instDir = safe.safeJoin(path.join(gameDir, 'versions'), id);
  const jsonPath = path.join(instDir, `${id}.json`);
  if (!fs.existsSync(jsonPath)) throw new Error(`实例 ${id} 的版本 JSON 不存在`);

  const meta = versionLib.loadVersionJson(gameDir, id);
  const loader = versionLib.loaderOf(id, meta.mainClass);
  const java = (meta.javaVersion && meta.javaVersion.majorVersion) || 8;

  const asked = include && typeof include === 'object' ? include : {};
  const items = [];

  for (const [key, def] of Object.entries(INCLUDES)) {
    const on = Object.prototype.hasOwnProperty.call(asked, key) ? Boolean(asked[key]) : def.def;
    if (def.kind === 'file') {
      const full = path.join(instDir, def.name);
      const exists = fs.existsSync(full);
      let size = 0;
      if (exists) {
        try {
          size = fs.statSync(full).size;
        } catch {
          /* ignore */
        }
      }
      items.push({ key, label: def.label, enabled: on && exists, available: exists, files: exists ? 1 : 0, bytes: size });
      continue;
    }
    const files = [];
    walk(instDir, key, files);
    const bytes = files.reduce((n, f) => n + f.size, 0);
    items.push({
      key,
      label: def.label,
      enabled: on && files.length > 0,
      available: files.length > 0,
      files: files.length,
      bytes,
      list: files,
    });
  }

  // 客户端 jar：整合包/加载器实例一般没有，原版实例有。体积大，默认不带
  const jarPath = path.join(instDir, `${id}.jar`);
  const hasJar = fs.existsSync(jarPath);

  return { id, mc: guessMc(id), loader, java, jsonPath, instDir, meta, hasJar, items };
}

/**
 * 执行导出。
 * @param {object} opts
 * @param {Function} [opts.onProgress] ({ percent, files, total, message })
 * @returns {Promise<{ok:boolean, data?:object, error?:string}>}
 */
async function exportInstance({ gameDir, id, outPath, include, onProgress } = {}) {
  let writer = null;
  try {
    if (!outPath || typeof outPath !== 'string') throw new Error('没有选择保存位置');
    const p = plan({ gameDir, id, include });

    // 目标文件不能落在游戏目录里，否则下次扫描会把半个 zip 当成实例内容
    if (safe.withinDir(gameDir, outPath)) {
      throw new Error('导出文件不能放在游戏目录内，请换一个位置');
    }

    const enabled = p.items.filter((it) => it.enabled);
    const totalFiles = enabled.reduce((n, it) => n + (it.list ? it.list.length : 1), 0) + 2; // + JSON + README
    const totalBytes = enabled.reduce((n, it) => n + it.bytes, 0);
    const root = safe.isSafeSegment(id) ? id : id.replace(/[\\/:*?"<>|]/g, '_');

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    writer = zipper.create(outPath);

    let done = 0;
    const tick = (message) => {
      done++;
      if (onProgress) {
        onProgress({
          percent: Math.min(99, Math.round((done / Math.max(1, totalFiles)) * 100)),
          files: done,
          total: totalFiles,
          bytes: totalBytes,
          message: message || '',
        });
      }
    };

    // 1) 展开后的版本 JSON（自包含，无 inheritsFrom）
    const merged = { ...p.meta, id };
    delete merged.inheritsFrom;
    const jsonTmp = path.join(p.instDir, `.smucl-export-${Date.now()}.json`);
    fs.writeFileSync(jsonTmp, JSON.stringify(merged, null, 2), 'utf8');
    try {
      await writer.addFile(jsonTmp, `${root}/versions/${id}/${id}.json`);
    } finally {
      fs.rmSync(jsonTmp, { force: true });
    }
    tick('版本定义');

    // 2) 说明文件
    const readme = buildReadme({ ...p, enabled });
    const readmeTmp = path.join(p.instDir, `.smucl-readme-${Date.now()}.txt`);
    fs.writeFileSync(readmeTmp, readme, 'utf8');
    try {
      await writer.addFile(readmeTmp, `${root}/README.txt`);
    } finally {
      fs.rmSync(readmeTmp, { force: true });
    }
    tick('说明文件');

    // 3) 勾选的内容
    for (const it of enabled) {
      if (!it.list) {
        const def = INCLUDES[it.key];
        await writer.addFile(path.join(p.instDir, def.name), `${root}/${def.name}`);
        tick(def.label);
        continue;
      }
      for (const f of it.list) {
        await writer.addFile(f.full, `${root}/${f.rel.replace(/\\/g, '/')}`);
        tick(it.label);
      }
    }

    await writer.close();
    writer = null;

    const stat = fs.statSync(outPath);
    return {
      ok: true,
      data: {
        path: outPath,
        bytes: stat.size,
        files: totalFiles,
        id,
        loader: p.loader,
        included: enabled.map((it) => it.label),
        // 非隔离实例的 mods/config 在游戏根目录，这里导不出来，必须告知
        warning: p.meta ? undefined : undefined,
      },
    };
  } catch (e) {
    if (writer) await writer.abort();
    return { ok: false, error: e.message };
  }
}

function buildReadme(p) {
  const lines = [
    `SMUCL 导出整合包`,
    ``,
    `实例名   ${p.id}`,
    p.mc ? `游戏版本  ${p.mc}` : '',
    `加载器   ${p.loader}`,
    `需要 Java  ${p.java} 或更高`,
    ``,
    `包含内容  ${p.items.filter((i) => i.enabled).map((i) => i.label).join('、') || '（仅版本定义）'}`,
    ``,
    `导入方式`,
    `  · SMUCL：左侧「版本管理」→「导入整合包」→ 选择本压缩包`,
    `  · PCL / HMCL：把压缩包拖进启动器，或解压后把 versions 里的文件夹放进 .minecraft/versions`,
    ``,
    `注意`,
    `  · 本包不含客户端 jar 与公共库（libraries），首次启动时启动器会自动补齐`,
    `  · 若提示缺少依赖库，用 PCL 打开一次该实例即可自动下载`,
    `  · 需要联网，且本机已安装 Java ${p.java}`,
    ``,
    `由 SMUCL 导出 · https://github.com/Survaetr/SMUCL`,
  ];
  return lines.filter((l) => l).join('\r\n');
}

module.exports = { INCLUDES, plan, exportInstance };
