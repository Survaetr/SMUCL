'use strict';
/**
 * 模组 / 光影 / 材质包 下载（Modrinth 公开 API，无需 key）。
 *
 * 三类内容的差别只在「装到哪个目录」和「要不要按加载器过滤」：
 *   mod          → mods/          需要按加载器筛选
 *   shader       → shaderpacks/   不筛加载器（其 loaders 是 iris/optifine，与实例加载器无关）
 *   resourcepack → resourcepacks/ 同上
 *
 * 安装目录与启动参数保持一致：只有版本隔离的实例才装进 versions/<id>/，
 * 否则装进游戏根目录 —— 否则 mods 会「凭空出现」，而 --gameDir 仍指向根目录，游戏读不到。
 */
const path = require('path');
const fs = require('fs');
const net = require('./net');
const safe = require('./safe');
const dirsLib = require('./dirs');

const API = 'https://api.modrinth.com/v2';

const KINDS = {
  mod: { label: '模组', dir: 'mods', projectType: 'mod', byLoader: true },
  shader: { label: '光影', dir: 'shaderpacks', projectType: 'shader', byLoader: false },
  resourcepack: { label: '材质包', dir: 'resourcepacks', projectType: 'resourcepack', byLoader: false },
};

/** 启动器显示的加载器名 → Modrinth 的 facets 值 */
const LOADER_FACET = { Fabric: 'fabric', Quilt: 'quilt', Forge: 'forge', NeoForge: 'neoforge' };

function kindOf(kind) {
  const def = KINDS[kind];
  if (!def) throw new Error(`不支持的内容类型：${kind}`);
  return def;
}

function normalizeHit(h) {
  return {
    id: h.project_id,
    slug: h.slug,
    title: h.title,
    description: h.description,
    icon: h.icon_url,
    downloads: h.downloads || 0,
    follows: h.follows || 0,
    author: h.author,
    categories: h.categories || [],
    versions: h.versions || [],
  };
}

function normalizeVersion(v) {
  const file = (v.files || []).find((f) => f.primary) || (v.files || [])[0] || null;
  return {
    id: v.id,
    name: v.name,
    number: v.version_number,
    type: v.version_type,
    gameVersions: v.game_versions || [],
    loaders: v.loaders || [],
    date: v.date_published,
    downloads: v.downloads || 0,
    file: file
      ? {
          filename: file.filename,
          url: file.url,
          size: file.size || 0,
          sha1: (file.hashes && file.hashes.sha1) || '',
      }
      : null,
    dependencies: v.dependencies || [],
  };
}

/**
 * 搜索。
 * @param {'mod'|'shader'|'resourcepack'} kind
 */
/**
 * 光影与材质包基本是跨版本通用的：一个光影包往往只标注到 1.21.4，
 * 装进 1.21.11 照样能用（它们只依赖 Iris/OptiFine 的着色器接口，不依赖游戏补丁版本）。
 * 按单版本硬筛会把这类结果全部挡掉，所以这两类改成「同一小版本系列内任一命中即可」。
 */
const _gvCache = { at: 0, list: [] };

async function gameVersionList() {
  if (_gvCache.list.length && Date.now() - _gvCache.at < 6 * 3600 * 1000) return _gvCache.list;
  try {
    const list = await net.fetchJson(`${API}/tag/game_version`, { timeout: 15000 });
    const arr = (Array.isArray(list) ? list : [])
      .map((v) => String((v && v.version) || ''))
      .filter((v) => /^\d/.test(v));
    if (arr.length) {
      _gvCache.list = arr;
      _gvCache.at = Date.now();
    }
  } catch {
    /* 拿不到版本表就退回单版本筛选，不影响主流程 */
  }
  return _gvCache.list;
}

/** 1.21.11 → 1.21；26.3 → 26.3（新版号只有两段，直接原样返回） */
function familyOf(mcVersion) {
  const s = String(mcVersion == null ? '' : mcVersion).trim();
  if (!s) return '';
  const parts = s.split('.');
  return parts.length >= 3 ? `${parts[0]}.${parts[1]}` : s;
}

/**
 * 该类型应匹配的游戏版本列表。
 * mod 严格按实例版本；光影/材质包扩展到整个小版本系列。
 */
async function versionsFor(kind, mcVersion) {
  if (!mcVersion) return [];
  const def = KINDS[kind] || KINDS.mod;
  if (def.byLoader) return [mcVersion];

  const fam = familyOf(mcVersion);
  const all = await gameVersionList();
  const hit = all.filter((v) => v === mcVersion || v === fam || v.startsWith(fam + '.'));
  return hit.length > 1 ? hit : [mcVersion];
}

