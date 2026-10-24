'use strict';
/**
 * 启动参数构建与进程管理。
 * 兼容两种版本格式：新版 arguments 与旧版 minecraftArguments。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');

const versionLib = require('./version');
const rules = require('./rules');
const settingsLib = require('./settings');
const safe = require('./safe');

const OS_NAME = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';

/**
 * 版本 JSON 来自网络，其中的 JVM 参数会被原样传给 java，等同于命令行执行。
 * agent / bootclasspath / OnError 这几类参数可以在启动瞬间加载任意 jar 或执行命令，
 * 正常游戏版本不会用到，直接剔除。
 */
const FORBIDDEN_JVM_ARG =
  /^(-javaagent:|-agentlib:|-agentpath:|-Xbootclasspath:|-Xbootclasspath\/[ap]:|-XX:OnError=|-XX:OnOutOfMemoryError=|-XX:+?UnlockDiagnosticVMOptions$)/i;

function sanitizeJvmArgs(args) {
  const out = [];
  for (const arg of args || []) {
    if (typeof arg !== 'string') continue;
    if (FORBIDDEN_JVM_ARG.test(arg.trim())) continue;
    out.push(arg);
  }
  return out;
}

function offlineUuid(name) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  // 按 UUID v3 规范改写版本位，保证与主流启动器一致
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 因为继承了父版本，客户端 jar 可能落在父版本目录 */
function resolveClientJar(mcDir, id, meta) {
  const own = path.join(mcDir, 'versions', id, `${id}.jar`);
  if (fs.existsSync(own)) return own;
  // 整合包实例 -> 加载器 -> 原版，客户端 jar 只在最底层，得顺着 inheritsFrom 一路往上找
  let cur = meta && meta.inheritsFrom;
  for (let i = 0; cur && i < 5; i++) {
    const jar = path.join(mcDir, 'versions', cur, `${cur}.jar`);
    if (fs.existsSync(jar)) return jar;
    let next = null;
    try {
      const json = JSON.parse(fs.readFileSync(path.join(mcDir, 'versions', cur, `${cur}.json`), 'utf8'));
      next = json.inheritsFrom || null;
    } catch {
      next = null;
    }
    cur = next;
  }
  // 兜底：扫描同目录下任意 jar
  const dir = path.join(mcDir, 'versions', id);
  try {
    const jar = fs.readdirSync(dir).find((f) => f.endsWith('.jar'));
    if (jar) return path.join(dir, jar);
  } catch {}
  return own;
}

// 版本 JSON 里的 natives 分类器常常只写了 os.name，没写 arch，
// 三个架构的包会同时命中；这里按当前架构再筛一遍，避免加载到 arm64/x86 的 DLL。
function nativesAllowed(name) {
  const cls = String(name || '').split(':')[3];
  if (!cls || !cls.startsWith('natives-')) return true;
  const body = cls.slice('natives-'.length);
  if (OS_NAME === 'windows') {
    if (!body.startsWith('windows')) return false;
    const arch = body.slice('windows'.length).replace(/^-/, '');
    if (!arch) return process.arch === 'x64';
    if (arch === 'x86') return process.arch === 'ia32';
    if (arch === 'arm64') return process.arch === 'arm64';
    return false;
  }
  if (OS_NAME === 'osx') {
    if (!body.startsWith('macos')) return false;
    return body.endsWith('arm64') ? process.arch === 'arm64' : process.arch !== 'arm64';
  }
  if (!body.startsWith(OS_NAME)) return false;
  const arch = body.slice(OS_NAME.length).replace(/^-/, '');
  if (!arch) return process.arch === 'x64';
  if (arch === 'arm64') return process.arch === 'arm64';
  if (arch === 'arm32') return process.arch === 'arm';
  return true;
}

/**
 * 返回 { classpath, nativeJars }：natives 包不进 classpath，改为解压到 natives 目录，
 * 与官方启动器行为一致（LWJGL 2 只认 java.library.path，不认 classpath）。
 */
function libraryEntries(meta, mcDir) {
  const classpath = [];
  const nativeJars = [];
  for (const lib of meta.libraries || []) {
    if (!rules.allowed(lib.rules, {})) continue;
    const name = lib.name || '';
    if (!nativesAllowed(name)) continue;
    const classifier = String(name).split(':')[3] || '';
    const art = lib.downloads && lib.downloads.artifact;
    if (art && art.path) {
      const p = path.join(mcDir, 'libraries', art.path);
      if (classifier.startsWith('natives-')) nativeJars.push(p);
      else classpath.push(p);
    } else if (!lib.downloads && name) {
      const parts = name.split(':');
      const [g, a, v, c] = parts;
      const file = `${a}-${v}${c ? `-${c}` : ''}.jar`;
      classpath.push(path.join(mcDir, 'libraries', g.replace(/\./g, '/'), a, v, file));
    }
    // 旧版格式：natives 通过 downloads.classifiers 提供，例如 1.12 的 LWJGL 2
    const nativeKey = lib.natives && lib.natives[OS_NAME];
    if (nativeKey) {
      const cls = nativeKey.replace('${arch}', process.arch === 'ia32' ? '32' : '64');
      const d = lib.downloads && lib.downloads.classifiers && lib.downloads.classifiers[cls];
      if (d && d.path) nativeJars.push(path.join(mcDir, 'libraries', d.path));
    }
  }
  return {
    classpath: classpath.filter((p) => fs.existsSync(p)),
    nativeJars: nativeJars.filter((p) => fs.existsSync(p)),
  };
}

