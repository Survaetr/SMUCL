'use strict';
/**
 * 更新器
 * 只替换应用代码（resources/app，约 1 MB），不重下 Electron 运行时，
 * 因此可以直接把更新包挂在 GitHub Release 上（远小于 100 MB 限制）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { app } = require('electron');
const AdmZip = require('adm-zip');

const REPO = 'Survaetr/SMUCL';
const API = `https://api.github.com/repos/${REPO}`;
const UA = 'SMUCL-Updater';
const TIMEOUT = 15000;

function versionParts(v) {
  return String(v || '')
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((n) => parseInt(n, 10) || 0);
}

/** 返回 a>b 为正，a<b 为负 */
function compareVersion(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function pickAsset(assets) {
  const list = assets || [];
  // 优先取与当前版本无关的通用命名 app-*.zip
  return (
    list.find((a) => /^app-.*\.zip$/i.test(a.name)) ||
    list.find((a) => /^app\.zip$/i.test(a.name)) ||
    null
  );
}

/**
 * 检查 GitHub 上的最新版本
 * @returns {Promise<{ok:boolean, current?:string, latest?:string, hasUpdate?:boolean, notes?:string, url?:string, asset?:object, error?:string, source?:string}>}
 */
async function check() {
  const current = app.getVersion();
  try {
    let release = null;
    try {
      release = await getJson(`${API}/releases/latest`);
    } catch {
      const list = await getJson(`${API}/releases`).catch(() => []);
      release = Array.isArray(list) ? list.find((r) => !r.draft && !r.prerelease) || list.find((r) => !r.draft) : null;
    }

    if (!release) {
      const tags = await getJson(`${API}/tags`).catch(() => []);
      if (!Array.isArray(tags) || !tags.length) {
        return { ok: false, error: '仓库还没有发布记录' };
      }
      const latest = String(tags[0].name || '').replace(/^v/i, '');
      return {
        ok: true,
        source: 'tag',
        current,
        latest,
        hasUpdate: compareVersion(latest, current) > 0,
        notes: '',
        url: `https://github.com/${REPO}/releases`,
        asset: null,
      };
    }

    const latest = String(release.tag_name || release.name || '').replace(/^v/i, '');
    const asset = pickAsset(release.assets);
    return {
      ok: true,
      source: 'release',
      current,
      latest,
      hasUpdate: compareVersion(latest, current) > 0,
      notes: release.body || '',
      name: release.name || `v${latest}`,
      published: release.published_at || null,
      url: release.html_url,
      asset,
      expect: asset ? expectedOf(asset, release.body) : null,
    };
  } catch (e) {
    return { ok: false, error: `无法连接 GitHub：${e.message}` };
  }
}

/**
 * 校验信息。
 * GitHub 从 2025 年起在资产上直接给出 digest（形如 sha256:...），有就优先用；
 * 没有则退回发布说明里的 `sha256(app-1.2.3.zip)=...` 行。两者都没有时
 * 至少做「大小 + zip 头」两道检查——这能挡住半截下载与镜像错误页，
 * 而这两类恰恰是自动更新最常见的事故。
 */
function expectedOf(asset, body) {
  const out = { size: Number(asset && asset.size) || 0, sha256: '' };
  const digest = String((asset && asset.digest) || '');
  const m = /^sha256:([0-9a-f]{64})$/i.exec(digest);
  if (m) out.sha256 = m[1].toLowerCase();
  if (!out.sha256 && body) {
    const name = String(asset && asset.name ? asset.name : '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`sha256\\s*\\(\\s*${name}\\s*\\)\\s*[=:]\\s*([0-9a-f]{64})`, 'i');
    const hit = re.exec(String(body));
    if (hit) out.sha256 = hit[1].toLowerCase();
  }
  return out;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const st = fs.createReadStream(file);
    st.on('data', (c) => h.update(c));
    st.on('error', reject);
    st.on('end', () => resolve(h.digest('hex')));
  });
}

/** zip 头判断：镜像或代理出错时常返回 200 与一段 HTML */
function isZip(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  } catch {
    return false;
  }
}

/** 手写递归复制：本机 Electron 的 Node 上 fs.cpSync 有静默崩溃记录，不用它 */
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, ent.name);
    const dst = path.join(to, ent.name);
    if (ent.isDirectory()) copyTree(src, dst);
    else if (ent.isFile()) fs.copyFileSync(src, dst);
  }
}

function downloadFile(url, dest, onProgress) {
  return new Promise(async (resolve, reject) => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120000);
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/octet-stream' },
        redirect: 'follow',
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const total = Number(res.headers.get('content-length') || 0);
      const out = fs.createWriteStream(dest);
      let received = 0;

      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        out.write(Buffer.from(value));
        if (onProgress) onProgress(received, total);
      }
      out.end(() => {
        clearTimeout(timer);
        resolve({ bytes: received, total });
      });
    } catch (e) {
      reject(e);
    }
  });
}

/** 当前应用代码目录（打包后为 resources/app） */
function appCodeDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'app');
  return path.join(__dirname, '..');
}

/**
 * 下载并安装更新包
 * @param {object} asset {name,url,size}
 * @param {(received:number,total:number)=>void} onProgress
 */
async function install(asset, onProgress, expect) {
  if (!app.isPackaged) {
    throw new Error('开发模式下不支持自动替换，请查看发布页');
  }
  if (!asset || !asset.url) throw new Error('该版本没有提供可自动更新的安装包');

  const stamp = Date.now();
  const tmpZip = path.join(os.tmpdir(), `smucl-update-${stamp}.zip`);
  const tmpDir = path.join(os.tmpdir(), `smucl-update-${stamp}`);

  const got = await downloadFile(asset.url, tmpZip, onProgress);

  // ---- 校验三步：大小 → zip 头 → 摘要（摘要缺失时跳过最后一步）
  const want = expect || expectedOf(asset, '');
  const realSize = (() => {
    try {
      return fs.statSync(tmpZip).size;
    } catch {
      return 0;
    }
  })();
  const fail = (msg) => {
    try {
      fs.rmSync(tmpZip, { force: true });
    } catch {
      /* 忽略 */
    }
    throw new Error(`更新包校验失败：${msg}`);
  };
  if (want.size && realSize !== want.size) fail(`大小不符（期望 ${want.size} 字节，实际 ${realSize} 字节）`);
  if (!isZip(tmpZip)) fail('文件不是有效的 zip');
  if (want.sha256) {
    if (onProgress) onProgress(realSize || got.bytes, realSize || got.total, '正在校验');
    const sum = await sha256File(tmpZip);
    if (sum !== want.sha256) fail('摘要与发布记录不一致');
  }

  const zip = new AdmZip(tmpZip);
  zip.extractAllTo(tmpDir, true);

  // 兼容两种打包结构：zip 根目录直接是 app 内容，或外面套一层 app/
  let src = tmpDir;
  if (!fs.existsSync(path.join(src, 'main.js'))) {
    const nested = path.join(tmpDir, 'app');
    if (fs.existsSync(path.join(nested, 'main.js'))) src = nested;
  }
  if (!fs.existsSync(path.join(src, 'main.js'))) {
    throw new Error('更新包结构异常（缺少 main.js）');
  }

  const target = appCodeDir();
  copyTree(src, target);

  // 清理临时文件
  setTimeout(() => {
    try {
      fs.rmSync(tmpZip, { force: true });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }, 3000);

  return { target, version: app.getVersion() };
}

module.exports = { check, install, compareVersion, REPO, expectedOf, sha256File, isZip };
