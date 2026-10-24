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

function mergeVersion(parent, child) {
  const merged = { ...parent, ...child };
  merged.id = child.id;
  merged.inheritsFrom = child.inheritsFrom;
  merged.libraries = [...(parent.libraries || []), ...(child.libraries || [])];
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
  getVersionMeta,
  listInstalled,
  loadVersionJson,
  readJson,
  loaderOf,
  dirSize,
};
