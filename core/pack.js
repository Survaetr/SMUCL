'use strict';
/**
 * 整合包导入
 *
 * 支持三类来源：
 *   1. 启动器导出的整包（PCL / HMCL）：zip 内含 versions/<id>/<id>.json，
 *      这类包自带完整加载器配置，解压合并就能用，不需要"再装一遍加载器"。
 *   2. 纯实例目录：只有 mods / config，没有 versions/ —— 需要目标目录里已有对应版本。
 *   3. CurseForge / Modrinth 清单包：只有 manifest.json 或 modrinth.index.json，
 *      不含版本文件，必须现场安装加载器（当前版本暂不支持，会明确告知）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const safe = require('./safe');

// 导入时跳过的东西：属于「这个玩家的本机状态」，不是整合包内容
const SKIP_TOP = new Set(['launcher_profiles.json', 'launcher_accounts.json', 'logs', 'crash-reports', 'screenshots']);

function loaderOf(name) {
  const s = String(name || '').toLowerCase();
  if (s.includes('neoforge') || s.includes('neoforged')) return 'NeoForge';
  if (s.includes('quilt')) return 'Quilt';
  if (s.includes('fabric')) return 'Fabric';
  if (s.includes('liteloader')) return 'LiteLoader';
  if (s.includes('forge')) return 'Forge';
  return '';
}

/** 把 zip 条目统一成 posix 风格，去掉 ./ 前缀；含 .. 或绝对路径的条目直接丢弃 */
function entryPaths(zip) {
  const out = [];
  for (const e of zip.getEntries()) {
    const name = safe.safeEntryName(e.entryName);
    if (!name) continue;
    out.push({ entry: e, name, size: e.header.size, isDir: e.isDirectory });
  }
  return out;
}

/**
 * 判断公用前缀：整包经常被包一层 "MyPack/" 或 "MyPack/.minecraft/"。
 * 找到同时含 versions/ 或 mods/ 的那一层。
 */
function detectPrefix(items) {
  const dirs = new Set();
  for (const it of items) {
    if (it.isDir) continue;
    const seg = it.name.split('/');
    for (let i = 1; i < seg.length; i++) {
      dirs.add(seg.slice(0, i).join('/'));
    }
  }
  // 从深到浅找一个「其下有 versions/ 或 mods/」的目录
  const sorted = Array.from(dirs).sort((a, b) => b.split('/').length - a.split('/').length);
  for (const d of sorted) {
    const has = items.some((it) => it.name.startsWith(d + '/versions/') || it.name.startsWith(d + '/mods/'));
    if (has) return d + '/';
  }
  return '';
}

function readJsonEntry(zip, item) {
  try {
    return JSON.parse(zip.readAsText(item.entry));
  } catch {
    return null;
  }
}

/** 找出 versions/<id>/<id>.json 形式的实例 */
function findInstances(items, prefix) {
  const found = [];
  for (const it of items) {
    if (it.isDir || !it.name.endsWith('.json')) continue;
    const rel = it.name.slice(prefix.length);
    const m = rel.match(/^versions\/([^/]+)\/\1\.json$/);
    if (m) found.push({ id: m[1], rel, name: it.name });
  }
  return found;
}

/**
 * 检查一份版本 JSON 依赖的 libraries 是否齐全（会跟进 inheritsFrom）
 * 返回 { total, missing: [...] }
 */
