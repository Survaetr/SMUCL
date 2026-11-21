'use strict';
/**
 * Java 运行时按需获取。
 *
 * core/java.js 只负责「在本机找 Java」，找不到就返回空；全新机器上这会导致
 * 加载器安装器、整合包安装、游戏启动全部无从下手。这个模块负责「补齐」：
 * 按目标主版本下载一份 Temurin JRE，解压到 {mcDir}/runtime/jre-{major}，
 * 下次 java.detect() 会通过 fromMojangRuntime 自动把它收进候选列表。
 *
 * 源优先级：清华 TUNA 镜像（国内直连稳定）→ Adoptium 官方 API（重定向到 GitHub）。
 * 完整性不依赖单一来源：zip 头 + 体积下限 + 解压后实际执行 java -version 校验主版本。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const net = require('./net');
const javaLib = require('./java');

const IS_WIN = process.platform === 'win32';
const TUNA_ROOT = 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium';
const ADOPT_API = 'https://api.adoptium.net/v3/binary/latest';
/** Temurin JRE 压缩包最小也在 35 MB 以上，低于这个数多半是错误页或被截断 */
const MIN_ZIP = 20 * 1024 * 1024;

/** 实际提供的运行时只有三个长期支持版本，其余需求向上取整 */
function normalizeMajor(required) {
  const m = Number(required);
  if (!Number.isFinite(m) || m <= 0) return 21;
  if (m <= 8) return 8;
  if (m <= 20) return 17;
  return 21;
}

function existsFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function listDir(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

function runtimeRoot(mcDir) {
  return path.join(mcDir, 'runtime');
}

function targetDir(mcDir, major) {
  return path.join(runtimeRoot(mcDir), `jre-${major}`);
}

/** 在一个目录（含一层子目录）里找 java 可执行文件 */
function findJava(dir) {
  const names = IS_WIN ? ['java.exe', 'javaw.exe'] : ['java'];
  const direct = path.join(dir, 'bin', names[0]);
  if (existsFile(direct)) return direct;
  for (const ent of listDir(dir)) {
    if (!ent.isDirectory()) continue;
    const p = path.join(dir, ent.name, 'bin', names[0]);
    if (existsFile(p)) return p;
  }
  return '';
}

function pairOf(javaExe) {
  const dir = path.dirname(javaExe);
  const javaw = path.join(dir, IS_WIN ? 'javaw.exe' : 'java');
  return { java: javaExe, javaw: existsFile(javaw) ? javaw : javaExe, dir };
}

/** 手写递归删除：本机 Electron 运行时上 fs.rmSync 会触发批量删除保护 */
function removeTree(p) {
  let ents = [];
  try {
    ents = fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of ents) {
    const full = path.join(p, ent.name);
    if (ent.isDirectory()) removeTree(full);
    else {
      try {
        fs.unlinkSync(full);
      } catch {
        /* 只读文件先去掉只读位再删一次 */
        try {
          fs.chmodSync(full, 0o666);
          fs.unlinkSync(full);
        } catch {}
      }
    }
  }
  try {
    fs.rmdirSync(p);
  } catch {}
}

/** 版本号片段解析，用于在同一主版本内挑最新构建 */
function buildKey(name) {
  const m = String(name).match(/hotspot_([0-9a-z._]+)\.zip$/i);
  if (!m) return [];
  return (m[1].match(/\d+/g) || []).map(Number);
}

function compareKey(a, b) {
  const ka = buildKey(a);
  const kb = buildKey(b);
  const n = Math.max(ka.length, kb.length);
  for (let i = 0; i < n; i++) {
    const x = ka[i] || 0;
    const y = kb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** 列出可用的下载源，清华在前、官方在后 */
async function candidates(major) {
  const out = [];

  try {
    const dirUrl = `${TUNA_ROOT}/${major}/jre/x64/windows/`;
    const html = await net.fetchJson(dirUrl, { raw: true, timeout: 20000, retries: 1 });
    const re = new RegExp(`OpenJDK${major}U-jre_x64_windows_hotspot_[0-9a-z._]+\\.zip`, 'gi');
    const names = [...new Set(html.match(re) || [])].sort(compareKey).reverse();
    for (const name of names.slice(0, 2)) {
      out.push({ url: dirUrl + name, name, source: '清华镜像' });
    }
  } catch {
    /* 镜像不可达就走官方 */
  }

  out.push({
    url: `${ADOPT_API}/${major}/ga/windows/x64/jre/hotspot/normal/eclipse`,
    name: `Temurin ${major} 最新版`,
    source: 'Adoptium 官方',
  });

  return out;
}

/** 解压并挡住目录穿越 */
function extractZip(zipPath, dest, onEntry) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const root = path.resolve(dest);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const out = path.resolve(root, entry.entryName);
    if (out !== root && !out.startsWith(root + path.sep)) {
      throw new Error('压缩包内含有越界路径，已中止');
    }
    if (entry.isDirectory) {
      fs.mkdirSync(out, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, entry.getData());
    }
    if (onEntry) onEntry(i + 1, entries.length);
  }
  return entries.length;
}

/**
 * 确保 {mcDir}/runtime 下有一份可用的 Java。
 * @param {object} opts
 * @param {string} opts.mcDir 游戏根目录
 * @param {number} opts.major 目标主版本（内部会归一到 8/17/21）
 * @param {boolean} [opts.force] 已存在也重新下载
 * @param {(p:object)=>void} [opts.onProgress]
 * @returns {Promise<{java:string,javaw:string,dir:string,major:number,version:string,source:string}>}
 */
async function ensure({ mcDir, major, force = false, onProgress } = {}) {
  if (!IS_WIN) throw new Error('自动获取 Java 目前只支持 Windows');
  if (!mcDir) throw new Error('缺少游戏目录');

  const want = normalizeMajor(major);
  const report = (p) => {
    if (onProgress) onProgress(p);
  };
  const dir = targetDir(mcDir, want);

  if (!force) {
    const hit = findJava(dir);
    if (hit) {
      const probe = await javaLib.runJavaVersion(hit);
      if (probe && probe.major === want) {
        report({ stage: 'done', message: `已有 Java ${want}`, reused: true });
        return {
          ...pairOf(hit),
          dir,
          bin: path.dirname(hit),
          major: probe.major,
          version: probe.version,
          source: '已有运行时',
        };
      }
      removeTree(dir);
    }
  }

  const list = await candidates(want);
  if (!list.length) throw new Error('无法获取 Java 下载地址');

  const tmpZip = path.join(os.tmpdir(), `smucl-jre-${want}-${Date.now()}.zip`);
  let picked = null;
  let lastErr = null;

  for (const c of list) {
    try {
      let received = 0;
      report({ stage: 'download', message: `从${c.source}下载 Java ${want}`, bytes: 0, name: c.name });
      await net.download(c.url, tmpZip, {
        expectZip: true,
        minBytes: MIN_ZIP,
        timeout: 60000,
        onBytes: (n) => {
          received += n;
          report({ stage: 'download', message: `从${c.source}下载 Java ${want}`, bytes: received });
        },
      });
      picked = { ...c, bytes: received };
      break;
    } catch (e) {
      lastErr = e;
      report({ stage: 'download', message: `${c.source}不可用，换下一个源` });
    }
  }

  if (!picked) {
    throw new Error(`Java ${want} 下载失败 — ${(lastErr && lastErr.message) || '未知错误'}`);
  }

  const staging = path.join(runtimeRoot(mcDir), `.staging-${want}-${Date.now()}`);
  try {
    await fsp.mkdir(staging, { recursive: true });
    report({ stage: 'extract', message: '解压运行时', percent: 0 });
    const total = extractZip(tmpZip, staging, (done, all) => {
      if (done % 20 === 0 || done === all) {
        report({ stage: 'extract', message: '解压运行时', percent: Math.round((done / all) * 100) });
      }
    });
    if (!total) throw new Error('压缩包是空的');

    const inner = findJava(staging);
    if (!inner) throw new Error('解压后没有找到 java 可执行文件');

    // Temurin 的包有一层根目录（jdk-21.0.x-jre），把它整体挪成 jre-{major}
    const jdkRoot = path.dirname(path.dirname(inner));
    removeTree(dir);
    await fsp.mkdir(path.dirname(dir), { recursive: true });
    await fsp.rename(jdkRoot, dir);
  } finally {
    try {
      await fsp.unlink(tmpZip);
    } catch {}
    removeTree(staging);
  }

  const java = findJava(dir);
  if (!java) throw new Error('运行时安装后仍找不到 java，已回滚');

  const probe = await javaLib.runJavaVersion(java);
  if (!probe || probe.major !== want) {
    removeTree(dir);
    throw new Error(
      `下载到的运行时版本不符（期望 Java ${want}，实际 ${probe ? probe.major : '无法执行'}）`
    );
  }

  try {
    fs.writeFileSync(
      path.join(dir, '.smucl-jre.json'),
      JSON.stringify(
        { major: want, version: probe.version, source: picked.source, name: picked.name, at: new Date().toISOString() },
        null,
        2
      )
    );
  } catch {
    /* 标记文件只是方便排查，写不进去不影响使用 */
  }

  report({ stage: 'done', message: `Java ${want} 已就绪`, major: want, version: probe.version });
  return {
    ...pairOf(java),
    dir,
    bin: path.dirname(java),
    major: probe.major,
    version: probe.version,
    source: picked.source,
  };
}

module.exports = { ensure, normalizeMajor, findJava, targetDir, removeTree };
