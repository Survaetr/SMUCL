'use strict';
/**
 * 正版账号的皮肤头像。
 *
 * 流程：sessionserver 取 profile → 解析 textures 属性里的 SKIN 地址 → 下载皮肤 PNG
 * → 用 nativeImage 裁出「头部 8×8」和「帽子层 8×8」两张小图 → 以 data URL 交给渲染层。
 *
 * 为什么不把皮肤整张丢给界面自己定位：
 *   - 老皮肤是 64×32、新皮肤是 64×64、高清皮肤可能是 128×128，百分比定位会算错；
 *   - 裁成 8×8 后，界面只要 100% × 100% 铺开就是对的，与格式无关；
 *   - 顺便只传几百字节，比整张皮肤（几 KB 到几十 KB）更省。
 *
 * 皮肤文件缓存在 userData/skins/<uuid>.png，默认 6 小时内不重复下载；
 * 下载失败时如果本地有旧缓存，仍用旧缓存，不至于因为断网就退回字母。
 */
const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');

const SESSION_URL = 'https://sessionserver.mojang.com/session/minecraft/profile/';
const TEXTURE_HOSTS = new Set(['textures.minecraft.net', 'textures.mojang.com']);
// 账号里存的 uuid 有两种写法：带短横线的标准形式，和不带短横线的 32 位形式，
// Mojang 接口两种都收，这里统一归一化成带短横线的形式再做后续处理。
const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const MAX_BYTES = 1024 * 1024;
const CACHE_MS = 6 * 60 * 60 * 1000;

function root() {
  return path.join(app.getPath('userData'), 'skins');
}

function ensureDir() {
  const dir = root();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

/** 统一成 8-4-4-4-12 小写形式；不合法时返回空串 */
function normalize(v) {
  if (!isUuid(v)) return '';
  const hex = v.toLowerCase().replace(/-/g, '');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function cachePath(uuid) {
  const id = normalize(uuid);
  return path.join(root(), `${id || 'invalid'}.png`);
}

function isPng(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length > 16 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  );
}

/** 从 profile 的 textures 属性里解出皮肤地址 */
async function textureUrl(uuid) {
  const url = `${SESSION_URL}${uuid}?unsigned=false`;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'SMUCL', Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
  } catch (e) {
    throw new Error(`拿不到皮肤信息：${e.message}`);
  }
  if (res.status === 204 || res.status === 404) throw new Error('这个账号没有皮肤（或未拥有 Java 版）');
  if (!res.ok) throw new Error(`皮肤信息请求失败：HTTP ${res.status}`);

  const profile = await res.json().catch(() => null);
  const prop = ((profile && profile.properties) || []).find((p) => p && p.name === 'textures');
  if (!prop || !prop.value) throw new Error('皮肤信息里没有 textures');

  let data;
  try {
    data = JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8'));
  } catch {
    throw new Error('皮肤信息解析失败');
  }
  const skin = data && data.textures && data.textures.SKIN && data.textures.SKIN.url;
  if (!skin) throw new Error('这个账号没有设置皮肤');

  // 只认 Mojang 的贴图域名，避免 profile 里塞了别家地址被当成图床。
  // Mojang 下发的地址目前是 http://，这里统一升级成 https。
  let host = '';
  let target;
  try {
    const u = new URL(skin);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('协议不合法');
    host = u.hostname.toLowerCase();
    if (u.protocol === 'http:') u.protocol = 'https:';
    target = u.toString();
  } catch {
    throw new Error('皮肤地址不合法');
  }
  if (!TEXTURE_HOSTS.has(host)) throw new Error('皮肤地址不在允许范围');
  return target;
}

