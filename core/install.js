'use strict';
/**
 * 版本安装：客户端 jar、依赖库、资源索引与素材、natives 解压。
 * 全部按“已存在即跳过”做增量，可安全重复调用。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const AdmZip = require('adm-zip');

const net = require('./net');
const mirror = require('./mirror');
const versionLib = require('./version');
const rules = require('./rules');
const safe = require('./safe');

const OS_NAME = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
const OS_ARCH = process.arch === 'x64' ? '64' : process.arch === 'arm64' ? '64' : '32';

function mavenPath(name) {
  const parts = String(name).split(':');
  const [group, artifact, version, classifier] = parts;
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`;
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`;
}

/** 判断某个库在当前平台是否生效 */
function libAllowed(lib) {
  if (!rules.allowed(lib.rules, {})) return false;
  if (lib.downloads && !lib.downloads.artifact && !lib.downloads.classifiers && !lib.name.includes('natives')) {
    // 只有 classifiers 的库也允许，交给后面处理
  }
  return true;
}

function nativeClassifier(lib) {
  if (!lib.natives || !lib.natives[OS_NAME]) return null;
  return String(lib.natives[OS_NAME]).replace('${arch}', OS_ARCH);
}

/**
 * 汇总需要下载的文件
 * 元数据里的 artifact.path / classifiers[].path 是远端可控的字符串，
 * 一律按「相对路径」处理并校验必须落在 libraries/ 或 versions/ 内，
 * 否则一个 ../../.. 就能把文件写到任意位置。
 */
function collectTasks(meta, mcDir, versionDir, source) {
  const tasks = [];
  const libraries = (meta.libraries || []).filter(libAllowed);
  const libRoot = path.join(mcDir, 'libraries');

  for (const lib of libraries) {
    const art = lib.downloads && lib.downloads.artifact;
    const rel = art && art.path ? art.path : mavenPath(lib.name);
    const url = art && art.url ? art.url : `${lib.url || 'https://libraries.minecraft.net/'}${rel}`;
    const size = (art && art.size) || 0;
    const sha1 = (art && art.sha1) || '';

    if (art) {
      tasks.push({
        url,
        dest: safe.safeJoin(libRoot, rel),
        size,
        sha1,
        kind: 'library',
        name: lib.name,
      });
    } else if (!lib.downloads) {
      // 极老版本的库只有 url 字段（1.5 及以前）
      tasks.push({
        url,
        dest: safe.safeJoin(libRoot, rel),
        size: 0,
        sha1: '',
        kind: 'library',
        name: lib.name,
      });
    }
    // 只有 classifiers 的库（纯 natives）不需要主 jar

    // natives 分类器
    const classifier = nativeClassifier(lib);
    if (classifier && lib.downloads && lib.downloads.classifiers && lib.downloads.classifiers[classifier]) {
      const c = lib.downloads.classifiers[classifier];
      tasks.push({
        url: c.url,
        dest: safe.safeJoin(libRoot, c.path || mavenPath(`${lib.name}:${classifier}`)),
        size: c.size || 0,
        sha1: c.sha1 || '',
        kind: 'native',
        name: lib.name,
        exclude: (lib.extract && lib.extract.exclude) || ['META-INF/'],
        nativeDir: path.join(versionDir, 'natives'),
      });
    }
  }

  return tasks;
}

function isExcluded(entryName, exclude) {
  return (exclude || []).some((prefix) => entryName.startsWith(prefix));
}

/** 主源失败时自动换另一个源重试，单文件级别容错 */
async function downloadWithFallback(rawUrl, dest, opts, source) {
  const alt = source === 'bmcl' ? 'mojang' : 'bmcl';
  try {
    return await net.download(mirror.rewrite(rawUrl, source), dest, opts);
  } catch (e) {
    return await net.download(mirror.rewrite(rawUrl, alt), dest, opts);
  }
}

async function extractNatives(tasks, log) {
  const unzipped = new Set();
  for (const t of tasks) {
    if (t.kind !== 'native' || unzipped.has(t.dest)) continue;
    unzipped.add(t.dest);
    try {
      const zip = new AdmZip(t.dest);
      const outDir = t.nativeDir;
      await fsp.mkdir(outDir, { recursive: true });
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        if (isExcluded(entry.entryName, t.exclude)) continue;
        const baseName = path.basename(entry.entryName);
        if (!baseName) continue;
        await fsp.writeFile(path.join(outDir, baseName), entry.getData());
      }
    } catch (e) {
      log(`natives 解压失败：${path.basename(t.dest)} — ${e.message}`);
    }
  }
}