function extractNatives(nativeJars, nativesDir) {
  if (!nativeJars.length) return;
  try {
    fs.mkdirSync(nativesDir, { recursive: true });
  } catch {
    return;
  }
  for (const jar of nativeJars) {
    let zip;
    try {
      zip = new AdmZip(jar);
    } catch {
      continue;
    }
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory || !/\.(dll|so|dylib)$/i.test(entry.entryName)) continue;
      const dest = path.join(nativesDir, path.basename(entry.entryName));
      try {
        if (fs.existsSync(dest) && fs.statSync(dest).size === entry.header.size) continue;
        fs.writeFileSync(dest, entry.getData());
      } catch {
        /* 被占用或无权限时跳过，交给 java.library.path 里已有的 DLL */
      }
    }
  }
}

function findLoggingConfig(mcDir, meta) {
  const id = meta.logging && meta.logging.client && meta.logging.client.file && meta.logging.client.file.id;
  if (!id) return null;
  const p = path.join(mcDir, 'assets', 'log_configs', id);
  return fs.existsSync(p) ? p : null;
}

/**
 * natives 统一平铺到 <实例>/natives。
 * java.library.path 不递归子目录，而 PCL 等启动器留下的 <实例>-natives 是按模块分层的
 * （lwjgl/lwjgl.dll、jna/*.dll），直接指过去会让 JVM 找不到 lwjgl.dll。
 */
