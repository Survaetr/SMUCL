'use strict';
/**
 * 版本元数据：远端清单、本地已安装版本扫描、版本 JSON 读取。
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { fetchJson } = require('./net');
const mirror = require('./mirror');
const safe = require('./safe');

let manifestCache = { source: null, time: 0, data: null };
const TTL = 10 * 60 * 1000;

function manifestCachePath() {
  return path.join(app.getPath('userData'), 'version_manifest_cache.json');
}

async function getManifest(source = 'bmcl', { force = false } = {}) {
  const now = Date.now();
  if (!force && manifestCache.data && manifestCache.source === source && now - manifestCache.time < TTL) {
    return manifestCache.data;
  }

  // 磁盘缓存兜底：断网时仍能展示上次拉到的列表
  const disk = readDiskCache();
  if (!force && disk && disk.source === source && now - disk.time < 6 * 60 * 60 * 1000) {
    manifestCache = { source, time: disk.time, data: disk.data };
    return disk.data;
  }

  const order = source === 'mojang' ? ['mojang', 'bmcl'] : ['bmcl', 'mojang'];
  let lastErr;
  for (const src of order) {
    try {
      const data = await fetchJson(mirror.MANIFEST[src], { retries: 0, timeout: 9000 });
      if (!data || !Array.isArray(data.versions)) throw new Error('返回结构异常');
      manifestCache = { source: src, time: now, data, requested: source };
      data.__source = src;
      writeDiskCache({ source: src, time: now, data });
      return data;
    } catch (e) {
      lastErr = e;
    }
  }

  if (disk && disk.data) {
    manifestCache = { source: disk.source, time: disk.time, data: disk.data };
    disk.data.__source = disk.source;
    return disk.data;
  }
  throw lastErr || new Error('版本列表获取失败');
}

function readDiskCache() {
  try {
    const p = manifestCachePath();
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeDiskCache(payload) {
  try {
    fs.writeFileSync(manifestCachePath(), JSON.stringify(payload), 'utf8');
  } catch {
    /* 缓存失败不影响主流程 */
  }
}

/** 取单个版本的元数据（含下载地址） */
async function getVersionMeta(entry, source) {
  if (entry && entry.json && entry.json.libraries) return entry.json; // 本地已有
  const url = mirror.rewrite(entry.url, source);
  const json = await fetchJson(url, { timeout: 30000, retries: 2 });
  entry.json = json;
  return json;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 判断加载器类型，用于 UI 上的标签 */
function loaderOf(id = '', mainClass = '') {
  const s = `${id} ${mainClass}`.toLowerCase();
  // neoforge 必须在 forge 之前判断，且 BootstrapLauncher 是 NeoForge 的启动入口
  if (s.includes('neoforge') || s.includes('neoforged') || s.includes('bootstraplauncher')) return 'NeoForge';
  if (s.includes('fabric')) return 'Fabric';
  if (s.includes('quilt')) return 'Quilt';
  if (s.includes('optifine')) return 'OptiFine';
  if (s.includes('liteloader')) return 'LiteLoader';
  if (s.includes('forge') || s.includes('launchwrapper') || s.includes('fml')) return 'Forge';
  return '原版';
}

function countEntries(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => !n.endsWith('.disabled')).length;
  } catch {
    return 0;
  }
}

/**
 * 扫描多个游戏目录下的实例
 * @param {Array<{path:string,name:string,kind:string}>} gameDirs
 */
/**
 * 推断实例对应的原版版本。
 *
 * 优先级很关键：PCL 生成的整合包 JSON 会把公共库内联，里面没有
 * `net.neoforged:neoforge:X` 这种主坐标，只能靠启动参数。
 * 而 `--fml.mcVersion` 是 Forge / NeoForge 启动器的必传项，值是写死的实际版本。
 *
 * 顺序：--fml.mcVersion → 加载器主库坐标 → 实例名里的版本号（Fabric 靠这个）
 */
function guessMcVersion(id, json) {
  const args = (json && json.arguments && json.arguments.game) || [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--fml.mcVersion' && typeof args[i + 1] === 'string' && /^[\d.]{2,10}$/.test(args[i + 1])) {
      return args[i + 1];
    }
  }

  const names = ((json && json.libraries) || []).map((l) => String((l && l.name) || ''));
  for (const n of names) {
    const neo = n.match(/^net\.neoforged:neoforge:([\d.]+)/);
    if (neo) {
      const [a, b] = neo[1].split('.');
      if (a && b) return Number(a) >= 26 ? `${a}.${b}` : `1.${a}.${b}`;
    }
    const forge = n.match(/^net\.minecraftforge:forge:(1\.[\d.]+)-/);
    if (forge) return forge[1];
  }

  // Fabric / Quilt 实例名一般形如 fabric-loader-0.20.1-1.21.1
  const m = String(id || '').match(/\b(1\.\d{1,2}(?:\.\d{1,2})?)\b/);
  return m ? m[1] : '';
}