/**
 * 安装一个版本
 * @param {string} id 版本号
 * @param {object} entry manifest 条目（含 url）
 * @param {string} source 'bmcl' | 'mojang'
 * @param {(p:object)=>void} onProgress
 * @returns {Promise<{ok:boolean, id:string, files:number, bytes:number, seconds:number, warnings:string[]}>}
 */
async function install(id, entry, source, onProgress) {
  // 版本名来自界面，必须先确认是单段名字，否则 versions/<id> 可以穿到任意目录
  safe.assertVersionId(id);
  const started = Date.now();
  const settings = require('./settings');
  const mcDir = settings.ensureGameDir();
  const versionDir = safe.safeJoin(path.join(mcDir, 'versions'), id);
  await fsp.mkdir(versionDir, { recursive: true });

  const report = (patch) => onProgress && onProgress({ id, ...patch });
  const warnings = [];
  const log = (msg) => {
    warnings.push(msg);
    report({ stage: 'warn', message: msg });
  };

  const features = {};
  report({ stage: 'meta', message: '读取版本信息', percent: 2 });

  const meta = await versionLib.getVersionMeta(entry, source);
  meta.id = id;
  await fsp.writeFile(path.join(versionDir, `${id}.json`), JSON.stringify(meta, null, 2), 'utf8');

  // ---------- 收集任务 ----------
  const tasks = [];

  // 客户端 jar
  if (meta.downloads && meta.downloads.client && meta.downloads.client.url) {
    const c = meta.downloads.client;
    tasks.push({
      url: c.url,
      dest: path.join(versionDir, `${id}.jar`),
      size: c.size || 0,
      sha1: c.sha1 || '',
      kind: 'client',
      name: 'client.jar',
    });
  } else {
    log('该版本未提供 client.jar 下载地址，可能依赖加载器额外安装');
  }

  tasks.push(...collectTasks(meta, mcDir, versionDir, source));

  // 资源索引（id 会参与文件名，必须限定为安全单段）
  let assetIndex = meta.assetIndex;
  let assetsName = (assetIndex && assetIndex.id) || meta.assets || 'legacy';
  try {
    safe.assertVersionId(String(assetsName), '资源索引名');
  } catch {
    log('资源索引名非法，已回退到 legacy');
    assetsName = 'legacy';
  }
  const indexPath = safe.safeJoin(path.join(mcDir, 'assets', 'indexes'), `${assetsName}.json`);
  let indexJson = null;

  if (assetIndex && assetIndex.url) {
    await downloadWithFallback(
      assetIndex.url,
      indexPath,
      { expectedSize: assetIndex.size || 0, expectedSha1: assetIndex.sha1 || '' },
      source
    );
    indexJson = versionLib.readJson(indexPath);
  } else if (fs.existsSync(indexPath)) {
    indexJson = versionLib.readJson(indexPath);
  }

  const assetTasks = [];
  if (indexJson && indexJson.objects) {
    const seen = new Set();
    const objectsRoot = path.join(mcDir, 'assets', 'objects');
    for (const [name, obj] of Object.entries(indexJson.objects)) {
      if (!obj || !obj.hash || seen.has(obj.hash)) continue;
      // 资源哈希是文件名，必须严格是 40 位十六进制，否则可以借它做路径穿越
      if (!/^[0-9a-f]{40}$/i.test(String(obj.hash))) continue;
      seen.add(obj.hash);
      const hash = String(obj.hash).toLowerCase();
      assetTasks.push({
        url: `https://resources.download.minecraft.net/${hash.slice(0, 2)}/${hash}`,
        dest: safe.safeJoin(objectsRoot, hash.slice(0, 2), hash),
        size: obj.size || 0,
        sha1: hash,
        kind: 'asset',
        name,
      });
    }
  } else {
    log('未获取到资源索引，游戏可能缺少音效与语言文件');
  }

  tasks.push(...assetTasks);

  // 日志配置（log4j）
  const loggingFile = meta.logging && meta.logging.client && meta.logging.client.file;
  if (loggingFile && loggingFile.url) {
    let logName = 'client.xml';
    try {
      const candidate = String(loggingFile.id || 'client.xml');
      // 只允许单段文件名，防止 ../../ 把配置写出 assets/
      if (safe.safeEntryName(candidate) === candidate && !candidate.includes('/')) logName = candidate;
    } catch {
      logName = 'client.xml';
    }
    tasks.push({
      url: loggingFile.url,
      dest: safe.safeJoin(path.join(mcDir, 'assets', 'log_configs'), logName),
      size: loggingFile.size || 0,
      sha1: loggingFile.sha1 || '',
      kind: 'logconfig',
      name: 'log4j config',
    });
  }

  // ---------- 执行下载 ----------
  const total = tasks.length;
  const totalBytes = tasks.reduce((s, t) => s + (t.size || 0), 0);
  let done = 0;
  let bytes = 0;
  let lastEmit = 0;
  const threads = Math.max(1, Math.min(16, settings.all().downloadThreads || 8));

  const emit = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 180) return;
    lastEmit = now;
    const percent = totalBytes > 0 ? Math.min(99, Math.round((bytes / totalBytes) * 96) + 2) : Math.round((done / Math.max(1, total)) * 96) + 2;
    report({
      stage: 'download',
      message: `下载中 ${done}/${total}`,
      done,
      total,
      bytes,
      totalBytes,
      percent,
    });
  };

  emit(true);
  await net.pool(tasks, threads, async (t) => {
    try {
      await downloadWithFallback(
        t.url,
        t.dest,
        {
          expectedSize: t.size,
          expectedSha1: t.sha1 || '',
          // 早期版本的库没有 sha1，至少确认下下来的是个能打开的压缩包
          expectZip: /\.(jar|zip)$/i.test(t.dest),
          retries: 1,
          onBytes: (n) => {
            bytes += n;
            emit();
          },
        },
        source
      );
    } catch (e) {
      log(`${t.kind === 'asset' ? '资源' : '文件'}下载失败：${t.name || path.basename(t.dest)} — ${e.message}`);
    }
    done += 1;
    emit();
  });

  // ---------- natives 解压 ----------
  report({ stage: 'natives', message: '解压本地库', percent: 97 });
  await extractNatives(tasks, log);

  // ---------- 虚拟资源（1.7 及更早） ----------
  // pre-1.6 的索引没有 virtual 字段，但游戏确实从 resources/ 读取，需按约定补上
  const isPre16 = assetsName === 'pre-1.6';
  if (indexJson && (indexJson.virtual || indexJson.map_to_resources || isPre16) && indexJson.objects) {
    report({ stage: 'assets', message: '整理旧版资源目录', percent: 98 });
    const targetRoot =
      indexJson.map_to_resources || isPre16
        ? path.join(mcDir, 'resources')
        : path.join(mcDir, 'assets', 'virtual', assetsName);
    for (const [name, obj] of Object.entries(indexJson.objects)) {
      const src = path.join(mcDir, 'assets', 'objects', obj.hash.slice(0, 2), obj.hash);
      let dst;
      try {
        // 索引里的资源名同样是外部数据，1.7 以前会按原名铺到 resources/
        dst = safe.safeJoin(targetRoot, name);
      } catch {
        continue;
      }
      try {
        if (!fs.existsSync(dst)) {
          await fsp.mkdir(path.dirname(dst), { recursive: true });
          await fsp.copyFile(src, dst);
        }
      } catch {
        /* 单文件失败不阻断安装 */
      }
    }
  }

  // ---------- 安装后完整性校验 ----------
  // 下载失败以前只记一条 warning 就报「安装完成」，用户点启动才发现跑不起来
  // （典型症状：十秒后进程退出、日志里全是看不懂的 Java 报错）。
  // 这里按版本 JSON 再核对一遍，缺的当场补，补不齐就明确失败。
  try {
    const repair = require('./repair');
    report({ stage: 'verify', message: '校验文件完整性', percent: 99 });
    const before = repair.check(mcDir, id);
    if (before.missing.length) {
      log(`有 ${before.missing.length} 个文件没下完整，正在补全…`);
      const r = await repair.fix(mcDir, id, (p) =>
        report({ stage: 'verify', message: `补全文件 ${p.done}/${p.total}`, percent: 99 })
      );
      if (r.remaining.length) {
        const sample = r.remaining.slice(0, 3).map((x) => x.name).join('、');
        return {
          ok: false,
          id,
          files: total,
          bytes,
          seconds: Math.round((Date.now() - started) / 1000),
          warnings,
          error: `还有 ${r.remaining.length} 个文件没补齐（例如 ${sample}），安装不完整。请把「下载源」换成另一个后重试。`,
        };
      }
    }
  } catch (e) {
    log(`完整性校验没跑通：${e.message}`);
  }

  report({ stage: 'done', message: '安装完成', percent: 100, done: total, total });

  return {
    ok: true,
    id,
    files: total,
    bytes,
    seconds: Math.round((Date.now() - started) / 1000),
    warnings,
  };
}

module.exports = { install, mavenPath, OS_NAME, collectTasks, extractNatives };