function resolveNativesDir(instanceDir) {
  const dir = path.join(instanceDir, 'natives');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 构建完整启动命令
 * @param {string} id 实例名
 * @param {object} options { sourceDir, memory, playerName, javaPath, ... }
 * @returns {{java:string, args:string[], cwd:string, meta:object}}
 */
function build(id, options = {}) {
  safe.assertVersionId(id);
  const settings = settingsLib.all();
  const mcDir = options.sourceDir || settings.mcDir;
  const meta = versionLib.loadVersionJson(mcDir, id);

  const playerName = (options.playerName || settings.playerName || 'Steve').trim() || 'Steve';
  // 正版身份由主进程注入；没有就退回离线参数
  const acc = options.account && options.account.accessToken ? options.account : null;
  const memory = Math.max(1024, Number(options.memory || settings.memory || 4096));
  const javaPath = options.javaPath || settings.javaPath;
  const instanceDir = path.join(mcDir, 'versions', id);

  // 版本隔离：mods / config / saves 在实例目录内时，--gameDir 必须指向实例目录
  const isolated = require('./dirs').isIsolatedInstance(instanceDir);
  const gameDir = isolated ? instanceDir : mcDir;
  const nativesDir = resolveNativesDir(instanceDir);

  const clientJar = resolveClientJar(mcDir, id, meta);
  const { classpath: libs, nativeJars } = libraryEntries(meta, mcDir);
  const classpath = [clientJar, ...libs].join(path.delimiter);
  extractNatives(nativeJars, nativesDir);

  const features = {
    is_demo_user: false,
    has_custom_resolution: Boolean(options.resolution && options.resolution.enabled),
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: false,
    is_quick_play_realms: false,
  };

  const assetsName = (meta.assetIndex && meta.assetIndex.id) || meta.assets || 'legacy';
  // pre-1.6 的资源被安装器映射到 resources/，其余 legacy 索引在 assets/virtual/<id>
  const legacyAssetsRoot =
    assetsName === 'pre-1.6'
      ? path.join(mcDir, 'resources')
      : path.join(mcDir, 'assets', 'virtual', assetsName);

  const replacements = {
    '${auth_player_name}': acc ? acc.name : playerName,
    '${version_name}': id,
    '${game_directory}': gameDir,
    '${assets_root}': path.join(mcDir, 'assets'),
    '${game_assets}': legacyAssetsRoot,
    '${assets_index_name}': assetsName,
    '${auth_uuid}': acc ? acc.uuid : offlineUuid(playerName),
    '${auth_access_token}': acc ? acc.accessToken : '0',
    '${auth_session}': acc ? acc.accessToken : '0',
    '${clientid}': 'smucl',
    '${auth_xuid}': acc && acc.xuid ? acc.xuid : '0',
    '${user_type}': 'msa',
    '${version_type}': meta.type || 'release',
    '${natives_directory}': nativesDir,
    '${library_directory}': path.join(mcDir, 'libraries'),
    '${classpath_separator}': path.delimiter,
    '${classpath}': classpath,
    '${launcher_name}': 'SMUCL',
    '${launcher_version}': '1.6.0',
    '${user_properties}': '{}',
    '${resolution_width}': String((options.resolution && options.resolution.width) || 925),
    '${resolution_height}': String((options.resolution && options.resolution.height) || 530),
    '${quickPlayPath}': '',
    '${quickPlaySingleplayer}': '',
    '${quickPlayMultiplayer}': '',
    '${quickPlayRealms}': '',
  };

  const apply = (s) => {
    let out = s;
    for (const [k, v] of Object.entries(replacements)) {
      if (out.includes(k)) out = out.split(k).join(v);
    }
    return out;
  };

  // ---- JVM 参数 ----
  const jvm = [];
  const loggingConfig = findLoggingConfig(mcDir, meta);
  const maxMem = memory;
  const minMem = Math.min(1024, Math.floor(memory / 2));

  if (meta.arguments && Array.isArray(meta.arguments.jvm)) {
    const raw = sanitizeJvmArgs(rules.flatten(meta.arguments.jvm, features));
    // 新版 arguments 已包含 -Xmx 的占位符规范，但绝大多数版本没有，这里统一注入
    if (!raw.some((a) => a.startsWith('-Xmx'))) {
      jvm.push(`-Xmx${maxMem}M`, `-Xms${minMem}M`);
    }
    jvm.push(...raw.map(apply));
  } else {
    jvm.push(`-Xmx${maxMem}M`, `-Xms${minMem}M`);
    jvm.push(`-Djava.library.path=${nativesDir}`);
    jvm.push('-cp', classpath);
  }

  if (!jvm.includes('-Dfile.encoding=UTF-8')) {
    jvm.push('-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8');
  }
  if (loggingConfig) {
    jvm.push(`-Dlog4j.configurationFile=${loggingConfig}`);
    jvm.push('-Dlog4j2.formatMsgNoLookups=true');
  }
  if (options.fullscreen) jvm.push('-Dorg.lwjgl.fullscreen=true');

  const extra = (options.jvmArgs || settings.jvmArgs || '').trim();
  if (extra) jvm.push(...extra.split(/\s+/).filter(Boolean));

  // 版本 JSON 里的 library.path 常写成 ${natives_directory}/java 之类的子目录（该目录并不存在），
  // 统一改指真正解压了 dll 的平铺目录
  const libPathIndex = jvm.findIndex((a) => a.startsWith('-Djava.library.path='));
  if (libPathIndex >= 0) jvm[libPathIndex] = `-Djava.library.path=${nativesDir}`;
  else jvm.push(`-Djava.library.path=${nativesDir}`);

  // ---- 游戏参数 ----
  let game = [];
  if (meta.arguments && Array.isArray(meta.arguments.game)) {
    game = rules.flatten(meta.arguments.game, features).map(apply);
  } else if (meta.minecraftArguments) {
    game = meta.minecraftArguments.split(/\s+/).filter(Boolean).map(apply);
  }

  if (options.fullscreen && !game.includes('--fullscreen')) game.push('--fullscreen');

  const args = [...jvm, meta.mainClass, ...game];
  const java = javaPath || 'javaw.exe';

  return { java, args, cwd: gameDir, meta, playerName };
}

/** 启动前确认 java 路径确实是一个可执行文件（javaw.exe / java.exe），而不是任意程序 */
function assertJavaPath(java) {
  if (!java || typeof java !== 'string') throw new Error('未指定 Java 运行时');
  const base = path.basename(java).toLowerCase();
  if (!/^javaw?(\.exe)?$/.test(base)) throw new Error('Java 路径必须是 javaw.exe 或 java.exe');
  let st;
  try {
    st = fs.statSync(java);
  } catch {
    throw new Error('Java 路径不存在');
  }
  if (!st.isFile()) throw new Error('Java 路径不是文件');
  return java;
}

/**
 * 启动游戏
 * @param {string} id
 * @param {object} options
 * @param {{onLog:(s:string)=>void, onExit:(code:number|null)=>void, onError:(e:Error)=>void}} handlers
 */
function launch(id, options, handlers = {}) {
  const built = build(id, options);
  const { java, args, cwd } = built;
  assertJavaPath(java);

  const child = spawn(java, args, {
    cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const pipe = (stream, tag) => {
    if (!stream) return;
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim() && handlers.onLog) handlers.onLog(tag ? `[${tag}] ${line}` : line);
      }
    });
  };

  pipe(child.stdout, '');
  pipe(child.stderr, 'ERR');

  child.on('error', (err) => {
    if (handlers.onError) handlers.onError(err);
  });
  child.on('close', (code) => {
    if (handlers.onExit) handlers.onExit(code);
  });

  return { child, pid: child.pid, command: `${java} ${args.join(' ')}` };
}

module.exports = {
  launch,
  build,
  offlineUuid,
  extractNatives,
  sanitizeJvmArgs,
  assertJavaPath,
};
