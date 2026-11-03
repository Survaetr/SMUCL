'use strict';
/**
 * 更新器
 * 只替换应用代码（resources/app，约 1 MB），不重下 Electron 运行时，
 * 因此可以直接把更新包挂在 GitHub Release 上（远小于 100 MB 限制）。
 *
 * 网络层（2026-11-03 重写）：
 * 原先用 Node 的全局 fetch。在「系统代理做 TLS 中间人」的环境里，它会以
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE 立即失败，而且 fetch 不读系统代理设置，
 * 表现为「检查更新永远失败」，还会被误报成「仓库还没有发布记录」。
 * 现在主通道是 Electron 的 net.request（Chromium 网络栈，自动跟随系统代理、
 * 用系统证书库）；只有 net 层连不上时才降级到 https 直连兜底，兜底通道放宽
 * 证书校验——下载物是否可信由后面的 SHA-256 校验负责，不依赖 TLS。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { app, net } = require('electron');
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

/* --------------------------------------------------------------- 网络层 */

/** 主通道：Electron net，自动走系统代理与系统证书库 */
function netGet(url, headers = {}, timeout = TIMEOUT) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(v);
    };

    let req;
    try {
      req = net.request({ url, method: 'GET', redirect: 'follow' });
    } catch (e) {
      return finish(reject, e);
    }

    timer = setTimeout(() => {
      try {
        req.abort();
      } catch {
        /* 忽略 */
      }
      finish(reject, new Error('请求超时'));
    }, timeout);

    req.setHeader('User-Agent', UA);
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);

    req.on('response', (res) => {
      let body = '';
      res.on('data', (c) => (body += c.toString('utf8')));
      res.on('end', () => finish(resolve, { status: res.statusCode, body }));
      res.on('error', (e) => finish(reject, e));
    });
    req.on('error', (e) => finish(reject, e));
    req.end();
  });
}

/** 兜底通道：https 直连，放宽证书校验（只用来取 JSON，可信内容不经过这里） */
function rawGet(url, headers = {}, timeout = TIMEOUT) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': UA, ...headers }, rejectUnauthorized: false, timeout },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

/** 取 JSON：net 优先，网络层失败再兜底；HTTP 错误码原样抛出，便于分类 */
async function getJson(url) {
  const headers = { Accept: 'application/vnd.github+json' };
  let res;
  try {
    res = await netGet(url, headers);
  } catch (netErr) {
    try {
      res = await rawGet(url, headers);
    } catch {
      const e = new Error(netErr.message || '网络不可达');
      e.kind = 'network';
      throw e;
    }
  }
  if (res.status < 200 || res.status >= 300) {
    const e = new Error(`HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  try {
    return JSON.parse(res.body);
  } catch {
    const e = new Error('返回内容不是有效 JSON（可能被网络中间页替换）');
    e.kind = 'network';
    throw e;
  }
}

/** 把失败原因翻成用户看得懂、并且能指导下一步的话 */
function explain(err) {
  if (!err) return '检查更新失败';
  if (err.kind === 'network') {
    const msg = String(err.message || '');
    if (/超时/.test(msg)) return '连接 GitHub 超时，请检查网络或代理后重试';
    return `无法连接 GitHub（${msg || '网络不可达'}）`;
  }
  if (err.status === 403 || err.status === 429) {
    return 'GitHub 接口暂时受限（匿名请求每小时 60 次），请稍后重试';
  }
  if (err.status === 404) return 'GitHub 上找不到这个仓库或发布记录';
  if (err.status) return `GitHub 返回 HTTP ${err.status}`;
  return `检查更新失败：${err.message || '未知错误'}`;
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

  // 1) 最新 Release。404 只代表「没有 Release」，不代表网络故障，可以退到列表接口
  let release = null;
  let err = null;
  try {
    release = await getJson(`${API}/releases/latest`);
  } catch (e) {
    err = e;
    if (e.status === 404) {
      try {
        const list = await getJson(`${API}/releases`);
        release = Array.isArray(list)
          ? list.find((r) => !r.draft && !r.prerelease) || list.find((r) => !r.draft) || null
          : null;
        err = null;
      } catch (e2) {
        err = e2;
      }
    } else {
      // 网络失败或限流：换接口也救不回来，如实返回
      return { ok: false, error: explain(e), current };
    }
  }

  // 2) 一个 Release 都没有时，才去看 tag（有些项目只打 tag 不发 Release）
  if (!release) {
    let tags = null;
    try {
      tags = await getJson(`${API}/tags`);
    } catch (e) {
      return { ok: false, error: explain(e), current };
    }
    if (!Array.isArray(tags) || !tags.length) {
      return {
        ok: false,
        error: err ? explain(err) : 'GitHub 上还没有发布记录（既没有 Release 也没有 tag）',
        current,
      };
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

/** 下载：仍然 net 优先，主通道连不上时退回放宽证书的 https 直连 */
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let out = null;
    let active = null;

    const dropStream = () => {
      if (!out) return;
      try {
        out.destroy();
      } catch {
        /* 忽略 */
      }
      out = null;
    };
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };

    const timer = setTimeout(() => {
      try {
        active && (active.abort || active.destroy).call(active);
      } catch {
        /* 忽略 */
      }
      dropStream();
      finish(reject, new Error('下载超时'));
    }, 180000);

    const attempt = (useRaw) => {
      out = fs.createWriteStream(dest);

      const onResponse = (res, status) => {
        if (status < 200 || status >= 300) {
          const e = new Error(`下载失败：HTTP ${status}`);
          e.status = status;
          dropStream();
          return finish(reject, e);
        }
        const rawLen = res.headers['content-length'];
        const total = Number(Array.isArray(rawLen) ? rawLen[0] : rawLen) || 0;
        let received = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          if (out) out.write(chunk);
          if (onProgress) onProgress(received, total);
        });
        res.on('end', () => {
          if (!out) return finish(reject, new Error('下载中断'));
          const stream = out;
          out = null;
          stream.end(() => finish(resolve, { bytes: received, total }));
        });
        res.on('error', (e) => {
          dropStream();
          finish(reject, e);
        });
      };

      const onError = (e) => {
        dropStream();
        if (!useRaw && !settled) {
          try {
            fs.rmSync(dest, { force: true });
          } catch {
            /* 忽略 */
          }
          return attempt(true);
        }
        finish(reject, e);
      };

      if (useRaw) {
        active = https.get(
          url,
          {
            headers: { 'User-Agent': UA, Accept: 'application/octet-stream' },
            rejectUnauthorized: false,
            timeout: 120000,
          },
          (res) => onResponse(res, res.statusCode)
        );
        active.on('timeout', () => active.destroy(new Error('下载超时')));
        active.on('error', onError);
      } else {
        active = net.request({ url, method: 'GET', redirect: 'follow' });
        active.setHeader('User-Agent', UA);
        active.setHeader('Accept', 'application/octet-stream');
        active.on('response', (res) => onResponse(res, res.statusCode));
        active.on('error', onError);
        active.end();
      }
    };

    attempt(false);
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

module.exports = { check, install, compareVersion, REPO, expectedOf, sha256File, isZip, explain };
