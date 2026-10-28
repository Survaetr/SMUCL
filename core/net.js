'use strict';
/**
 * 网络层：JSON 拉取 + 断点安全的文件下载 + 并发池。
 * 只依赖 Node 22 内置的 fetch。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const UA = 'SMUCL/1.0 (+https://mc.sjtu.cn) Electron';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 边读边算 SHA1，避免把整个文件读进内存 */
function sha1File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function fetchJson(url, { timeout = 25000, retries = 2, raw = false, headers = {} } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: raw ? '*/*' : 'application/json', ...headers },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // raw: 拿纯文本（XML 之类），默认按 JSON 解析
      return raw ? await res.text() : await res.json();
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(400 * (i + 1));
    }
  }
  throw new Error(`请求失败 ${url} — ${lastErr && lastErr.message}`);
}

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return -1;
  }
}

/**
 * 读文件头判断是不是 zip/jar。
 * 镜像偶尔会用 200 回一个 HTML 错误页或 JSON 报错，字节数看着正常，
 * 存下来的「jar」其实一解就炸，最后表现为游戏启动十秒后崩溃。
 */
function isZipFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4);
    const n = fs.readSync(fd, head, 0, 4, 0);
    if (n < 4) return false;
    // PK\x03\x04 普通 zip；PK\x05\x06 空归档；PK\x07\x08 跨卷
    return (
      (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) ||
      (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x05 && head[3] === 0x06) ||
      (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x07 && head[3] === 0x08)
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * 下载单个文件。已存在且大小一致则跳过（增量安装的关键）。
 * 若给了 expectedSha1，则大小一致也要比对哈希，不一致就删掉重下；
 * 下载完成的临时文件在改名之前先校验，避免把损坏内容写进正式路径。
 * @param {object} opts
 * @param {boolean} [opts.expectZip] 目标是 jar/zip 时必须真的是 zip 头，否则视为失败
 * @param {number} [opts.minBytes] 体积下限，用来挡掉错误页
 * @returns {Promise<{size:number, skipped:boolean}>}
 */
async function download(url, dest, opts = {}) {
  const {
    expectedSize = 0,
    expectedSha1 = '',
    retries = 3,
    onBytes = null,
    timeout = 30000,
    expectZip = false,
    minBytes = 0,
  } = opts;
  const wantSha1 = String(expectedSha1 || '').toLowerCase();

  const existing = fileSize(dest);
  if (existing > 0 && (!expectedSize || existing === expectedSize) && (!minBytes || existing >= minBytes)) {
    let trust = true;
    if (wantSha1 && /^[0-9a-f]{40}$/.test(wantSha1)) {
      const got = await sha1File(dest).catch(() => '');
      trust = got === wantSha1;
    }
    // 没有哈希可比时（加载器的库大多没有），至少确认它是个能打开的压缩包
    if (trust && expectZip && !isZipFile(dest)) trust = false;
    if (!trust) {
      // 已有文件明显不对（残留损坏 / 镜像写进来的错误页），删掉重新下载
      try {
        await fsp.unlink(dest);
      } catch {}
    }
    if (trust) {
      if (onBytes) onBytes(existing);
      return { size: existing, skipped: true };
    }
  }

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const handle = await fsp.open(tmp, 'w');
      let received = 0;
      try {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await handle.write(value);
          received += value.length;
          if (onBytes) onBytes(value.length);
        }
      } finally {
        await handle.close();
      }

      if (wantSha1 && /^[0-9a-f]{40}$/.test(wantSha1)) {
        const got = await sha1File(tmp);
        if (got !== wantSha1) {
          throw new Error(`SHA1 校验失败（期望 ${wantSha1}，实际 ${got}）`);
        }
      }

      // 内容层面的问题重试也没用（同一个地址会再给一份同样的坏文件），
      // 直接抛给上层换源
      if (minBytes && received < minBytes) {
        const e = new Error(`内容过小（${received} 字节），可能是错误页`);
        e.noRetry = true;
        throw e;
      }
      if (expectZip && !isZipFile(tmp)) {
        const e = new Error('下载到的不是有效的 jar/zip，多半是镜像返回了错误页');
        e.noRetry = true;
        throw e;
      }

      await fsp.rename(tmp, dest);
      return { size: received, skipped: false };
    } catch (e) {
      lastErr = e;
      try {
        await fsp.unlink(tmp);
      } catch {}
      if (e && e.noRetry) break;
      if (attempt < retries) await sleep(500 * (attempt + 1));
    }
  }
  throw new Error(`下载失败 ${path.basename(dest)} — ${lastErr && lastErr.message}`);
}

/** 受控并发执行，避免把带宽和句柄打满 */
async function pool(items, limit, worker) {
  const queue = items.slice();
  const runners = new Array(Math.min(limit, queue.length)).fill(0).map(async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

module.exports = { fetchJson, download, pool, fileSize, sleep, sha1File, isZipFile, UA };