function checkLibraries(gameDir, versionId, depth = 0) {
  const jsonPath = path.join(gameDir, 'versions', versionId, `${versionId}.json`);
  let json;
  try {
    json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch {
    return { total: 0, missing: [], error: '版本 JSON 不存在或损坏' };
  }

  let total = 0;
  const missing = [];
  for (const lib of json.libraries || []) {
    if (!lib.downloads || !lib.downloads.artifact) continue;
    const rel = lib.downloads.artifact.path;
    if (!rel) continue;
    total++;
    if (!fs.existsSync(path.join(gameDir, 'libraries', rel))) missing.push(rel);
  }

  if (json.inheritsFrom && depth < 3) {
    const parent = checkLibraries(gameDir, json.inheritsFrom, depth + 1);
    total += parent.total;
    missing.push(...parent.missing);
  }
  return { total, missing };
}

/** 扫描整合包，不做任何写入 */
function inspect(zipPath) {
  let zip;
  try {
    zip = new AdmZip(zipPath);
  } catch (e) {
    return { ok: false, error: `无法读取压缩包：${e.message}` };
  }

  const items = entryPaths(zip);
  const prefix = detectPrefix(items);
  const totalSize = items.reduce((n, it) => n + (it.isDir ? 0 : it.size), 0);
  const name = path.basename(zipPath, path.extname(zipPath));

  const instances = findInstances(items, prefix);
  if (instances.length) {
    const main = instances[0];
    const item = items.find((it) => it.name === main.name);
    const json = item ? readJsonEntry(zip, item) : null;
    const mods = items.filter((it) => it.name.startsWith(prefix + 'mods/') && it.name.endsWith('.jar')).length;
    return {
      ok: true,
      kind: 'launcher',
      name,
      prefix,
      instances: instances.map((i) => i.id),
      id: main.id,
      mcVersion: (json && (json.inheritsFrom || json.id)) || main.id,
      loader: loaderOf(main.id) || loaderOf((json && json.id) || ''),
      mods,
      size: totalSize,
      files: items.filter((it) => !it.isDir).length,
    };
  }

  const manifest = items.find((it) => it.name === prefix + 'manifest.json');
  if (manifest) {
    const json = readJsonEntry(zip, manifest);
    if (json && json.minecraft) {
      return {
        ok: true,
        kind: 'curseforge',
        name: json.name || name,
        prefix,
        mcVersion: json.minecraft.version,
        loader: manifestLoader(json),
        mods: (json.files || []).length,
        size: totalSize,
        files: items.filter((it) => !it.isDir).length,
      };
    }
  }

  const mrIndex = items.find((it) => it.name === prefix + 'modrinth.index.json');
  if (mrIndex) {
    const json = readJsonEntry(zip, mrIndex);
    if (json && json.dependencies) {
      return {
        ok: true,
        kind: 'modrinth',
        name: json.name || name,
        prefix,
        mcVersion: json.dependencies.minecraft || '',
        loader: mrLoader(json.dependencies),
        mods: (json.files || []).length,
        size: totalSize,
        files: items.filter((it) => !it.isDir).length,
      };
    }
  }

  const hasMods = items.some((it) => it.name.startsWith(prefix + 'mods/'));
  return {
    ok: true,
    kind: hasMods ? 'instance' : 'unknown',
    name,
    prefix,
    mcVersion: '',
    loader: '',
    mods: items.filter((it) => it.name.startsWith(prefix + 'mods/') && it.name.endsWith('.jar')).length,
    size: totalSize,
    files: items.filter((it) => !it.isDir).length,
  };
}

function manifestLoader(json) {
  const mods = (json.minecraft && json.minecraft.modLoaders) || [];
  const pick = mods.find((m) => m.primary) || mods[0];
  if (!pick) return '';
  return `${loaderOf(pick.id)} ${String(pick.id).replace(/^\D+/, '')}`.trim();
}

function mrLoader(dep) {
  if (dep['neoforge']) return `NeoForge ${dep['neoforge']}`;
  if (dep['fabric-loader']) return `Fabric ${dep['fabric-loader']}`;
  if (dep['quilt-loader']) return `Quilt ${dep['quilt-loader']}`;
  if (dep['forge']) return `Forge ${dep['forge']}`;
  return '';
}

/**
 * 手写递归拷贝。
 * 注意：不要用 fs.cpSync —— 在本机 Node 22.22.2 上它会把进程直接干掉（exit 127，
 * 没有任何异常可捕获），打包版是同一个运行时，用它会连带启动器一起崩。
 */
function copyDir(from, to, onFile) {
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, ent.name);
    const d = path.join(to, ent.name);
    if (ent.isDirectory()) {
      copyDir(s, d, onFile);
    } else if (ent.isFile()) {
      fs.copyFileSync(s, d);
      if (onFile) onFile();
    }
  }
}

