'use strict';
/**
 * 依赖自检与补全。
 *
 * 典型现场：Java 在启动瞬间报
 *   「找不到或无法加载主类 net.neoforged.fml.startup.Client」
 *   「java.lang.ClassNotFoundException: net.neoforged.fml.startup.Client」
 * 版本 JSON 本身是好的，但 libraries/ 里少了某几个 jar（拷贝实例时没带库、
 * 下载中断、或者换了游戏目录），而启动参数只收录「磁盘上确实存在的文件」，
 * 于是主类凭空消失，报错信息完全指不到真正的原因。
 *
 * 这里在启动前把 JSON 声明的库和磁盘对一遍，缺的直接从镜像补回来；
 * 补完再扫一遍 classpath，确认主类真的在某个 jar 里。
 */
const fs = require('fs');
const path = require('path');

const net = require('./net');
const mirror = require('./mirror');
const versionLib = require('./version');
const installLib = require('./install');
const launchLib = require('./launch');

const BMCL = 'https://bmclapi2.bangbang93.com';

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
}

function isPresent(t) {
  const size = sizeOf(t.dest);
  if (size <= 0) return false; // 不存在，或占位了个 0 字节的空文件
  if (t.size && size < t.size) return false; // 下载中断留下的半截文件
  // 镜像有时用 200 回一份 HTML 错误页，字节数看着正常但一解就炸，
  // 游戏会在启动十秒后崩掉且日志完全指不到原因。
  // jar/zip 必须真的是压缩包（PK 头），否则按缺失处理，由 fix() 换源重下。
  if (/\.(jar|zip)$/i.test(t.dest) && !net.isZipFile(t.dest)) return false;
  return true;
}

/**
 * 一个文件给多个候选地址：
 *   BMCL 镜像 → 声明的官方地址 → Maven Central
 * 实测 maven.neoforged.net 在部分网络下被 DNS 污染，镜像反而是唯一能通的。
 */
function candidateUrls(declared, rel) {
  const list = [];
  const add = (u) => {
    if (u && !list.includes(u)) list.push(u);
  };
  add(`${BMCL}/maven/${rel}`);
  add(mirror.rewrite(declared, 'bmcl'));
  add(declared);
  add(`https://repo1.maven.org/maven2/${rel}`);
  return list;
}

/** 汇总这个版本（含继承链）需要的全部库文件 */
function collect(mcDir, id) {
  const meta = versionLib.loadVersionJson(mcDir, id);
  const versionDir = path.join(mcDir, 'versions', id);
  const libRoot = path.join(mcDir, 'libraries');
  const tasks = [];

  for (const t of installLib.collectTasks(meta, mcDir, versionDir, 'bmcl')) {
    if (!t.dest) continue;
    // 别的架构的 natives 不必补：classpath 本来就不会收录它们
    if (!launchLib.nativesAllowed(t.name)) continue;
    const rel = path.relative(libRoot, t.dest).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..')) continue; // 只处理 libraries/ 内的文件
    tasks.push({ ...t, rel, urls: candidateUrls(t.url, rel) });
  }

  // 客户端 jar 单独看：加载器实例里它就是原版 client.jar，缺了同样启动不了
  const client = meta.downloads && meta.downloads.client;
  if (client && client.url) {
    const dest = launchLib.resolveClientJar(mcDir, id, meta);
    const rel = path.relative(libRoot, dest).replace(/\\/g, '/');
    tasks.push({
      url: client.url,
      dest,
      size: client.size || 0,
      sha1: client.sha1 || '',
      kind: 'client',
      name: 'client.jar',
      rel: rel.startsWith('..') ? path.basename(dest) : rel,
      urls: candidateUrls(client.url, rel.startsWith('..') ? path.basename(dest) : rel).map((u) =>
        // client.jar 不在 maven 布局里，镜像地址要走 objects 而不是 /maven/
        u.replace(`${BMCL}/maven/${rel}`, mirror.rewrite(client.url, 'bmcl'))
      ),
    });
  }

  return { meta, versionDir, tasks };
}

