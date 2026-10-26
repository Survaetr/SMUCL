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
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) throw new Error('皮肤图片无法解析');
  const { width } = img.getSize();
  if (!width || width < 64) throw new Error('皮肤尺寸异常');

  // 64 宽的贴图是基准；高清皮肤（128 等）按比例放大坐标
  const k = width / 64;
  const box = (x, y) => ({
    x: Math.round(x * k),
    y: Math.round(y * k),
    width: Math.round(8 * k),
    height: Math.round(8 * k),
  });
  const toUrl = (b) => `data:image/png;base64,${img.crop(b).toPNG().toString('base64')}`;

  return {
    // 头正面：8,8；帽子/发型叠加层：40,8（老皮肤 64×32 也在这个位置）
    base: toUrl(box(8, 8)),
    hat: toUrl(box(40, 8)),
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

module.exports = { face, clear, isUuid, normalize, root, ensureDir, cachePath };
