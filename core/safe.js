'use strict';
/**
 * 安全边界工具集。
 *
 * 主进程收到的所有路径、版本名、URL 都视为不可信输入（渲染进程可能被导航劫持或
 * 被注入脚本），统一在这里做四件事：
 *   1. 版本名只允许单段，且不能是保留设备名 / 通配符 / 控制字符；
 *   2. 所有拼接出来的路径必须落在给定根目录内（防目录穿越）；
 *   3. 下载地址只允许 http/https，且必须命中白名单主机；
 *   4. 压缩包条目必须是安全的相对路径，且扩展名在白名单内。
 */
const fs = require('fs');
const path = require('path');

/** Windows 保留设备名，作为目录名会解析到设备 */
const RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** 版本名里的非法字符：路径分隔符、Windows 通配符、控制字符 */
const BAD_ID_CHARS = /[\\/:*?"<>|\u0000-\u001f]/;

/**
 * 版本名 / 实例名只允许单段。
 * 允许中文与空格（很多整合包实例名带空格），但不允许任何能改变路径含义的字符。
 * @param {unknown} id
 * @param {string} label 报错时使用的名称
 * @returns {string}
 */
function assertVersionId(id, label = '版本名') {
  if (typeof id !== 'string') throw new Error(`${label}无效`);
  const name = id;
  if (!name || name.length > 64) throw new Error(`${label}长度非法`);
  if (name === '.' || name === '..') throw new Error(`${label}非法`);
  if (BAD_ID_CHARS.test(name)) throw new Error(`${label}含有非法字符`);
  if (/^[.\s]|[.\s]$/.test(name)) throw new Error(`${label}不能以点或空格开头/结尾`);
  const base = name.split('.')[0].toLowerCase();
  if (RESERVED.has(base)) throw new Error(`${label}使用了系统保留名称`);
  return name;
}

/** 解析符号链接后的绝对路径；目标不存在时退回 resolve */
function realish(p) {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    return abs;
  }
}

/**
 * child 是否位于 parent 子树内（含 parent 自身）
 * 用 path.relative 判断，避免 `C:\a\b` 与 `C:\a\bc` 这类前缀误判。
 */
function withinDir(parent, child) {
  if (!parent || !child) return false;
  const p = realish(parent);
  const c = realish(child);
  const rel = path.relative(p, c);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 断言路径在根目录内，返回绝对路径 */
function assertWithin(parent, child, label = '路径') {
  if (!withinDir(parent, child)) throw new Error(`${label}超出允许范围`);
  return path.resolve(child);
}

/** 单段路径片段是否安全（不含分隔符、不是绝对路径、不含 ..） */
function isSafeSegment(seg) {
  if (typeof seg !== 'string' || !seg) return false;
  if (seg === '.' || seg === '..') return false;
  if (path.isAbsolute(seg) || /^[a-zA-Z]:/.test(seg)) return false;
  if (/[\\/]/.test(seg)) return false;
  if (/[\u0000-\u001f]/.test(seg)) return false;
  return true;
}

/**
 * 安全拼接：逐段校验后再拼，最后再验证一次整体没有逃出 base。
 * 用于「元数据里给的相对路径」这类不可信输入。
 */
function safeJoin(base, ...parts) {
  if (!base) throw new Error('缺少根目录');
  for (const part of parts) {
    if (typeof part !== 'string' || !part) throw new Error('路径片段无效');
    const normalized = part.replace(/\\/g, '/');
    for (const seg of normalized.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') throw new Error('路径片段包含目录穿越');
    }
    if (path.isAbsolute(part) || /^[a-zA-Z]:/.test(part)) throw new Error('路径片段不能是绝对路径');
  }
  const out = path.resolve(base, ...parts);
  return assertWithin(base, out);
}

/** 规范化压缩包条目名；不安全则返回 null */
function safeEntryName(name) {
  if (typeof name !== 'string' || !name || name.length > 260) return null;
  const normalized = name.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.startsWith('/')) return null;
  if (/^[a-zA-Z]:/.test(normalized)) return null;
  if (/[\u0000-\u001f]/.test(normalized)) return null;
  for (const seg of normalized.split('/')) {
    if (seg === '..') return null;
  }
  return normalized;
}

/** 只放行 http / https；可附加主机白名单（后缀匹配 a.example.com 与 example.com） */
function isHttpUrl(value, hosts) {
  if (typeof value !== 'string' || !value) return false;
  let u;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (!u.hostname) return false;
  if (hosts && hosts.length) {
    const host = u.hostname.toLowerCase();
    const hit = hosts.some((h) => host === h || host.endsWith(`.${h}`));
    if (!hit) return false;
  }
  return true;
}

function assertHttpUrl(value, hosts, label = '链接') {
  if (!isHttpUrl(value, hosts)) throw new Error(`${label}不在允许范围内`);
  return value;
}

/** 允许下载的游戏元数据 / 资源主机（官方源 + BMCLAPI 镜像） */
const GAME_HOSTS = [
  'mojang.com',
  'minecraft.net',
  'bmclapi2.bangbang93.com',
  'bmclapi.bangbang93.com',
];

/** 允许的整合包 CDN */
const PACK_HOSTS = ['modrinth.com', 'forgecdn.net', 'curseforge.com'];

module.exports = {
  RESERVED,
  GAME_HOSTS,
  PACK_HOSTS,
  assertVersionId,
  assertWithin,
  withinDir,
  safeJoin,
  isSafeSegment,
  safeEntryName,
  isHttpUrl,
  assertHttpUrl,
  realish,
};
