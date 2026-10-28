'use strict';
/**
 * 模组加载器安装
 *
 * Fabric / Quilt：官方 meta 接口直接返回一份完整的版本 JSON（含 mainClass 与 libraries），
 *   写进 versions/<id>/<id>.json 再把库下下来即可，全程不需要 Java。
 *
 * Forge / NeoForge：没有纯 JSON 方案，必须下载官方 installer.jar 并执行
 *   `java -jar installer.jar --installClient <游戏目录>`，由它跑完 processors 生成补丁后的客户端 jar。
 *   installer 还要求目录里存在 launcher_profiles.json，否则直接拒绝安装。
 *
 * 双源：bmcl（BMCLAPI 镜像，默认） / mojang（官方）。
 * 实测 maven.neoforged.net 在部分网络下会被 DNS 污染（解析到 31.13.84.2），官方源基本不可用。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const net = require('./net');

const BMCL = 'https://bmclapi2.bangbang93.com';

const PROVIDERS = {
  fabric: {
    label: 'Fabric',
    kind: 'json',
    list: (mc, src) =>
      src === 'bmcl'
        ? `${BMCL}/fabric-meta/v2/versions/loader/${encodeURIComponent(mc)}`
        : `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mc)}`,
    profile: (mc, lv, src) =>
      src === 'bmcl'
        ? `${BMCL}/fabric-meta/v2/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(lv)}/profile/json`
        : `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(lv)}/profile/json`,
    libBase: (src) => (src === 'bmcl' ? `${BMCL}/maven/` : 'https://maven.fabricmc.net/'),
    rewrite: (url, src) =>
      src === 'bmcl' && url.includes('maven.fabricmc.net')
        ? url.replace(/^https?:\/\/maven\.fabricmc\.net\/?/, `${BMCL}/maven/`)
        : url,
  },
  quilt: {
    label: 'Quilt',
    kind: 'json',
    // BMCLAPI 没有镜像 Quilt，只能走官方
    list: (mc) => `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mc)}`,
    profile: (mc, lv) =>
      `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(lv)}/profile/json`,
    libBase: () => 'https://maven.quiltmc.org/repository/release/',
    rewrite: (url) => url,
  },
  forge: {
    label: 'Forge',
    kind: 'installer',
    list: (mc, src) =>
      src === 'bmcl'
        ? `${BMCL}/forge/minecraft/${encodeURIComponent(mc)}`
        : 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml',
    installer: (mc, lv, src) =>
      src === 'bmcl'
        ? `${BMCL}/maven/net/minecraftforge/forge/${mc}-${lv}/forge-${mc}-${lv}-installer.jar`
        : `https://maven.minecraftforge.net/net/minecraftforge/forge/${mc}-${lv}/forge-${mc}-${lv}-installer.jar`,
  },
  neoforge: {
    label: 'NeoForge',
    kind: 'installer',
    list: (mc, src) =>
      src === 'bmcl'
        ? `${BMCL}/neoforge/list/${encodeURIComponent(mc)}`
        : 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml',
    installer: (mc, lv, src) =>
      src === 'bmcl'
        ? `${BMCL}/maven/net/neoforged/neoforge/${lv}/neoforge-${lv}-installer.jar`
        : `https://maven.neoforged.net/releases/net/neoforged/neoforge/${lv}/neoforge-${lv}-installer.jar`,
  },
};

function parseXmlVersions(xml) {
  return Array.from(String(xml).matchAll(/<version>([^<]+)<\/version>/g)).map((m) => m[1].trim());
}

/** NeoForge 版本号形如 21.1.234，对应 MC 1.21.1 */
function neoforgeMatches(mc, ver) {
  const base = mc.replace(/^1\./, '');
  return ver === base || ver.startsWith(base + '.');
}