async function download(uuid) {
  const url = await textureUrl(uuid);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'SMUCL', Accept: 'image/png' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`皮肤下载失败：HTTP ${res.status}`);

  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new Error('皮肤文件过大');

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('皮肤文件过大');
  if (!isPng(buf)) throw new Error('皮肤不是有效的 PNG');

  ensureDir();
  const dest = cachePath(uuid);
  const tmp = `${dest}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
  return dest;
}

/** 8×8 头部（含帽子层）裁成两张小图，压成 data URL */
function facesOf(buf) {
  const parts = partsOf(buf);
  return { base: parts.head, hat: parts.hat };
}

/**
 * 把一张皮肤贴图切成界面要用的几块。
 *
 * 为什么不让渲染层用 background-size 百分比自己算：
 *   老皮肤 64×32、新皮肤 64×64、高清皮肤 128×128，行高算法各不相同，
 *   用 CSS 百分比定位必然在某一代格式上错位。这里按 width/64 算好比例再裁，
 *   渲染层拿到的永远是 8×8 / 8×12 这种逻辑块，只管等比放大。
 *
 * 只切「正面」用到的部分：head / hat / body / arm / leg。
 * 旧版 64×32 贴图里没有左手左腿，渲染层把右臂右腿镜像一份即可。
 */
function partsOf(buf) {
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) throw new Error('皮肤图片无法解析');
  const { width, height } = img.getSize();
  if (!width || width < 64 || width % 64 !== 0) throw new Error('皮肤宽度必须是 64 的倍数（如 64、128）');

  const k = width / 64;
  const h = Math.round(height / k); // 归一到 64 宽基准后的高度
  if (h !== 64 && h !== 32) throw new Error('皮肤高度必须是 64 或 32（按 64 宽基准计算）');

  const crop = (x, y, w, hh) =>
    `data:image/png;base64,${img
      .crop({ x: Math.round(x * k), y: Math.round(y * k), width: Math.round(w * k), height: Math.round(hh * k) })
      .toPNG()
      .toString('base64')}`;

  return {
    modern: h === 64,
    head: crop(8, 8, 8, 8),
    hat: crop(40, 8, 8, 8),
    body: crop(20, 20, 8, 12),
    arm: crop(44, 20, 4, 12),
    leg: crop(4, 20, 4, 12),
  };
}


/**
 * 取某个账号的脸。
 * @param {string} uuid 账号 UUID
 * @param {{force?: boolean}} opts force=true 时忽略缓存时效，强制重新下载
 * @returns {Promise<{base: string, hat: string}>} 两个 data URL
 */
async function face(uuid, { force = false } = {}) {
  const id = normalize(uuid);
  if (!id) throw new Error('账号 UUID 不合法');

  const file = cachePath(id);
  const cached = fs.existsSync(file);
  const fresh = cached && Date.now() - fs.statSync(file).mtimeMs < CACHE_MS;

  if (force || !fresh) {
    try {
      await download(id);
    } catch (e) {
      // 有旧缓存就先用着，换皮肤前也能正常显示
      if (!cached) throw e;
    }
  }

  const buf = fs.readFileSync(file);
  if (!isPng(buf)) {
    fs.rmSync(file, { force: true });
    throw new Error('本地皮肤缓存已损坏，已清除');
  }
  return facesOf(buf);
}

/** 退出登录时清掉本地皮肤缓存 */
function clear(uuid) {
  try {
    if (isUuid(uuid)) {
      fs.rmSync(cachePath(uuid), { force: true });
      return true;
    }
    const dir = root();
    if (!fs.existsSync(dir)) return false;
    for (const name of fs.readdirSync(dir)) {
      if (/^[0-9a-f-]{36}\.png$/i.test(name)) fs.rmSync(path.join(dir, name), { force: true });
    }
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------ 离线本地皮肤 */
/**
 * 离线账户拿不到官方贴图，只能让用户自己导入一张 PNG。
 *
 * 存法：userData/skins/local/<key>.png
 * key 由玩家名小写清洗而来——离线账户没有 UUID，名字就是唯一标识。
 * 因此改了玩家名之后旧皮肤不会自动跟过去，界面上有相应提示。
 */

function localDir() {
  const dir = path.join(root(), 'local');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 玩家名 → 安全的文件名片段；非法/空白名返回空串 */
function keyOf(name) {
  const s = String(name || '').trim().toLowerCase();
  if (!s) return '';
  return s
    .replace(/[^a-z0-9_.-]/g, '_') // 路径分隔符、盘符、Unicode 全部换掉
    .replace(/\.{2,}/g, '.') // 干掉连续的 ..，避免看着像目录穿越
    .replace(/^[._]+|[._]+$/g, '') // 首尾的点和下划线没有意义
    .slice(0, 48) || '';
}

function localPathOf(name) {
  const key = keyOf(name);
  return key ? path.join(localDir(), `${key}.png`) : '';
}

/** 导入一张本地皮肤；校验 PNG 头、体积与尺寸，落盘用临时文件避免写坏 */
function importLocal(name, srcFile) {
  const dest = localPathOf(name);
  if (!dest) throw new Error('玩家名为空，无法保存皮肤');

  const st = fs.statSync(srcFile);
  if (!st.isFile()) throw new Error('不是文件');
  if (st.size > MAX_BYTES) throw new Error('皮肤文件超过 1 MB');

  const buf = fs.readFileSync(srcFile);
  if (!isPng(buf)) throw new Error('这不是有效的 PNG 图片');
  const parts = partsOf(buf); // 尺寸不对会在这里抛错

  const tmp = `${dest}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
  return { face: { base: parts.head, hat: parts.hat }, parts };
}

/** 读本地皮肤；没有就返回 null（不抛错，调用方据此回退到首字母） */
function localSkin(name) {
  const file = localPathOf(name);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const buf = fs.readFileSync(file);
    if (!isPng(buf)) {
      fs.rmSync(file, { force: true });
      return null;
    }
    const parts = partsOf(buf);
    return { face: { base: parts.head, hat: parts.hat }, parts };
  } catch {
    return null;
  }
}

function clearLocal(name) {
  const file = localPathOf(name);
  if (!file || !fs.existsSync(file)) return false;
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  face,
  clear,
  isUuid,
  normalize,
  root,
  ensureDir,
  cachePath,
  partsOf,
  importLocal,
  localSkin,
  clearLocal,
  keyOf,
};