async function search(kind, { query = '', mcVersion = '', loader = '', limit = 24, offset = 0, sort = 'relevance' } = {}) {
  const def = kindOf(kind);
  const groups = [[`project_type:${def.projectType}`]];
  if (mcVersion) groups.push((await versionsFor(kind, mcVersion)).map((v) => `versions:${v}`));
  if (def.byLoader && loader && LOADER_FACET[loader]) groups.push([`categories:${LOADER_FACET[loader]}`]);

  const facets = encodeURIComponent(JSON.stringify(groups));
  const idx = ['relevance', 'downloads', 'follows', 'newest', 'updated'].includes(sort) ? sort : 'relevance';
  const url =
    `${API}/search?query=${encodeURIComponent(query)}&facets=${facets}` +
    `&limit=${limit}&offset=${offset}&index=${idx}`;

  const data = await net.fetchJson(url, { timeout: 20000 });
  return {
    total: data.total_hits || 0,
    hits: (data.hits || []).map(normalizeHit),
  };
}

/** 某项目的版本列表，按发布时间降序（Modrinth 默认即如此） */
async function versions(projectId, { mcVersion = '', loader = '', kind = 'mod' } = {}) {
  const def = KINDS[kind] || KINDS.mod;
  const q = [];
  if (mcVersion) {
    const gvs = await versionsFor(kind, mcVersion);
    q.push(`game_versions=${encodeURIComponent(JSON.stringify(gvs))}`);
  }
  if (def.byLoader && loader && LOADER_FACET[loader]) {
    q.push(`loaders=${encodeURIComponent(JSON.stringify([LOADER_FACET[loader]]))}`);
  }
  const url = `${API}/project/${encodeURIComponent(projectId)}/version${q.length ? '?' + q.join('&') : ''}`;
  const data = await net.fetchJson(url, { timeout: 20000 });
  return (Array.isArray(data) ? data : []).map(normalizeVersion);
}

async function getVersion(versionId) {
  const v = await net.fetchJson(`${API}/version/${encodeURIComponent(versionId)}`, { timeout: 20000 });
  return normalizeVersion(v);
}

/**
 * 递归收集 required 依赖。
 * 只在 mod 类型下做：光影/材质包的 dependencies 一般是空的，
 * 即使有也不是「装到同目录」这种语义。
 */
async function collectDeps(rootVersion, ctx, seen, out, depth = 0, failed = []) {
  if (depth > 5 || out.length >= 12) return;
  const deps = (rootVersion.dependencies || []).filter((d) => d.dependency_type === 'required');
  if (!deps.length) return;

  // 同一层的依赖并发查，串行会让「点安装后干等」变得很明显
  const pending = [];
  for (const d of deps) {
    const key = d.version_id || d.project_id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    pending.push(
      (async () => {
        try {
          if (d.version_id) return await getVersion(d.version_id);
          if (d.project_id) {
            const list = await versions(d.project_id, {
              mcVersion: ctx.mcVersion,
              loader: ctx.loader,
              kind: 'mod',
            });
            return list[0] || null;
          }
        } catch {
          return null; // 单个依赖查不到不该拖垮整次安装
        }
        return null;
      })()
    );
  }

  // 只有 modId、没有版本号或项目 ID 的必需依赖无法自动解析，
  // 记下来交给界面提示，别让用户在启动时才发现缺前置（JEI 27.x 就是这种情况）
  for (const d of deps) {
    if (!d.version_id && !d.project_id) {
      failed.push({ name: d.file_name || d.mod_id || '未标注名称的前置', reason: '发布方只写了 modId，无法自动定位' });
    }
  }

  const got = await Promise.all(pending);
  for (const v of got) {
    if (v && v.file) out.push(v);
  }
  for (const v of got) {
    if (v && v.file) await collectDeps(v, ctx, seen, out, depth + 1, failed);
  }
}

/** 目标目录：与 --gameDir 的判定保持一致 */
function targetOf(gameDir, instanceId, kind) {
  const def = kindOf(kind);
  const instDir = path.join(gameDir, 'versions', instanceId);
  const isolated = dirsLib.isIsolatedInstance(instDir);
  const base = isolated ? instDir : gameDir;
  return {
    dir: safe.assertWithin(gameDir, path.join(base, def.dir), '安装目录'),
    isolated,
    label: def.label,
  };
}

/**
 * 校验一条待下载文件。
 * 文件名与 URL 都来自第三方 API，且 planned 可能经渲染进程往返，
 * 所以每次使用前都重新校验一遍，而不是只在首次解析时校验。
 */
function assertFileSafe(f) {
  if (!f || typeof f !== 'object') throw new Error('文件信息不合法');
  if (!safe.isSafeSegment(f.name)) throw new Error(`文件名不合法：${f.name}`);
  if (!safe.isHttpUrl(f.url, safe.PACK_HOSTS)) throw new Error(`下载地址不在允许范围：${f.name}`);
}

/**
 * 生成安装计划（不下载），供界面预览。
 * @returns {{ dir, isolated, label, files: Array }}
 */