/** 版本号降序比较（按数字段） */
function compareVer(a, b) {
  const pa = String(a).split(/[^\d]+/).filter(Boolean).map(Number);
  const pb = String(b).split(/[^\d]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** 版本号里带 beta / alpha / rc / pre 的都算预发布版 */
const PRERELEASE = /(?:^|[-._])?(beta|alpha|pre|rc)\d*/i;

function isStableVersion(ver) {
  return !PRERELEASE.test(String(ver));
}

/** 把不同来源的返回统一成 [{version, stable}]，新的在前，正式版永远排在预发布版前面 */
function normalizeList(loader, mc, data, src) {
  const p = PROVIDERS[loader];

  if (p.kind === 'json') {
    return (Array.isArray(data) ? data : [])
      .map((x) => ({
        version: x.loader && x.loader.version,
        stable: Boolean(x.loader && x.loader.stable),
      }))
      .filter((x) => x.version);
  }

  if (src === 'bmcl') {
    return (Array.isArray(data) ? data : [])
      .map((x) => ({ version: x.version, stable: isStableVersion(x.version) }))
      .filter((x) => x.version && (loader === 'neoforge' ? neoforgeMatches(mc, x.version) : true))
      // 以前把镜像返回的所有版本都当成正式版，预发布版会被排在第一位并被默认选中，
      // 装出来的实例启动就崩，用户只能靠换官方源碰运气
      .sort((a, b) => (a.stable === b.stable ? compareVer(a.version, b.version) : a.stable ? -1 : 1));
  }

  // 官方 maven-metadata.xml：版本号带 MC 前缀
  const prefix = loader === 'forge' ? `${mc}-` : mc.replace(/^1\./, '') + '.';
  return parseXmlVersions(data)
    .filter((v) => (loader === 'forge' ? v.startsWith(prefix) : neoforgeMatches(mc, v)))
    .map((v) => ({ version: loader === 'forge' ? v.slice(prefix.length) : v, stable: isStableVersion(v) }))
    .reverse()
    .sort((a, b) => (a.stable === b.stable ? 0 : a.stable ? -1 : 1));
}

/**
 * 列出版本。主源拿不到（网络拦截 / 镜像缺这个版本 / 返回空列表）时自动换另一个源，
 * 只有两边都失败才报错——以前镜像抽风就直接告诉用户「没有适用于 X 的版本」，
 * 用户完全不知道换个源就能装。
 */
async function listVersions(loader, mcVersion, source = 'bmcl') {
  const p = PROVIDERS[loader];
  if (!p) return { ok: false, error: `未知的加载器：${loader}` };
  if (!mcVersion) return { ok: false, error: '请先选择游戏版本' };

  const first = loader === 'quilt' ? 'mojang' : source;
  const sources = first === 'bmcl' ? ['bmcl', 'mojang'] : ['mojang', 'bmcl'];
  const problems = [];

  for (const src of sources) {
    try {
      const data = await net.fetchJson(p.list(mcVersion, src), {
        raw: p.kind === 'installer' && src !== 'bmcl',
        timeout: 20000,
      });
      const list = normalizeList(loader, mcVersion, data, src).slice(0, 80);
      if (list.length) {
        const label = (s) => (s === 'bmcl' ? '镜像' : '官方源');
        return {
          ok: true,
          data: list,
          source: src,
          fallback: src !== first,
          note: src !== first ? `${label(first)}没有返回结果，已自动改用${label(src)}` : '',
        };
      }
      problems.push(`${src === 'bmcl' ? '镜像' : '官方源'}：没有 ${mcVersion} 的版本`);
    } catch (e) {
      problems.push(`${src === 'bmcl' ? '镜像' : '官方源'}：${e.message}`);
    }
  }

  return {
    ok: false,
    error: `${p.label} 没有已发布的 ${mcVersion} 版本（已试过${sources.map((s) => (s === 'bmcl' ? '镜像' : '官方源')).join('和')}）`,
    detail: problems.join('；'),
  };
}

/** group:artifact:version[:classifier][@ext] → 相对路径 */
function mavenRel(name) {
  const [coord, ext] = String(name).split('@');
  const [group, artifact, version, classifier] = coord.split(':');
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${ext || 'jar'}`;
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`;
}

function libraryUrl(lib, provider, src) {
  if (lib.downloads && lib.downloads.artifact && lib.downloads.artifact.url) {
    return { url: provider.rewrite(lib.downloads.artifact.url, src), rel: lib.downloads.artifact.path };
  }
  const rel = mavenRel(lib.name);
  const root = provider.rewrite((lib.url || provider.libBase(src)).replace(/\/?$/, '/'), src);
  return { url: root + rel, rel };
}

/**
 * 一个依赖给出多个候选地址：
 *   镜像地址 → 声明的官方地址 → Maven Central
 * 镜像偶尔缺件或抽风，靠回退把成功率拉回来（asm、guava 这类公共库 Central 一定有）
 */
function candidateUrls(lib, provider, src, rel, primary) {
  const list = [primary];
  const declared =
    (lib.downloads && lib.downloads.artifact && lib.downloads.artifact.url) ||
    (lib.url ? String(lib.url).replace(/\/?$/, '/') + rel : '');
  if (declared && !list.includes(declared)) list.push(declared);
  const central = `https://repo1.maven.org/maven2/${rel}`;
  if (!list.includes(central)) list.push(central);
  return list;
}

async function downloadLibraries(libs, gameDir, provider, src, onProgress) {
  const tasks = [];
  for (const lib of libs || []) {
    if (!lib.name) continue;
    const { url, rel } = libraryUrl(lib, provider, src);
    const art = (lib.downloads && lib.downloads.artifact) || {};
    tasks.push({
      urls: candidateUrls(lib, provider, src, rel, url),
      dest: path.join(gameDir, 'libraries', rel),
      name: lib.name,
      // 加载器的库大多没有 sha1，退而求其次校验 zip 头：
      // 镜像返回 HTML 错误页时会被这里挡下来并自动换源
      sha1: art.sha1 || '',
      isJar: /\.jar$/i.test(rel),
    });
  }

  let done = 0;
  const failed = [];
  // 并发别开太大：海外 maven + 镜像混用，8 路容易互相挤掉超时
  await net.pool(tasks, 4, async (t) => {
    let lastErr = null;
    for (const u of t.urls) {
      try {
        await net.download(u, t.dest, {
          expectedSha1: t.sha1,
          expectZip: t.isJar,
          minBytes: 512,
          retries: 1,
          timeout: 45000,
        });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) failed.push({ name: t.name, error: lastErr.message });
    done++;
    if (onProgress && (done % 3 === 0 || done === tasks.length)) {
      onProgress({ stage: 'libs', done, total: tasks.length });
    }
  });

  return { total: tasks.length, failed };
}

/** Fabric / Quilt：纯 HTTP 安装 */
async function installJson(loader, mcVersion, loaderVersion, gameDir, src, onProgress) {
  const p = PROVIDERS[loader];
  const report = (patch) => onProgress && onProgress(patch);

  report({ stage: 'meta', message: `获取 ${p.label} ${loaderVersion} 信息` });
  const profile = await net.fetchJson(p.profile(mcVersion, loaderVersion, src), { timeout: 25000 });
  if (!profile || !profile.id) throw new Error('接口返回的版本信息不完整');

  const id = profile.id;
  const dir = path.join(gameDir, 'versions', id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${id}.json`), JSON.stringify(profile, null, 2), 'utf8');

  report({ stage: 'libs', message: `下载 ${p.label} 依赖库` });
  const { total, failed } = await downloadLibraries(profile.libraries, gameDir, p, src, report);
  if (failed.length) throw new Error(`${failed.length}/${total} 个依赖库下载失败，例如 ${failed[0].name}`);

  return { id, mcVersion, loaderVersion, libs: total };
}

function probeJava(javaPath) {
  return new Promise((resolve) => {
    execFile(javaPath, ['-version'], { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: err.message });
      const m = (String(stderr) + String(stdout)).match(/version "([^"]+)"/);
      resolve({ ok: true, version: m ? m[1] : '' });
    });
  });
}

/** 把安装器常见的几句英文翻译成能照着做的中文 */
function explainInstallerFailure(text) {
  const s = String(text || '');
  if (/Invalid or corrupt jarfile|no main manifest attribute|Error: Unable to access jarfile/i.test(s)) {
    return '安装器文件已损坏（下载过程中被拦截或换成了错误页），请重试；仍然失败就把「下载源」换成另一个再试';
  }
  if (/UnsupportedClassVersionError|has been compiled by a more recent version/i.test(s)) {
    return '当前 Java 版本太旧，运行不了这个安装器；请在设置里换成本版本要求的 Java';
  }
  if (/There is no minecraft launcher profile/i.test(s)) {
    return '安装器找不到 launcher_profiles.json，请确认游戏目录选的是真实的 .minecraft';
  }
  if (/Failed to install|Exception in thread/i.test(s)) {
    const line = s
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter((x) => x && !/^at\s/.test(x))
      .pop();
    return `安装器执行失败：${line || '未知原因'}`;
  }
  return '';
}

/** Forge / NeoForge：下载 installer 并执行 */
async function installWithInstaller(loader, mcVersion, loaderVersion, gameDir, javaPath, src, onProgress) {
  const p = PROVIDERS[loader];
  const report = (patch) => onProgress && onProgress(patch);

  if (!javaPath) throw new Error('没有可用的 Java，无法运行安装器');
  const probe = await probeJava(javaPath);
  if (!probe.ok) throw new Error(`Java 无法运行：${probe.error}`);

  const tmp = path.join(os.tmpdir(), `smucl-${loader}-${Date.now()}.jar`);

  report({ stage: 'download', message: `下载 ${p.label} 安装器` });
  // 镜像偶尔回一份 HTML 错误页（HTTP 200、几 KB），以前会当成 jar 存下来，
  // 结果 java -jar 报「Invalid or corrupt jarfile」，用户只能看到一句看不懂的英文。
  // 这里同时校验 zip 头和体积，不合格自动换另一个源。
  const sources = src === 'bmcl' ? ['bmcl', 'mojang'] : ['mojang', 'bmcl'];
  let downloaded = false;
  let lastErr = null;
  for (const s of sources) {
    try {
      await net.download(p.installer(mcVersion, loaderVersion, s), tmp, {
        retries: 2,
        timeout: 180000,
        expectZip: true,
        minBytes: 100 * 1024,
      });
      downloaded = true;
      if (s !== src) report({ stage: 'download', message: `镜像不可用，已改用${s === 'mojang' ? '官方源' : '镜像'}下载安装器` });
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!downloaded) {
    throw new Error(`安装器下载失败（镜像与官方源均不可用）：${(lastErr && lastErr.message) || '未知原因'}`);
  }

  // installer 要求目录里有 launcher_profiles.json，否则直接拒绝安装
  const profiles = path.join(gameDir, 'launcher_profiles.json');
  let stubCreated = false;
  if (!fs.existsSync(profiles)) {
    await fsp.writeFile(profiles, JSON.stringify({ profiles: {}, settings: {}, version: 3 }, null, 2), 'utf8');
    stubCreated = true;
  }

  report({ stage: 'install', message: `${p.label} 安装器运行中，首次安装要跑几分钟，请不要关闭窗口` });

  try {
    const out = await new Promise((resolve, reject) => {
      execFile(
        javaPath,
        ['-jar', tmp, '--installClient', gameDir],
        { cwd: gameDir, windowsHide: true, timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const text = `${stdout || ''}\n${stderr || ''}`;
          if (err) return reject(Object.assign(new Error(explainInstallerFailure(text) || err.message), { text }));
          resolve(text);
        }
      );
    });

    if (out.includes('There is no minecraft launcher profile') || /Failed to install/i.test(out)) {
      throw new Error(explainInstallerFailure(out) || '安装器报告失败，多半是 Java 版本不匹配');
    }
  } finally {
    if (stubCreated) {
      try {
        fs.unlinkSync(profiles);
      } catch {
        /* 只是个占位文件，删不掉也不影响 */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件清不掉不影响结果 */
    }
  }

  // installer 正常退出不代表成功，得确认版本目录真的生成了
  const versionsDir = path.join(gameDir, 'versions');
  const candidates = fs
    .readdirSync(versionsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      try {
        return { id: e.name, mtime: fs.statSync(path.join(versionsDir, e.name, `${e.name}.json`)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((v) => v.id.toLowerCase().includes(loader))
    .sort((a, b) => b.mtime - a.mtime);

  const recent = candidates.find((v) => Date.now() - v.mtime < 20 * 60 * 1000);
  if (!recent) throw new Error('安装器执行完毕，但没有找到新生成的版本目录');

  return { id: recent.id, mcVersion, loaderVersion, libs: 0 };
}

async function install({ loader, mcVersion, loaderVersion, gameDir, javaPath, source = 'bmcl', onProgress }) {
  const p = PROVIDERS[loader];
  if (!p) return { ok: false, error: `未知的加载器：${loader}` };
  if (!mcVersion || !loaderVersion) return { ok: false, error: '游戏版本与加载器版本都必须选择' };

  const baseJson = path.join(gameDir, 'versions', mcVersion, `${mcVersion}.json`);
  if (!fs.existsSync(baseJson)) {
    return { ok: false, error: `还没有安装原版 ${mcVersion}，请先在列表里下载它，再装 ${p.label}` };
  }

  const src = loader === 'quilt' ? 'mojang' : source;

  try {
    const r =
      p.kind === 'json'
        ? await installJson(loader, mcVersion, loaderVersion, gameDir, src, onProgress)
        : await installWithInstaller(loader, mcVersion, loaderVersion, gameDir, javaPath, src, onProgress);

    // 装完立刻自检一遍：镜像缺件、半截文件、错误页 stub 都在这里现形，
    // 顺手补上，免得用户点启动时才发现「装是装上了，但跑不起来」
    const verified = await verifyInstall(gameDir, r.id, onProgress);
    return { ok: true, data: { ...r, label: p.label, ...verified } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 安装后的自检：缺什么补什么，最后确认主类真的在某个 jar 里 */
async function verifyInstall(gameDir, id, onProgress) {
  const repair = require('./repair');
  const report = (patch) => onProgress && onProgress(patch);
  const warnings = [];
  let fixed = 0;

  try {
    const before = repair.check(gameDir, id);
    if (before.missing.length) {
      report({ stage: 'verify', message: `安装完成，正在补全 ${before.missing.length} 个缺失或损坏的文件` });
      const r = await repair.fix(gameDir, id, (x) =>
        report({ stage: 'verify', message: `补全依赖 ${x.done}/${x.total}`, done: x.done, total: x.total })
      );
      fixed = r.fixed;
      if (r.remaining.length) {
        warnings.push(`仍有 ${r.remaining.length} 个文件没补齐（例如 ${r.remaining[0].name}），启动时可能报错，可点「修复依赖」再试`);
      }
    }

    const diag = repair.diagnose(gameDir, id);
    if (!diag.found) {
      warnings.push(
        `启动主类 ${diag.mainClass || '(未知)'} 不在 classpath 里，版本文件可能不完整；建议把下载源换成另一个后重装这个加载器`
      );
    }
    return { fixed, warnings, mainClassFound: diag.found };
  } catch (e) {
    return { fixed, warnings: [`安装后自检没跑通：${e.message}`], mainClassFound: false };
  }
}

module.exports = { listVersions, install, PROVIDERS, mavenRel };