function listInstalled(gameDirs) {
  const dirs = Array.isArray(gameDirs)
    ? gameDirs
    : [{ path: gameDirs, name: '主目录', kind: 'primary' }];

  const out = [];
  const seen = new Set();
  const dirsLib = require('./dirs');

  for (const d of dirs) {
    const root = path.join(d.path, 'versions');
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const id = ent.name;
      const instDir = path.join(root, id);
      const jsonPath = path.join(instDir, `${id}.json`);
      if (!fs.existsSync(jsonPath)) continue;
      const json = readJson(jsonPath);
      if (!json) continue;

      const key = `${d.path}|${id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      let updatedAt = Date.now();
      try {
        updatedAt = fs.statSync(jsonPath).mtimeMs;
      } catch {}

      out.push({
        id,
        dir: d.path,
        dirName: d.name,
        kind: d.kind,
        type: json.type || 'release',
        mainClass: json.mainClass || '',
        javaMajor: (json.javaVersion && json.javaVersion.majorVersion) || 8,
        mcVersion: guessMcVersion(id, json) || guessMcVersion(json.inheritsFrom, null),
        inheritsFrom: json.inheritsFrom || '',
        loader: loaderOf(id, json.mainClass),
        hasJar: fs.existsSync(path.join(instDir, `${id}.jar`)),
        isolated: dirsLib.isIsolatedInstance(instDir),
        mods: countEntries(path.join(instDir, 'mods')),
        size: null, // 体积由后台异步补齐，避免扫描时阻塞
        updatedAt,
      });
    }
  }

  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

function dirSize(dir) {
  let total = 0;
  const walk = (p, depth) => {
    if (depth > 4) return;
    let entries = [];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(p, e.name);
      try {
        if (e.isDirectory()) walk(full, depth + 1);
        else total += fs.statSync(full).size;
      } catch {}
    }
  };
  walk(dir, 0);
  return total;
}

/** 读取本地版本 JSON，并沿 inheritsFrom 链合并（简化版继承处理） */
function loadVersionJson(mcDir, id, depth = 0) {
  if (depth > 5) throw new Error('版本继承层级过深');
  // id 与 inheritsFrom 都会参与路径拼接，必须是单段版本名
  safe.assertVersionId(id);
  const file = safe.safeJoin(path.join(mcDir, 'versions'), id, `${id}.json`);
  const json = readJson(file);
  if (!json) throw new Error(`未找到版本 ${id} 的 JSON，可能尚未安装`);
  if (!json.inheritsFrom) return { ...json, id };
  const parent = loadVersionJson(mcDir, json.inheritsFrom, depth + 1);
  return mergeVersion(parent, { ...json, id });
}

/**
 * Maven 坐标的匹配键：group:artifact[:classifier]
 * 官方启动器按这个维度判定"同一个库"，不比较版本号 —— 子版本声明的版本优先。
 * 缺了这层去重，三层继承（整合包 → 加载器 → 原版）会把同一个 jar 塞进 classpath 两次，
 * BootStrapLauncher 用 Collectors.toMap 建索引时直接抛 Duplicate key。
 */
function libraryKey(lib) {
  const name = String((lib && lib.name) || '');
  const parts = name.split(':');
  if (parts.length < 2) return name;
  const classifier = parts[3] || '';
  return `${parts[0]}:${parts[1]}${classifier ? ':' + classifier : ''}`;
}

function mergeLibraries(parent = [], child = []) {
  const order = new Map();
  let seq = 0;
  for (const lib of parent) {
    const k = libraryKey(lib);
    if (!order.has(k)) order.set(k, { lib, seq: seq++ });
  }
  for (const lib of child) {
    const k = libraryKey(lib);
    const prev = order.get(k);
    // 同坐标：保留父版本的位置，值被子版本覆盖
    order.set(k, { lib, seq: prev ? prev.seq : seq++ });
  }
  return [...order.values()].sort((a, b) => a.seq - b.seq).map((x) => x.lib);
}

function mergeVersion(parent, child) {
  const merged = { ...parent, ...child };
  merged.id = child.id;
  merged.inheritsFrom = child.inheritsFrom;
  merged.libraries = mergeLibraries(parent.libraries, child.libraries);
  merged.assetIndex = child.assetIndex || parent.assetIndex;
  merged.assets = child.assets || parent.assets;
  merged.downloads = { ...(parent.downloads || {}), ...(child.downloads || {}) };
  merged.mainClass = child.mainClass || parent.mainClass;
  if (child.arguments) {
    merged.arguments = {
      game: [...((parent.arguments && parent.arguments.game) || []), ...(child.arguments.game || [])],
      jvm: [...((parent.arguments && parent.arguments.jvm) || []), ...(child.arguments.jvm || [])],
    };
  }
  return merged;
}

module.exports = {
  getManifest,
  guessMcVersion,
  getVersionMeta,
  listInstalled,
  loadVersionJson,
  readJson,
  loaderOf,
  dirSize,
};