async function plan({ gameDir, instanceId, kind, versionId, mcVersion = '', loader = '' } = {}) {
  safe.assertVersionId(instanceId);
  const def = kindOf(kind);
  const root = await getVersion(versionId);
  if (!root.file) throw new Error('这个版本没有可下载的文件');

  const target = targetOf(gameDir, instanceId, kind);
  const files = [
    {
      name: root.file.filename,
      url: root.file.url,
      sha1: root.file.sha1,
      size: root.file.size,
      title: root.name || root.number,
      dependency: false,
    },
  ];

  const warnings = [];
  if (def.byLoader && root.gameVersions.length && mcVersion && !root.gameVersions.includes(mcVersion)) {
    warnings.push(`该文件标注支持 ${root.gameVersions.join(' / ')}，与当前实例的 ${mcVersion} 不一致`);
  }

  // 目标目录里已有的文件名：用来判断某个前置是不是已经装过，避免重复下载
  const present = existingFiles(target.dir);
  const deps = [];
  const unresolved = [];

  if (kind === 'mod') {
    try {
      await collectDeps(root, { mcVersion, loader }, new Set([versionId]), deps, 0, unresolved);
    } catch (e) {
      warnings.push(`依赖解析失败：${e.message}`);
    }
    for (const d of deps) {
      const name = d.file.filename;
      files.push({
        name,
        url: d.file.url,
        sha1: d.file.sha1,
        size: d.file.size,
        title: d.name || d.number,
        dependency: true,
        // 同名文件已在目录里，说明这个前置装过了
        installed: present.has(name.toLowerCase()),
      });
    }
  }

  for (const f of files) assertFileSafe(f);

  const depFiles = files.filter((f) => f.dependency);
  return {
    dir: target.dir,
    isolated: target.isolated,
    label: target.label,
    rootVersion: { id: root.id, number: root.number, name: root.name, type: root.type },
    files,
    warnings,
    // 前置检查结果：已装 / 待下载 / 无法解析，界面据此给提示
    deps: {
      total: depFiles.length + unresolved.length,
      installed: depFiles.filter((f) => f.installed).length,
      pending: depFiles.filter((f) => !f.installed).length,
      unresolved,
    },
  };
}

/** 目录里已存在的文件名（小写），读不到就当空 */
function existingFiles(dir) {
  try {
    return new Set(fs.readdirSync(dir).map((s) => String(s).toLowerCase()));
  } catch {
    return new Set();
  }
}

/** 项目详情：简介正文、分类、链接，供详情页展示 */
async function project(id) {
  const p = await net.fetchJson(`${API}/project/${encodeURIComponent(id)}`, { timeout: 20000 });
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    description: p.description || '',
    body: p.body || '',
    icon: p.icon_url || '',
    downloads: p.downloads || 0,
    followers: p.followers || 0,
    categories: p.categories || [],
    loaders: p.loaders || [],
    gameVersions: p.game_versions || [],
    license: (p.license || {}).id || '',
    sourceUrl: p.source_url || '',
    issuesUrl: p.issues_url || '',
    updated: p.updated || '',
  };
}

/**
 * 执行安装。
 * @param {Function} [onProgress] ({ stage, done, total, percent, message })
 */
async function install({
  gameDir,
  instanceId,
  kind,
  versionId,
  mcVersion = '',
  loader = '',
  planned,
  onProgress,
} = {}) {
  try {
    const report = (p) => onProgress && onProgress(p);
    report({ stage: 'plan', message: '解析依赖…', percent: 2 });

    let p;
    if (planned && Array.isArray(planned.files) && planned.files.length) {
      // 界面已经解析过一次，复用它的结果省一轮网络往返；
      // 但目录由主进程自己算，文件逐条重新校验，不信任渲染进程传来的任何路径
      const target = targetOf(gameDir, instanceId, kind);
      const files = planned.files.map((f) => ({
        name: String(f.name || ''),
        url: String(f.url || ''),
        sha1: String(f.sha1 || ''),
        size: Number(f.size) || 0,
        dependency: Boolean(f.dependency),
      }));
      for (const f of files) assertFileSafe(f);
      p = { dir: target.dir, isolated: target.isolated, label: target.label, files, warnings: [] };
    } else {
      p = await plan({ gameDir, instanceId, kind, versionId, mcVersion, loader });
    }
    report({ stage: 'download', message: `准备下载 ${p.files.length} 个文件`, percent: 6 });

    fs.mkdirSync(p.dir, { recursive: true });

    const failed = [];
    let done = 0;
    let bytes = 0;
    for (const f of p.files) {
      const dest = path.join(p.dir, f.name);
      try {
        const r = await net.download(f.url, dest, {
          expectedSha1: f.sha1,
          expectedSize: f.size,
          retries: 2,
          timeout: 120000,
        });
        bytes += r && r.size ? r.size : f.size;
      } catch (e) {
        failed.push({ name: f.name, error: e.message });
      }
      done++;
      report({
        stage: 'download',
        done,
        total: p.files.length,
        percent: Math.min(96, 6 + Math.round((done / p.files.length) * 90)),
        message: f.dependency ? `依赖 ${done}/${p.files.length}` : `下载 ${done}/${p.files.length}`,
      });
    }

    report({ stage: 'done', percent: 100, message: '安装完成' });
    return {
      ok: true,
      data: {
        dir: p.dir,
        isolated: p.isolated,
        installed: p.files.length - failed.length,
        dependencies: p.files.filter((f) => f.dependency).length,
        bytes,
        failed,
        warnings: p.warnings,
      },
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { search, versions, plan, install, project, familyOf };
