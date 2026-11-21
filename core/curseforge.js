'use strict';
/**
 * CurseForge 整合包来源
 *
 * 注意：CurseForge 官方 API 强制要求 API Key（免费申请），没有 key 无法取列表与下载地址。
 * key 存在设置里（cfApiKey），只在本地保存。
 *
 * 安装方式：下整合包 zip → 读 manifest.json → 逐个文件用 /v1/mods/{id}/files/{fileId} 换下载地址
 * → 交给 core/modpack 安装。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');

const net = require('./net');
const cnsearch = require('./cnsearch');
const modpack = require('./modpack');

const API = 'https://api.curseforge.com/v1';
const GAME_ID = 432; // Minecraft
const CLASS_MODPACK = 4471;

function headers(key) {
  return { 'x-api-key': key, Accept: 'application/json' };
}

async function api(key, url) {
  const res = await fetch(url, { headers: headers(key), signal: AbortSignal.timeout(25000) });
  if (res.status === 403) throw new Error('API Key 无效或已过期');
  if (res.status === 429) throw new Error('请求过于频繁，稍后再试');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json.data;
}

async function search(key, query, { limit = 20, offset = 0 } = {}) {
  const build = (q) =>
    `${API}/mods/search?gameId=${GAME_ID}&classId=${CLASS_MODPACK}` +
    `&searchFilter=${encodeURIComponent(q || '')}&pageSize=${limit}&index=${offset}` +
    `&sortField=6&sortOrder=desc`;

  // CurseForge 同样只认英文，中文先翻译再查；取命中最多的一档
  const tries = cnsearch.candidates(query);
  let data = null;
  let usedQuery = '';
  let best = -1;
  for (const q of tries) {
    const got = await api(key, build(q));
    const n = (got.pagination && got.pagination.totalCount) || (got.length || 0);
    if (n > best) {
      best = n;
      data = got;
      usedQuery = q;
    }
    if (n >= 5) break;
  }

  return {
    total: (data.pagination && data.pagination.totalCount) || data.length,
    hits: (data.map ? data : []).map((m) => ({
      id: String(m.id),
      slug: m.slug,
      title: m.name,
      description: m.summary,
      icon: m.logo && m.logo.thumbnailUrl,
      downloads: m.downloadCount,
      author: (m.authors && m.authors[0] && m.authors[0].name) || '',
      categories: (m.categories || []).map((c) => c.name),
      versions: [],
    })),
    usedQuery: usedQuery !== query ? usedQuery : '',
  };
}

async function files(key, modId) {
  const data = await api(key, `${API}/mods/${modId}/files?pageSize=50`);
  return (Array.isArray(data) ? data : [])
    .filter((f) => f.releaseType === 1 || f.releaseType === 2) // release / beta
    .map((f) => ({
      id: String(f.id),
      name: f.displayName,
      number: f.displayName,
      type: f.releaseType === 1 ? 'release' : 'beta',
      gameVersions: f.gameVersions || [],
      loaders: [],
      date: f.fileDate,
      downloads: f.downloadCount || 0,
      file: { url: f.downloadUrl, filename: f.fileName, size: f.fileLength },
    }));
}

/** manifest.json → 安装 spec（文件下载地址要单独换） */
async function buildSpec(key, zipPath, onProgress) {
  const zip = new AdmZip(zipPath);
  const entry = zip.getEntry('manifest.json');
  if (!entry) throw new Error('这不是 CurseForge 整合包（缺 manifest.json）');
  const manifest = JSON.parse(entry.getData().toString('utf8'));

  const mc = manifest.minecraft || {};
  const loaderEntry = (mc.modLoaders || []).find((l) => l.primary) || (mc.modLoaders || [])[0] || {};
  const rawId = String(loaderEntry.id || ''); // 例：forge-47.2.0 / fabric-0.15.11
  const dash = rawId.indexOf('-');
  const loaderName = dash > 0 ? rawId.slice(0, dash) : '';
  const loaderVersion = dash > 0 ? rawId.slice(dash + 1) : ''; // forge-1.20.1-47.2.0 的情况后面再处理

  let loader = '';
  if (loaderName === 'forge') loader = 'forge';
  else if (loaderName === 'neoforge') loader = 'neoforge';
  else if (loaderName === 'fabric') loader = 'fabric';
  else if (loaderName === 'quilt') loader = 'quilt';

  // Forge 的 id 有时是 forge-1.20.1-47.2.0，取最后一段
  const lv = loaderVersion.includes('-') ? loaderVersion.split('-').pop() : loaderVersion;

  const wanted = (manifest.files || []).filter((f) => f.required !== false);
  const files = [];
  let done = 0;
  for (const f of wanted) {
    try {
      const data = await api(key, `${API}/mods/${f.projectID}/files/${f.fileID}`);
      if (data && data.downloadUrl) {
        files.push({
          path: `mods/${data.fileName}`,
          url: data.downloadUrl,
          size: data.fileLength || 0,
        });
      }
    } catch {
      /* 单个文件拿不到不影响其它 */
    }
    done++;
    if (onProgress && done % 5 === 0) {
      onProgress({ stage: 'resolve', message: `解析文件 ${done}/${wanted.length}`, percent: 3 });
    }
  }

  return {
    name: manifest.name || path.basename(zipPath, '.zip'),
    packVersion: manifest.version || '',
    mcVersion: mc.version || '',
    loader,
    loaderVersion: lv,
    files,
    overridesZip: zipPath,
    overridesPrefix: (manifest.overrides || 'overrides') + '/',
    source: 'curseforge',
  };
}

async function installVersion({ apiKey, downloadUrl, fileName, gameDir, javaPath, source, baseUrl, onProgress }) {
  const report = (p) => onProgress && onProgress(p);
  const tmp = path.join(os.tmpdir(), `smucl-cf-${Date.now()}.zip`);

  try {
    report({ stage: 'download', message: '下载整合包', percent: 2 });
    await net.download(downloadUrl, tmp, { retries: 3, timeout: 180000 });

    report({ stage: 'resolve', message: '读取 manifest 并解析文件', percent: 3 });
    const spec = await buildSpec(apiKey, tmp, report);
    if (!spec.mcVersion) return { ok: false, error: '整合包没有声明游戏版本' };

    const r = await modpack.install({ gameDir, spec, javaPath, source: source || 'bmcl', baseUrl, onProgress });
    if (!r.ok) return r;
    return { ok: true, data: { ...r.data, file: fileName || '' } };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件清不掉不影响结果 */
    }
  }
}

module.exports = { search, files, buildSpec, installVersion };
