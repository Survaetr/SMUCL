'use strict';
/**
 * Java 运行时探测。
 * 优先级：用户手动指定 > JAVA_HOME > PATH > 常见安装目录 > 官方启动器内置运行时。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';

function runJavaVersion(javaExe) {
  return new Promise((resolve) => {
    execFile(
      javaExe,
      ['-version'],
      { timeout: 4000, windowsHide: true },
      (err, stdout, stderr) => {
        const text = `${stderr || ''}${stdout || ''}`;
        if (!text) return resolve(null);
        const m = text.match(/version "([^"]+)"/);
        if (!m) return resolve(null);
        const raw = m[1];
        let major;
        if (raw.startsWith('1.')) major = parseInt(raw.split('.')[1], 10);
        else major = parseInt(raw.split('.')[0], 10);
        const bits = /64-Bit/i.test(text) ? 64 : /32-Bit/i.test(text) ? 32 : 0;
        const vendorMatch = text.match(/^(openjdk|java)\s+version/i);
        resolve({
          version: raw,
          major: Number.isFinite(major) ? major : 0,
          bits,
          vendor: /OpenJDK/i.test(text) ? 'OpenJDK' : vendorMatch ? 'Oracle' : 'Java',
        });
      }
    );
  });
}

function exists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 把一个 java.exe / javaw.exe 路径规范成 {java, javaw} */
function pairOf(exePath) {
  const dir = path.dirname(exePath);
  const java = path.join(dir, IS_WIN ? 'java.exe' : 'java');
  const javaw = path.join(dir, IS_WIN ? 'javaw.exe' : 'java');
  if (!exists(java)) return null;
  return { java, javaw: exists(javaw) ? javaw : java, dir };
}

function listDir(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

function candidateDirs() {
  const dirs = [];
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const vendors = [
    'Java',
    'Eclipse Adoptium',
    'Eclipse Foundation',
    'AdoptOpenJDK',
    'Zulu',
    'Microsoft',
    'BellSoft',
    'Amazon Corretto',
    'Semeru',
    'JetBrains',
  ];
  for (const base of [pf, pf86, localApp]) {
    for (const v of vendors) dirs.push(path.join(base, v));
    dirs.push(path.join(base, 'Programs', 'Eclipse Adoptium'));
  }
  return dirs;
}

function scanJavaIn(root, depth = 2, acc = []) {
  if (depth < 0) return acc;
  for (const ent of listDir(root)) {
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) {
      const bin = path.join(full, 'bin');
      for (const name of ['javaw.exe', 'java.exe']) {
        const exe = path.join(bin, name);
        if (exists(exe)) {
          acc.push(exe);
          break;
        }
      }
      if (depth > 0) scanJavaIn(full, depth - 1, acc);
    }
  }
  return acc;
}

function fromPath() {
  const out = [];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const exe = path.join(dir, IS_WIN ? 'javaw.exe' : 'java');
    if (exists(exe)) out.push(exe);
  }
  return out;
}

function fromMojangRuntime(mcDir) {
  const roots = [
    path.join(mcDir, 'runtime'),
    path.join(process.env.LOCALAPPDATA || '', 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Local', 'runtime'),
  ];
  const out = [];
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    for (const ent of listDir(root)) {
      if (!ent.isDirectory()) continue;
      const children = listDir(path.join(root, ent.name));
      for (const c of children) {
        const bin = path.join(root, ent.name, c.name, 'bin');
        for (const name of ['javaw.exe', 'java.exe']) {
          const exe = path.join(bin, name);
          if (exists(exe)) {
            out.push(exe);
            break;
          }
        }
      }
      // 某些 runtime 结构是 runtime/<name>/bin/java.exe
      const flat = path.join(root, ent.name, 'bin');
      for (const name of ['javaw.exe', 'java.exe']) {
        const exe = path.join(flat, name);
        if (exists(exe)) {
          out.push(exe);
          break;
        }
      }
    }
  }
  return out;
}

/**
 * @returns {Promise<Array<{path:string, java:string, version:string, major:number, bits:number, source:string}>>}
 */
async function detect({ mcDir, mcDirs, preferred } = {}) {
  const raw = [];
  const push = (p, source) => {
    if (p && exists(p)) raw.push({ exe: p, source });
  };

  if (preferred) push(preferred, '手动指定');
  if (process.env.JAVA_HOME) {
    push(path.join(process.env.JAVA_HOME, 'bin', IS_WIN ? 'javaw.exe' : 'java'), 'JAVA_HOME');
  }
  fromPath().forEach((p) => push(p, 'PATH'));
  for (const dir of candidateDirs()) {
    for (const p of scanJavaIn(dir, 2)) push(p, '安装目录');
  }

  // 各游戏目录自带的运行时（官方启动器与 PCL 可能各有一份）
  const roots = Array.isArray(mcDirs) && mcDirs.length ? mcDirs : mcDir ? [mcDir] : [];
  for (const r of roots) fromMojangRuntime(r).forEach((p) => push(p, '游戏内置'));

  // 去重后再并发探测，避免几十个候选串行等待
  const seen = new Set();
  const unique = [];
  for (const item of raw) {
    const pair = pairOf(item.exe);
    if (!pair) continue;
    const key = pair.java.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ ...item, pair });
  }

  const results = [];
  const queue = unique.slice();
  const runner = async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const info = await runJavaVersion(item.pair.java);
      if (!info) continue; // 无法执行的文件直接丢弃
      results.push({
        path: item.pair.javaw,
        java: item.pair.java,
        source: item.source,
        version: info.version,
        major: info.major,
        bits: info.bits,
        vendor: info.vendor,
      });
    }
  };
  await Promise.all(new Array(Math.min(6, queue.length)).fill(0).map(runner));

  results.sort((a, b) => b.major - a.major);
  return results;
}

/** 为指定游戏版本挑选合适的 Java：优先满足 major 要求的最小版本 */
/**
 * 允许比要求高出的最大版本跨度。
 * 跨 1~2 个版本通常无碍（21 → 22/23），再多就不安全：
 * mod 加载器内置的 ASM 对 class file 版本有上限，
 * 用 Java 25（class file 69）去跑面向 Java 21 的 NeoForge，
 * 会直接崩在 BootstrapLauncher 且不产生任何游戏日志。
 */
const MAX_AHEAD = 2;

function pick(results, requiredMajor) {
  if (!results.length) return null;
  if (!requiredMajor) return results[0];

  const exact = results.filter((j) => j.major === requiredMajor);
  if (exact.length) return exact[0];

  const near = results
    .filter((j) => j.major > requiredMajor && j.major <= requiredMajor + MAX_AHEAD)
    .sort((a, b) => a.major - b.major);
  if (near.length) return near[0];

  // 找不到合适的就明确失败：拿不兼容的版本硬跑只会得到一个没有日志的闪退
  return null;
}

module.exports = { detect, pick, runJavaVersion };