/** 只检查，不下载 */
function check(mcDir, id) {
  const { meta, tasks } = collect(mcDir, id);
  const missing = tasks.filter((t) => !isPresent(t));
  return { id, total: tasks.length, missing, meta };
}

/**
 * 补全缺失文件
 * @returns {Promise<{total:number, fixed:number, remaining:Array, failed:Array, diagnose:object}>}
 */
async function fix(mcDir, id, onProgress) {
  const { missing } = check(mcDir, id);
  if (!missing.length) return { total: 0, fixed: 0, remaining: [], failed: [], diagnose: diagnose(mcDir, id) };

  let done = 0;
  let fixed = 0;
  const failed = [];

  await net.pool(missing, 3, async (t) => {
    let lastErr = null;
    const isJar = /\.(jar|zip)$/i.test(t.dest);
    for (const url of t.urls) {
      try {
        await net.download(url, t.dest, {
          expectedSize: t.size || 0,
          expectedSha1: t.sha1 || '',
          expectZip: isJar,
          retries: 1,
          timeout: 60000,
        });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    // 镜像比 JSON 落后导致大小对不上时，只要文件真下下来了就别卡住启动
    if (lastErr && !isPresent(t)) {
      failed.push({ rel: t.rel, name: t.name, error: lastErr.message });
    } else {
      fixed += 1;
    }
    done += 1;
    if (onProgress) onProgress({ done, total: missing.length, rel: t.rel });
  });

  const after = check(mcDir, id);
  return {
    total: missing.length,
    fixed,
    // 只回传必要字段：整个 task 带着候选地址，IPC 里没必要来回搬
    remaining: after.missing.map((t) => ({ rel: t.rel, name: t.name })),
    failed,
    diagnose: diagnose(mcDir, id),
  };
}

/* ------------------------------------------------------------------ 主类自检 */

/**
 * 只读 zip 尾部：定位 EOCD → 取中央目录 → 在目录里找入口名。
 * 比 adm-zip 省事的地方在于完全不碰文件内容，几 MB 的 jar 也只读几十 KB。
 */
function zipHasEntry(file, entryName) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < 22) return false;

    const tailLen = Math.min(size, 66000);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return false;

    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (!cdSize || cdOffset + cdSize > size) return false;

    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    return cd.includes(Buffer.from(entryName, 'latin1'));
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

/** 主类是否真的躺在 classpath 的某个 jar 里 */
function diagnose(mcDir, id) {
  try {
    const meta = versionLib.loadVersionJson(mcDir, id);
    const mainClass = String(meta.mainClass || '');
    if (!mainClass) return { mainClass: '', found: true, jar: null, classpath: 0 };
    const { classpath: libs } = launchLib.libraryEntries(meta, mcDir);
    // 原版的主类在客户端 jar 里，它不在 libraries/ 下，得单独带上
    const clientJar = launchLib.resolveClientJar(mcDir, id, meta);
    const classpath = fs.existsSync(clientJar) ? [clientJar, ...libs] : libs;
    const entry = `${mainClass.replace(/\./g, '/')}.class`;
    const jar = classpath.find((p) => zipHasEntry(p, entry)) || null;
    return { mainClass, found: Boolean(jar), jar, classpath: classpath.length };
  } catch (e) {
    return { mainClass: '', found: true, jar: null, classpath: 0, error: e.message };
  }
}

/** 把 maven 相对路径还原成坐标，用于给用户看的报错 */
function coordOf(rel) {
  const m = String(rel || '').match(/^(.+?)\/([^/]+)\/([^/]+)\/([^/]+)\.jar$/);
  if (!m) return rel;
  return `${m[1].replace(/\//g, '.')}:${m[2]}:${m[3]}${m[4].includes(m[2]) ? '' : `:${m[4]}`}`;
}

module.exports = { check, fix, diagnose, zipHasEntry, coordOf };