/** 合并目录：同名实例自动改名，不覆盖已有东西 */
function mergeInto(srcRoot, targetDir, report, onFile) {
  const entries = fs.readdirSync(srcRoot, { withFileTypes: true });
  for (const ent of entries) {
    if (SKIP_TOP.has(ent.name)) continue;
    const from = path.join(srcRoot, ent.name);
    const to = path.join(targetDir, ent.name);

    if (!ent.isDirectory()) {
      if (!fs.existsSync(to)) {
        fs.copyFileSync(from, to);
        if (onFile) onFile();
        else report.files++;
      }
      continue;
    }

    if (ent.name === 'versions') {
      for (const v of fs.readdirSync(from, { withFileTypes: true })) {
        if (!v.isDirectory()) continue;
        let id = v.name;
        let suffix = 0;
        let dest = path.join(to, id);
        while (fs.existsSync(dest)) {
          suffix++;
          id = `${v.name}-imported${suffix > 1 ? '-' + suffix : ''}`;
          dest = path.join(to, id);
        }
        copyDir(path.join(from, v.name), dest, onFile);
        // 版本 JSON 必须与文件夹同名，重命名后要跟着改
        const oldJson = path.join(dest, `${v.name}.json`);
        const newJson = path.join(dest, `${id}.json`);
        if (id !== v.name && fs.existsSync(oldJson)) fs.renameSync(oldJson, newJson);
        report.versions.push({ id, from: v.name, renamed: id !== v.name });
      }
      continue;
    }

    copyDir(from, to, onFile);
    report.dirs.add(ent.name);
  }
}

/** 真正导入：解压到临时目录 → 合并进游戏目录 */
async function importPack({ zipPath, targetDir, onProgress }) {
  if (!zipPath || !fs.existsSync(zipPath)) return { ok: false, error: '找不到整合包文件' };
  if (!targetDir || !fs.existsSync(targetDir)) return { ok: false, error: '目标游戏目录不存在' };

  const info = inspect(zipPath);
  if (!info.ok) return info;
  if (info.kind === 'curseforge' || info.kind === 'modrinth') {
    return {
      ok: false,
      error:
        `这是 ${info.kind === 'modrinth' ? 'Modrinth' : 'CurseForge'} 清单包，包内只有模组清单、不含版本文件，` +
        '需要先在线安装对应加载器。当前版本暂不支持，建议用 PCL 安装后再导入。',
    };
  }
  if (info.kind === 'unknown') {
    return { ok: false, error: '压缩包里没有找到 versions/ 或 mods/ 目录，可能不是整合包' };
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'smucl-pack-'));
  const report = { files: 0, versions: [], dirs: new Set(), warnings: [] };

  try {
    const zip = new AdmZip(zipPath);
    // 自己逐条解压：丢弃越界条目，并限制条目数与解压体积（防 zip 炸弹）
    const items = entryPaths(zip);
    if (items.length > 50000) throw new Error('压缩包条目过多');
    let budget = 4 * 1024 * 1024 * 1024;
    for (const it of items) {
      if (it.isDir) continue;
      budget -= Number(it.size || 0);
      if (budget < 0) throw new Error('压缩包解压后体积异常');
    }
    for (const it of items) {
      if (it.isDir) continue;
      const dest = safe.safeJoin(temp, it.name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, it.entry.getData());
    }

    // 解压后重新定位真正的根（对应 zip 里的 prefix）
    let root = temp;
    for (const seg of info.prefix.replace(/\/$/, '').split('/').filter(Boolean)) {
      if (seg === '..') break;
      root = path.join(root, seg);
      if (!fs.existsSync(root)) {
        root = temp;
        break;
      }
    }
    // 兜底：无论 prefix 怎么写，都不允许合并源跑到临时目录之外
    if (!fs.existsSync(root) || !safe.withinDir(temp, root)) root = temp;

    let copied = 0;
    const onFile = () => {
      copied++;
      if (onProgress) onProgress(copied);
    };
    mergeInto(root, targetDir, report, onFile);
    report.files = copied;

    // 导入完检查依赖库是否齐全（导出的包通常不含公共库）
    const libIssues = [];
    for (const v of report.versions) {
      const { total, missing } = checkLibraries(targetDir, v.id);
      if (missing.length) libIssues.push({ id: v.id, total, missing: missing.length });
    }
    if (libIssues.length) {
      report.warnings.push(
        `有 ${libIssues.length} 个实例缺少依赖库（导出包一般不含公共库），` +
          `可用 PCL 打开一次该实例自动补齐，或重新下载对应版本`
      );
    }
    if (info.kind === 'instance') {
      report.warnings.push('这个包只有 mods/config，没有 versions 目录，需要目标目录里已有对应游戏版本才能启动');
    }

    return {
      ok: true,
      data: {
        kind: info.kind,
        versions: report.versions,
        dirs: Array.from(report.dirs),
        files: report.files,
        warnings: report.warnings,
        libIssues,
      },
    };
  } finally {
    try {
      fs.rmSync(temp, { recursive: true, force: true });
    } catch {
      /* 临时目录清不掉不影响导入结果 */
    }
  }
}

module.exports = { inspect, importPack, checkLibraries, loaderOf, mergeInto };
