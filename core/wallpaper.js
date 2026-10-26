'use strict';
/**
 * 背景图（壁纸）。
 *
 * 用户导入的图片一律复制到 userData/wallpapers/，渲染层再通过自定义协议
 * smucl-wall://local/<文件名> 读取。之所以不直接把绝对路径丢给 CSS：
 *   - file: 一旦写进 img-src，渲染层就能加载磁盘上任意图片，等于放开一个探测口子；
 *   - 自定义协议只认「本目录 + 安全文件名」，路径穿越在校验阶段就被挡掉。
 */
const fs = require('fs');
const path = require('path');
const { app, dialog, protocol, net } = require('electron');
const { pathToFileURL } = require('url');

const SCHEME = 'smucl-wall';
const HOST = 'local';
const MAX_BYTES = 32 * 1024 * 1024; // 32 MB，4K 壁纸足够
const NAME_RE = /^wall-[0-9]{10,16}\.(png|jpg|webp|gif|bmp|avif)$/;

function root() {
  return path.join(app.getPath('userData'), 'wallpapers');
}

function ensureDir() {
  const dir = root();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 只接受本模块自己生成的文件名，天然挡掉 .. 与路径分隔符 */
function isManaged(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

function exists(name) {
  if (!isManaged(name)) return false;
  try {
    return fs.statSync(path.join(root(), name)).isFile();
  } catch {
    return false;
  }
}

function urlFor(name) {
  return isManaged(name) ? `${SCHEME}://${HOST}/${name}` : '';
}

/** 读前 16 字节判真实类型，防止把改了扩展名的文件塞进来 */
function sniff(file) {
  let head;
  try {
    const fd = fs.openSync(file, 'r');
    head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
  } catch {
    return '';
  }
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg';
  if (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (head.toString('ascii', 0, 3) === 'GIF') return 'gif';
  if (head[0] === 0x42 && head[1] === 0x4d) return 'bmp';
  if (head.toString('ascii', 4, 8) === 'ftyp') return 'avif'; // heif / avif 家族
  return '';
}

/** 删掉除 keep 之外的历史图片，避免 userData 越堆越大 */
function prune(keep) {
  let removed = 0;
  let names = [];
  try {
    names = fs.readdirSync(root());
  } catch {
    return 0;
  }
  for (const name of names) {
    if (name === keep) continue;
    if (!/^wall-[0-9]{10,16}\.[a-z]+$/.test(name)) continue;
    try {
      fs.unlinkSync(path.join(root(), name));
      removed += 1;
    } catch {
      /* 占用中，下次再清 */
    }
  }
  return removed;
}

/**
 * 导入一张图片：校验 → 复制进 userData → 清理旧图。
 * 返回 { name, url, size, kept }，文件名由本模块决定（扩展名按实际内容取）。
 */
function importFile(src) {
  const file = path.resolve(String(src || ''));
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new Error('图片不存在或无法读取');
  }
  if (!stat.isFile()) throw new Error('请选择一张图片');
  if (stat.size > MAX_BYTES) {
    throw new Error(`图片过大（${(stat.size / 1024 / 1024).toFixed(1)} MB），上限 32 MB`);
  }
  if (stat.size < 128) throw new Error('文件内容异常，可能不是图片');

  const kind = sniff(file);
  if (!kind) throw new Error('无法识别的图片格式，请使用 PNG / JPG / WebP / GIF / BMP');

  const dir = ensureDir();
  const name = `wall-${Date.now()}.${kind}`;
  const dest = path.join(dir, name);
  const tmp = `${dest}.part`;
  try {
    fs.copyFileSync(file, tmp);
    fs.renameSync(tmp, dest);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw new Error(`复制图片失败：${e.message}`);
  }
  const removed = prune(name);
  return { name, url: urlFor(name), size: stat.size, removed };
}

/** 弹出文件选择框；取消返回 null */
async function pick(parent) {
  const r = await dialog.showOpenDialog(parent, {
    title: '选择背景图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return importFile(r.filePaths[0]);
}

/** 清空所有已导入的图片 */
function clearAll() {
  return prune('');
}

// ------------------------------------------------------------------ 协议
// 必须在 app ready 之前调用一次
function registerScheme() {
  // 单元测试用最小 electron 桩加载 main.js，没有 protocol 模块，直接跳过
  if (!protocol || typeof protocol.registerSchemesAsPrivileged !== 'function') return;
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: false, bypassCSP: false },
    },
  ]);
}

// app ready 之后注册处理器
function registerHandler() {
  if (!protocol || typeof protocol.handle !== 'function') return;
  protocol.handle(SCHEME, async (req) => {
    try {
      const u = new URL(req.url);
      const name = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
      if (u.host !== HOST || !isManaged(name)) {
        return new Response('forbidden', { status: 403 });
      }
      const file = path.join(root(), name);
      if (!fs.existsSync(file)) return new Response('not found', { status: 404 });
      return net.fetch(pathToFileURL(file).href);
    } catch (e) {
      return new Response(`error: ${e.message}`, { status: 400 });
    }
  });
}

module.exports = {
  SCHEME,
  MAX_BYTES,
  root,
  ensureDir,
  isManaged,
  exists,
  urlFor,
  importFile,
  pick,
  clearAll,
  registerScheme,
  registerHandler,
};
