'use strict';
/**
 * 读取实例里已安装的模组。
 *
 * 不做「猜文件名」：名称与版本一律从 jar 内的元数据读，
 * 因为 mods 目录里的文件名经常是 `sodium-fabric-0.5.8+mc1.20.1.jar` 这种，
 * 直接显示给用户没有意义。
 *
 * 覆盖四类加载器的元数据位置：
 *   Fabric    → fabric.mod.json
 *   Quilt     → quilt.mod.json
 *   NeoForge  → META-INF/neoforge.mods.toml（1.20.5+）/ META-INF/mods.toml
 *   Forge     → META-INF/mods.toml
 * 都读不到时退回 jar 的 MANIFEST.MF 或文件名本身。
 */
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const JAR_RE = /\.jar$/i;

function isModFile(name) {
  return JAR_RE.test(name) || /\.jar\.disabled$/i.test(name);
}

function readJsonEntry(zip, name) {
  const entry = zip.getEntry(name);
  if (!entry) return null;
  try {
    return JSON.parse(zip.readAsText(entry));
  } catch {
    return null;
  }
}

function readTextEntry(zip, name) {
  const entry = zip.getEntry(name);
  if (!entry) return '';
  try {
    return zip.readAsText(entry);
  } catch {
    return '';
  }
}

/** 从 MANIFEST.MF 取 Implementation-Version，Forge 的 ${file.jarVersion} 要用它 */
function manifestVersion(zip) {
  const text = readTextEntry(zip, 'META-INF/MANIFEST.MF');
  if (!text) return '';
  const m = text.match(/^Implementation-Version:\s*(.+)$/im);
  return m ? m[1].trim() : '';
}

/**
 * 极简 TOML 读取：只取第一个 [[mods]] 段里的三个键。
 * 引入完整 TOML 解析器对这里没有收益，而且会多一个依赖。
 */
function readModsToml(zip, entryName, fallbackVersion) {
  const text = readTextEntry(zip, entryName);
  if (!text) return null;

  const parts = text.split(/\[\[\s*mods\s*\]\]/i);
  if (parts.length < 2) return null;
  // 只取第一段，遇到下一个 [[ 或 [ 开头的新表就停
  const body = parts[1].split(/^\s*\[/m)[0];

  const pick = (key) => {
    const m = body.match(new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'm'));
    return m ? m[1] || m[2] || '' : '';
  };

  let version = pick('version');
  // 部分模组写的是占位符，真实值在 MANIFEST.MF 里
  if (!version || /^\$\{.*\}$/.test(version)) version = fallbackVersion || '';

  return { id: pick('modId'), name: pick('displayName'), version };
}

/** 读单个 jar，返回 {name,id,version,source}，任何异常都不向外抛 */
function readMeta(fullPath) {
  const fallback = path.basename(fullPath).replace(/\.jar(\.disabled)?$/i, '');
  let zip;
  try {
    zip = new AdmZip(fullPath);
  } catch {
    return { name: fallback, id: '', version: '', source: 'unknown', broken: true };
  }

  try {
    const fabric = readJsonEntry(zip, 'fabric.mod.json');
    if (fabric && (fabric.id || fabric.name)) {
      return {
        id: String(fabric.id || ''),
        name: String(fabric.name || fabric.id || fallback),
        version: String(fabric.version || '').replace(/^\$\{.*\}$/, ''),
        source: 'fabric',
      };
    }

    const quilt = readJsonEntry(zip, 'quilt.mod.json');
    if (quilt) {
      const q = quilt.quilt_loader || {};
      const meta = q.metadata || {};
      const name = meta.name || q.id || fallback;
      return {
        id: String(q.id || ''),
        name: String(name),
        version: String(q.version || '').replace(/^\$\{.*\}$/, ''),
        source: 'quilt',
      };
    }

    const manifestVer = manifestVersion(zip);
    for (const [entryName, source] of [
      ['META-INF/neoforge.mods.toml', 'neoforge'],
      ['META-INF/mods.toml', 'forge'],
    ]) {
      const toml = readModsToml(zip, entryName, manifestVer);
      if (toml && (toml.id || toml.name)) {
        return {
          id: toml.id,
          name: toml.name || toml.id || fallback,
          version: toml.version,
          source,
        };
      }
    }

    if (manifestVer) {
      return { id: '', name: fallback, version: manifestVer, source: 'manifest' };
    }
  } catch {
    /* 损坏的 jar 按未知处理，不影响其它条目 */
  }

  return { id: '', name: fallback, version: '', source: 'unknown' };
}

/**
 * 列出目录里的模组。
 * @param {string} modsDir
 * @returns {{modsDir:string, exists:boolean, mods:Array, total:number, enabled:number}}
 */
function list(modsDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(modsDir, { withFileTypes: true });
  } catch {
    return { modsDir, exists: false, mods: [], total: 0, enabled: 0 };
  }

  const mods = [];
  for (const ent of entries) {
    if (!ent.isFile() || !isModFile(ent.name)) continue;
    const full = path.join(modsDir, ent.name);
    let size = 0;
    let mtime = 0;
    try {
      const st = fs.statSync(full);
      size = st.size;
      mtime = st.mtimeMs;
    } catch {}
    const meta = readMeta(full);
    mods.push({
      file: ent.name,
      name: meta.name,
      id: meta.id,
      version: meta.version,
      source: meta.source,
      broken: Boolean(meta.broken),
      disabled: !JAR_RE.test(ent.name),
      size,
      mtime,
    });
  }

  // 启用的排前面，同类按名称排序，读不出名字的沉底
  mods.sort((a, b) => {
    if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
    return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
  });

  return {
    modsDir,
    exists: true,
    mods,
    total: mods.length,
    enabled: mods.filter((m) => !m.disabled).length,
  };
}

/** 只允许改动 mods 目录下的文件名，挡掉路径分隔符与通配符 */
function assertModFile(name) {
  const s = String(name || '');
  if (!s || s.length > 200) throw new Error('模组文件名不合法');
  if (/[\\/:*?"<>|]/.test(s)) throw new Error('模组文件名含有非法字符');
  if (s.startsWith('.')) throw new Error('模组文件名不合法');
  if (!isModFile(s)) throw new Error('只接受 .jar 或 .jar.disabled');
  return s;
}

/**
 * 启用 / 禁用：靠改扩展名，游戏不会加载 .disabled 的文件。
 * @returns {string} 改完之后的文件名
 */
function toggle(modsDir, file, enabled) {
  const name = assertModFile(file);
  const full = path.join(modsDir, name);
  if (!fs.existsSync(full)) throw new Error('模组文件不存在');

  const wantEnabled = Boolean(enabled);
  const isDisabled = !JAR_RE.test(name);

  let next = name;
  if (wantEnabled && isDisabled) next = name.replace(/\.disabled$/i, '');
  else if (!wantEnabled && !isDisabled) next = `${name}.disabled`;
  else return name;

  const target = path.join(modsDir, next);
  if (fs.existsSync(target)) throw new Error(`已存在同名文件：${next}`);
  fs.renameSync(full, target);
  return next;
}

module.exports = { list, toggle, assertModFile, readMeta, isModFile };
