'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

const settingsLib = require('./core/settings');
const javaLib = require('./core/java');
const versionLib = require('./core/version');
const installer = require('./core/install');
const launcher = require('./core/launch');
const dirsLib = require('./core/dirs');
const savesLib = require('./core/saves');
const updater = require('./core/updater');
const gpuLib = require('./core/gpu');
const packLib = require('./core/pack');
const exportLib = require('./core/export');
const contentLib = require('./core/content');
const loadersLib = require('./core/loaders');
const repairLib = require('./core/repair');
const modrinthLib = require('./core/modrinth');
const curseforgeLib = require('./core/curseforge');
const safe = require('./core/safe');
const authLib = require('./core/auth');
const accountLib = require('./core/account');
const wallpaperLib = require('./core/wallpaper');

// 背景图协议必须在 app ready 之前登记
wallpaperLib.registerScheme();

// Windows 上部分镜像的 AAAA 记录不可达，IPv6 优先会白等十几次超时
try {
  require('dns').setDefaultResultOrder('ipv4first');
} catch {
  /* 旧版本 Node 无此 API，忽略 */
}

const isDev = process.argv.includes('--dev');
let win = null;
let gameProc = null;
const installing = new Map();
let javaCache = [];
let latestInfo = null; // 最新版本信息（后台定时更新）

// ------------------------------------------------------------------ 来源与边界校验
// 渲染进程只应加载本地页面。一旦被导航到外部页面，preload 会重新注入，
// window.smucl 就落到外部脚本手里，所以「导航」和「IPC 来源」两道闸都要卡。
const APP_PAGE_DIR = path.join(__dirname, 'renderer');
const APP_PAGE_PREFIX = pathToFileURL(APP_PAGE_DIR).href.replace(/\/+$/, '') + '/';

function isAppUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  const clean = value.split('#')[0].split('?')[0];
  return clean.startsWith(APP_PAGE_PREFIX);
}

function assertSender(event) {
  const url = event && event.senderFrame && event.senderFrame.url;
  if (!isAppUrl(url)) throw new Error('拒绝来自非应用页面的调用');
}

/** 已知游戏目录：mcDir + 额外目录 + 自动发现的目录 */
function knownGameDirs() {
  const settings = settingsLib.all();
  const list = [settings.mcDir, ...(settings.extraDirs || [])];
  for (const d of dirsLib.all(settings)) list.push(d.path);
  return list.filter(Boolean);
}

/** path 必须落在某个游戏目录内（用于打开目录、导入整合包等） */
function assertInGameDirs(target, label = '路径') {
  const resolved = path.resolve(target);
  const hit = knownGameDirs().some((d) => safe.withinDir(d, resolved));
  if (!hit) throw new Error(`${label}不在游戏目录内`);
  return resolved;
}

/**
 * 存档操作只允许作用在 <游戏目录>/saves 或 <游戏目录>/versions/<实例>/saves 之下。
 * 用真实路径判断，符号链接指向外面的也会被挡住。
 */
function assertSavePath(target) {
  if (typeof target !== 'string' || !target) throw new Error('缺少存档路径');
  const resolved = path.resolve(target);
  for (const dir of knownGameDirs()) {
    const roots = [path.join(dir, 'saves')];
    const versionsRoot = path.join(dir, 'versions');
    try {
      for (const ent of fs.readdirSync(versionsRoot, { withFileTypes: true })) {
        if (ent.isDirectory()) roots.push(path.join(versionsRoot, ent.name, 'saves'));
      }
    } catch {
      /* 没有 versions 目录就算了 */
    }
    if (roots.some((root) => safe.withinDir(root, resolved))) return resolved;
  }
  throw new Error('存档路径不在允许范围内');
}

/**
 * Java 路径校验：只要指向一个真实存在的 java.exe / javaw.exe 就放行。
 * 这里刻意不要求「必须来自自动扫描」——玩家自己解压一份 JRE、装在非标准目录、
 * 或者用启动器自带的运行时都很常见，卡成白名单会让设置页几乎没法用。
 */
function assertUsableJava(javaPath) {
  return launcher.assertJavaPath(javaPath);
}

// IPC 统一入口：先校验来源，再把异常转成 {ok:false}
const ipcHandle = ipcMain.handle.bind(ipcMain);
const handle = (channel, fn) =>
  ipcHandle(channel, async (event, ...args) => {
    try {
      assertSender(event);
    } catch (e) {
      console.warn('[ipc] 拒绝调用', channel, e.message);
      return { ok: false, error: e.message };
    }
    try {
      return await fn(event, ...args);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

/** 允许从界面写入的设置项（其余键一律丢弃，避免往配置文件里塞任意内容） */
const EDITABLE_SETTINGS = new Set([
  'mcDir',
  'extraDirs',
  'javaPath',
  'memory',
  'downloadSource',
  'playerName',
  'showLog',
  'fullscreen',
  'resolution',
  'jvmArgs',
  'downloadThreads',
  'autoCheck',
  'autoUpdateCheck',
  'theme',
  'wallpaper',
  'gpuHighPerf',
  'saveGroup',
  'cfApiKey',
  'msClientId',
  'loginMode',
  'lastSeenVersion',
  'pendingUpdate',
  'gpuFallback',
]);

/** 游戏目录必须是普通绝对路径，不能是盘符根目录或系统目录 */
function assertGameDirPath(value, label = '游戏目录') {
  if (typeof value !== 'string' || !value || value.length > 260) throw new Error(`${label}无效`);
  if (value.includes('\u0000')) throw new Error(`${label}无效`);
  const resolved = path.resolve(value);
  if (path.parse(resolved).root === resolved) throw new Error(`${label}不能是磁盘根目录`);
  const lower = resolved.toLowerCase();
  const blocked = [
    path.join(process.env.SystemRoot || 'C:\\Windows'),
    'c:\\windows',
    'c:\\program files',
    'c:\\program files (x86)',
    process.env.ProgramData || 'C:\\ProgramData',
  ].map((p) => path.resolve(p).toLowerCase());
  if (blocked.some((b) => lower === b || lower.startsWith(`${b}\\`))) {
    throw new Error(`${label}不能指向系统目录`);
  }
  return resolved;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampFloat(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.min(max, Math.max(min, n)) * 1000) / 1000;
}

/**
 * 过滤设置补丁：白名单键 + 逐项类型/范围校验。
 * 特别是 javaPath —— 它会在下次启动时被当作可执行文件拉起，必须是主进程认可过的 Java。
 */
function sanitizeSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置内容无效');
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!EDITABLE_SETTINGS.has(key)) continue;
    switch (key) {
      case 'mcDir':
        out.mcDir = assertGameDirPath(value);
        break;
      case 'extraDirs': {
        if (!Array.isArray(value)) throw new Error('附加目录格式无效');
        const dirs = [];
        for (const item of value.slice(0, 20)) {
          const dir = assertGameDirPath(item, '附加目录');
          if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('附加目录不存在');
          dirs.push(dir);
        }
        out.extraDirs = Array.from(new Set(dirs));
        break;
      }
      case 'javaPath':
        out.javaPath = value ? assertUsableJava(String(value)) : '';
        break;
      case 'memory': {
        const total = Math.round(os.totalmem() / 1024 / 1024);
        out.memory = clampInt(value, 1024, Math.max(1024, total), 4096);
        break;
      }
      case 'downloadSource':
        if (value !== 'mojang' && value !== 'bmcl') throw new Error('下载源无效');
        out.downloadSource = value;
        break;
      case 'playerName': {
        const name = String(value || '').trim();
        if (!/^[A-Za-z0-9_\u4e00-\u9fff]{1,16}$/.test(name)) throw new Error('玩家名不合法');
        out.playerName = name;
        break;
      }
      case 'resolution': {
        if (!value || typeof value !== 'object') throw new Error('分辨率设置无效');
        out.resolution = {
          enabled: Boolean(value.enabled),
          width: clampInt(value.width, 320, 7680, 925),
          height: clampInt(value.height, 240, 4320, 530),
        };
        break;
      }
      case 'jvmArgs': {
        const args = String(value || '');
        if (args.length > 2000) throw new Error('JVM 参数过长');
        if (/[\u0000\r\n]/.test(args)) throw new Error('JVM 参数包含非法字符');
        out.jvmArgs = args;
        break;
      }
      case 'downloadThreads':
        out.downloadThreads = clampInt(value, 1, 16, 8);
        break;
      case 'theme':
        if (!['auto', 'dark', 'light'].includes(value)) throw new Error('主题无效');
        out.theme = value;
        break;
      case 'wallpaper': {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('背景设置无效');
        // image 只接受 wallpapers/ 里真实存在的文件，避免把任意路径写进配置
        const image = wallpaperLib.exists(value.image) ? String(value.image) : '';
        out.wallpaper = {
          enabled: Boolean(value.enabled) && Boolean(image),
          image,
          fit: ['cover', 'contain', 'stretch'].includes(value.fit) ? value.fit : 'cover',
          mask: ['none', 'soft', 'top', 'bottom', 'vignette'].includes(value.mask) ? value.mask : 'soft',
          opacity: clampFloat(value.opacity, 0.05, 1, 0.6),
          blur: clampInt(value.blur, 0, 40, 0),
          dim: clampFloat(value.dim, 0, 0.85, 0.35),
          ui: clampFloat(value.ui, 0.35, 1, 0.78),
        };
        break;
      }
      case 'saveGroup':
        if (!['folder', 'version', 'time'].includes(value)) throw new Error('存档分组方式无效');
        out.saveGroup = value;
        break;
      case 'cfApiKey': {
        const key = String(value || '').trim();
        if (key.length > 200) throw new Error('API Key 过长');
        out.cfApiKey = key;
        break;
      }
      case 'msClientId': {
        const id = String(value || '').trim();
        if (id && !/^[0-9a-fA-F-]{8,64}$/.test(id)) throw new Error('客户端 ID 格式无效');
        out.msClientId = id;
        break;
      }
      case 'loginMode':
        out.loginMode = value === 'msa' ? 'msa' : 'offline';
        break;
      case 'lastSeenVersion':
        out.lastSeenVersion = String(value || '').slice(0, 32);
        break;
      default:
        // 其余都是布尔开关
        out[key] = Boolean(value);
    }
  }
  return out;
}

// ------------------------------------------------------------------ GPU 兼容兜底
// 部分机器（驱动异常、安全软件拦截）会导致 Chromium 的 GPU 进程一启动就崩溃，
// 表现为 "GPU process isn't usable. Goodbye." 并直接退出。
// 这里做两级处理：崩溃后写入标记并带 --no-sandbox 重启；标记存在时开机即走兼容参数。
const FALLBACK_ARG = '--smucl-gpu-fallback';
const isFallbackLaunch = process.argv.includes(FALLBACK_ARG);

settingsLib.init();
const bootSettings = settingsLib.all();

function relaunchCompat() {
  const args = process.argv.slice(1).concat(['--no-sandbox', FALLBACK_ARG]);
  app.relaunch({ args });
  app.exit(0);
}

if (bootSettings.gpuFallback && !isFallbackLaunch) {
  console.log('[gpu] 上次检测到 GPU 崩溃，本次以兼容模式启动');
  relaunchCompat();
}

app.on('child-process-gone', (_e, details) => {
  if (!details || details.type !== 'GPU' || isFallbackLaunch) return;
  if (details.reason === 'clean-exit' || details.reason === 'killed') return;
  if (settingsLib.all().gpuFallback) return;
  console.log('[gpu] GPU 进程异常退出，切换兼容模式重启：', details.reason);
  settingsLib.save({ gpuFallback: true });
  relaunchCompat();
});

// ------------------------------------------------------------------ 窗口
function createWindow() {
  win = new BrowserWindow({
    width: 1220,
    height: 800,
    minWidth: 1020,
    minHeight: 660,
    show: false,
    frame: false,
    backgroundColor: '#0e1118',
    title: 'SMUCL',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 把渲染进程的报错带回主进程日志，便于排查
  win.webContents.on('console-message', (...args) => {
    const d = args[1];
    if (d && typeof d === 'object') {
      if (d.level === 'error' || d.level === 'warning') console.log(`[renderer:${d.level}]`, d.message);
    } else if (args[1] >= 2) {
      console.log('[renderer]', args[2]);
    }
  });
  win.once('ready-to-show', () => {
    win.show();
    if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  });
  win.on('closed', () => {
    win = null;
  });

  // 开发辅助：SMUCL_SHOT=1 [SMUCL_SHOT_VIEW=download] 自动截图后退出，便于核对界面
  // 打包后关闭：它会执行 SMUCL_SHOT_JS 里的任意脚本，不能留给正式版本
  const shotMode = !app.isPackaged && (process.env.SMUCL_SHOT === '1' || process.argv.includes('--shot'));
  if (shotMode) {
    const view = process.env.SMUCL_SHOT_VIEW || null;
    win.webContents.once('did-finish-load', () => {
      const delay = view === 'download' ? 12000 : view === 'saves' ? 9000 : 3000;
      setTimeout(async () => {
        try {
          if (view) {
            await win.webContents.executeJavaScript(
              `document.querySelector('[data-view="${view}"]')?.click(); true`
            );
            await new Promise((r) => setTimeout(r, 1600));
          }
          // 调试钩子：注入一段脚本后再截图，便于自动化验证交互
          if (process.env.SMUCL_SHOT_JS) {
            await win.webContents.executeJavaScript(process.env.SMUCL_SHOT_JS);
            await new Promise((r) => setTimeout(r, 2500));
          }
          const img = await win.webContents.capturePage();
          const name = view ? `shot-${view}.png` : 'shot.png';
          const outDir = path.join(__dirname, 'build');
          fs.mkdirSync(outDir, { recursive: true });
          fs.writeFileSync(path.join(outDir, name), img.toPNG());
          console.log('[shot] saved', name);
        } catch (e) {
          console.error('[shot] failed', e);
        }
        app.quit();
      }, delay);
    });
  }

  // S1：只允许停留在应用自己的页面。拖入链接、拖入 html 文件、脚本改 location
  // 都会触发导航；一旦跳走，preload 会重新注入，外部页面就能拿到 window.smucl。
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) {
      console.warn('[nav] 已拦截导航:', url);
      event.preventDefault();
    }
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url)) {
      console.warn('[nav] 已拦截重定向:', url);
      event.preventDefault();
    }
  });
  // 不允许当前页面再嵌套 webview / 打开新 webContents
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());

  // S2：外链走系统浏览器，但只放行 http/https（file:// 会把本地 exe 交给系统执行）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (safe.isHttpUrl(url)) shell.openExternal(url);
    else console.warn('[nav] 已拒绝打开:', url);
    return { action: 'deny' };
  });
}

// ------------------------------------------------------------------ 目录与状态
function getDirs() {
  return dirsLib.all(settingsLib.all());
}

function appState() {
  const settings = settingsLib.all();
  const dirs = getDirs();
  const installed = versionLib.listInstalled(dirs);
  // 图片被手动删掉时不要把已失效的路径发给渲染层，直接按「未启用」处理
  const wall = settings.wallpaper || {};
  const wallOk = wallpaperLib.exists(wall.image);
  return {
    settings: wallOk ? settings : { ...settings, wallpaper: { ...wall, enabled: false, image: '' } },
    javaList: javaCache,
    dirs,
    installed,
    latest: latestInfo,
    gpuFallback: Boolean(settingsLib.all().gpuFallback),
    fallbackActive: isFallbackLaunch,
    platform: process.platform,
    version: app.getVersion(),
    memoryTotal: Math.round(os.totalmem() / 1024 / 1024),
  };
}

async function refreshJava() {
  const settings = settingsLib.all();
  const mcDirs = getDirs().map((d) => d.path);
  javaCache = await javaLib.detect({
    mcDir: settings.mcDir,
    mcDirs,
    preferred: settings.javaPath,
  });
  return javaCache;
}

/** 后台检查最新版本；发现变化时推送给渲染进程 */
async function checkLatest(notify = true) {
  const { downloadSource, autoCheck } = settingsLib.all();
  if (!autoCheck && notify) return latestInfo;
  try {
    const data = await versionLib.getManifest(downloadSource, { force: true });
    const next = {
      release: data.latest.release,
      snapshot: data.latest.snapshot,
      source: data.__source || downloadSource,
      at: Date.now(),
    };
    const changed =
      !latestInfo || latestInfo.release !== next.release || latestInfo.snapshot !== next.snapshot;
    latestInfo = next;
    if (changed && notify && win && !win.isDestroyed()) {
      win.webContents.send('manifest:latest', next);
      // 窗口不在前台时补一条系统通知
      if (!win.isFocused() && Notification.isSupported()) {
        try {
          const n = new Notification({
            title: 'SMUCL · 发现新版本',
            body: `Minecraft ${next.release} 已发布，点击启动器即可安装`,
            silent: true,
          });
          n.on('click', () => {
            if (!win) return;
            if (win.isMinimized()) win.restore();
            win.focus();
          });
          n.show();
        } catch {
          /* 通知不可用则忽略 */
        }
      }
    }
    return next;
  } catch {
    return latestInfo;
  }
}

/** 首次启动：若默认目录没有实例，自动采用检测到的 PCL 目录 */
function adoptLauncherDirIfNeeded() {
  const configFile = path.join(app.getPath('userData'), 'smucl-config.json');
  if (fs.existsSync(configFile)) return;

  const count = (p) => {
    try {
      return fs
        .readdirSync(path.join(p, 'versions'), { withFileTypes: true })
        .filter((e) => e.isDirectory() && fs.existsSync(path.join(p, 'versions', e.name, `${e.name}.json`)))
        .length;
    } catch {
      return 0;
    }
  };

  const settings = settingsLib.all();
  if (count(settings.mcDir) > 0) return;

  const roots = dirsLib.findLauncherRoots();
  for (const r of roots) {
    const mc = path.join(r.dir, '.minecraft');
    if (count(mc) > 0) {
      settingsLib.save({ mcDir: mc });
      console.log('[init] 已采用游戏目录:', mc);
      return;
    }
  }
}

// ------------------------------------------------------------------ IPC
function registerIpc() {
  handle('app:state', async () => {
    // 首屏不等 Java 扫描与体积统计
    return { ok: true, data: appState() };
  });

  handle('java:detect', async () => {
    try {
      await refreshJava();
      return { ok: true, data: javaCache };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  handle('versions:manifest', async (_e, { force = false } = {}) => {
    const { downloadSource } = settingsLib.all();
    try {
      const data = await versionLib.getManifest(downloadSource, { force });
      latestInfo = {
        release: data.latest.release,
        snapshot: data.latest.snapshot,
        source: data.__source || downloadSource,
        at: Date.now(),
      };
      return {
        ok: true,
        data: {
          latest: data.latest,
          source: latestInfo.source,
          checkedAt: latestInfo.at,
          versions: data.versions.map((v) => ({
            id: v.id,
            type: v.type,
            releaseTime: v.releaseTime,
            url: v.url,
          })),
        },
      };
    } catch (e) {
      return { ok: false, error: `版本列表获取失败：${e.message}` };
    }
  });

  handle('versions:installed', async () => {
    return { ok: true, data: versionLib.listInstalled(getDirs()) };
  });

  // 体积统计耗时较长，逐个推送给界面
  handle('versions:sizes', async () => {
    const installed = versionLib.listInstalled(getDirs());
    const map = {};
    for (const v of installed) {
      const p = path.join(v.dir, 'versions', v.id);
      const size = await savesLib.dirSize(p);
      const key = `${v.dir}|${v.id}`;
      map[key] = size;
      if (win && !win.isDestroyed()) win.webContents.send('versions:size', { key, size });
    }
    return { ok: true, data: map };
  });

  // ---------------- 游戏目录管理 ----------------
  handle('dirs:list', async () => {
    return { ok: true, data: { dirs: getDirs(), settings: settingsLib.all(), installed: versionLib.listInstalled(getDirs()) } };
  });

  handle('dirs:add', async () => {
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: '选择 .minecraft 目录（包含 versions/saves 的文件夹）',
    });
    if (res.canceled || !res.filePaths[0]) return { ok: true, data: null };
    const picked = res.filePaths[0];
    const settings = settingsLib.all();
    const extra = Array.from(new Set([...(settings.extraDirs || []), picked]));
    settingsLib.save({ extraDirs: extra });
    return { ok: true, data: { dirs: getDirs(), installed: versionLib.listInstalled(getDirs()), settings: settingsLib.all() } };
  });

  handle('dirs:remove', async (_e, { path: target }) => {
    const settings = settingsLib.all();
    const extra = (settings.extraDirs || []).filter((p) => dirsLib.norm(p) !== dirsLib.norm(target));
    settingsLib.save({ extraDirs: extra });
    return { ok: true, data: { dirs: getDirs(), installed: versionLib.listInstalled(getDirs()), settings: settingsLib.all() } };
  });

  handle('dirs:setPrimary', async (_e, { path: target } = {}) => {
    if (!target) return { ok: false, error: '缺少目录' };
    // 主目录会成为安装/写入的目标，必须是合法的普通目录
    const dir = assertGameDirPath(String(target));
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { ok: false, error: '目录不存在' };
    const settingsLibNext = settingsLib.save({ mcDir: dir });
    settingsLib.ensureGameDir();
    await refreshJava().catch(() => {});
    return {
      ok: true,
      data: { dirs: getDirs(), installed: versionLib.listInstalled(getDirs()), settings: settingsLibNext },
    };
  });

  // ---------------- 存档 ----------------
  handle('saves:list', async () => {
    const dirs = getDirs();
    try {
      const list = await savesLib.scan(dirs, (done, total) => {
        if (win && !win.isDestroyed()) win.webContents.send('saves:progress', { done, total });
      });
      return { ok: true, data: { saves: list, dirs } };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // S7：只能对 saves/ 下的目录做「在文件夹中显示 / 删除到回收站」
  handle('saves:reveal', async (_e, { path: p } = {}) => {
    try {
      shell.showItemInFolder(assertSavePath(p));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  handle('saves:trash', async (_e, { path: p } = {}) => {
    try {
      const target = assertSavePath(p);
      if (!fs.existsSync(target)) throw new Error('存档目录不存在');
      // 只删存档目录本身，避免传入游戏根目录时把整个 .minecraft 送进回收站
      if (!fs.statSync(target).isDirectory()) throw new Error('存档路径必须是文件夹');
      await shell.trashItem(target);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---------------- 安装 / 删除 ----------------
  handle('install:start', async (_e, { id, url } = {}) => {
    const versionId = safe.assertVersionId(id);
    if (installing.has(versionId)) return { ok: false, error: '该版本正在安装中' };
    // 只允许从官方元数据源拉版本 JSON，避免借安装器下载任意文件
    const metaUrl = safe.assertHttpUrl(url, safe.GAME_HOSTS, '版本元数据地址');

    installing.set(versionId, true);
    const source = settingsLib.all().downloadSource;
    try {
      const result = await installer.install(versionId, { url: metaUrl }, source, (p) => {
        if (win && !win.isDestroyed()) win.webContents.send('install:progress', p);
      });
      return { ok: true, data: result };
    } catch (e) {
      if (win && !win.isDestroyed()) {
        win.webContents.send('install:progress', { id: versionId, stage: 'error', message: e.message, percent: 0 });
      }
      return { ok: false, error: e.message };
    } finally {
      installing.delete(versionId);
    }
  });

  // S5：版本名必须是单段，且删除目标必须落在 <游戏目录>/versions 内
  handle('version:delete', async (_e, { id, dir } = {}) => {
    const versionId = safe.assertVersionId(id);
    const base = dir ? assertInGameDirs(dir, '游戏目录') : path.resolve(settingsLib.all().mcDir);
    if (dir && !knownGameDirs().some((d) => safe.withinDir(d, base))) {
      throw new Error('游戏目录不在允许范围内');
    }
    const target = safe.safeJoin(path.join(base, 'versions'), versionId);
    if (!fs.existsSync(target)) throw new Error('目录不存在');
    if (!fs.statSync(target).isDirectory()) throw new Error('目标不是版本目录');
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: true };
  });

  handle('version:command', async (_e, { id, dir } = {}) => {
    const built = launcher.build(safe.assertVersionId(id), {
      ...settingsLib.all(),
      sourceDir: dir ? assertInGameDirs(dir, '游戏目录') : undefined,
    });
    return {
      ok: true,
      data: `"${built.java}" ${built.args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`,
    };
  });

  // ---------------- 正版登录 ----------------
  let loginSession = null;

  const msClientId = () => (settingsLib.all().msClientId || process.env.SMUCL_MS_CLIENT_ID || '').trim();

  /** 取一个可用的正版账号；token 快过期就刷新 */
  const freshAccount = async () => {
    const a = accountLib.load();
    if (!a || !a.name) return null;
    const stillValid = a.accessToken && a.expiresAt && a.expiresAt - Date.now() > 120000;
    if (stillValid) return a;

    const clientId = msClientId();
    const mode = a.authMode === 'live' ? 'live' : 'azure';
    if (!a.refreshToken) return a; // 没有刷新令牌就无从续期，交给上层判断
    if (mode === 'azure' && !clientId) return a; // 自备通道必须知道客户端 ID

    try {
      const t = await authLib.refreshToken(clientId, a.refreshToken, mode);
      const prof = await authLib.xboxToMinecraft(t.access_token, mode);
      return accountLib.save({ ...prof, refreshToken: t.refresh_token || a.refreshToken, authMode: mode });
    } catch (e) {
      if (e.invalidGrant) {
        accountLib.clear(); // 授权已失效（改密码/被撤销），只能重新登录
        return null;
      }
      // 刷新失败且本地 token 已过期：宁可报错，也不要拿一个死 token 去连服务器
      if (a.expiresAt && a.expiresAt <= Date.now() + 120000) {
        throw new Error(`正版登录已过期，刷新失败（${e.message}）。请在「设置 → 账号」重新登录。`);
      }
      return a;
    }
  };

  const authSend = (channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  handle('auth:status', async () => {
    const info = accountLib.publicInfo();
    return {
      ok: true,
      data: {
        ...info,
        clientId: msClientId(),
        canEncrypt: accountLib.canEncrypt(),
        mode: settingsLib.all().loginMode || 'offline',
      },
    };
  });

  handle('auth:setClientId', async (_e, { id }) => {
    const v = String(id || '').trim();
    await settingsLib.save({ msClientId: v });
    return { ok: true, data: { clientId: v } };
  });

  handle('auth:setMode', async (_e, { mode }) => {
    await settingsLib.save({ loginMode: mode === 'msa' ? 'msa' : 'offline' });
    return { ok: true };
  });

  handle('auth:login', async () => {
    if (loginSession) return { ok: false, error: '正在登录中，请先完成上一个授权' };
    const clientId = msClientId();
    // 没填客户端 ID 时走免注册的 Live 通道（auth.js 内部处理），不再拦在这里

    let d;
    try {
      d = await authLib.startDeviceCode(clientId);
    } catch (e) {
      return { ok: false, error: e.message };
    }

    loginSession = { cancelled: false, deviceCode: d.deviceCode, mode: d.mode };

    // 后台轮询：用户在浏览器里输完码后自动完成
    (async () => {
      let interval = d.interval;
      const deadline = Date.now() + (d.expiresIn || 900) * 1000;
      while (loginSession && !loginSession.cancelled && Date.now() < deadline) {
        await authLib.sleep(interval * 1000);
        if (!loginSession || loginSession.cancelled) break;
        try {
          const r = await authLib.pollToken(clientId, d.deviceCode, d.mode);
          if (r.done) {
            authSend('auth:stage', { stage: 'xbox', message: '正在验证 Xbox 账号…' });
            const prof = await authLib.xboxToMinecraft(r.tokens.access_token, d.mode);
            accountLib.save({ ...prof, refreshToken: r.tokens.refresh_token, authMode: d.mode });
            await settingsLib.save({ loginMode: 'msa' });
            loginSession = null;
            authSend('auth:done', accountLib.publicInfo());
            return;
          }
          if (r.reason === 'slow') interval += 5;
          if (r.reason === 'expired') {
            loginSession = null;
            authSend('auth:failed', { error: '设备码已过期，请重新登录' });
            return;
          }
          if (r.reason === 'declined') {
            loginSession = null;
            authSend('auth:failed', { error: '授权被取消' });
            return;
          }
        } catch (e) {
          loginSession = null;
          authSend('auth:failed', { error: e.message });
          return;
        }
      }
      if (loginSession && !loginSession.cancelled) {
        loginSession = null;
        authSend('auth:failed', { error: '登录超时，请重新开始' });
      }
    })();

    return { ok: true, data: { userCode: d.userCode, url: d.url, expiresIn: d.expiresIn } };
  });

  handle('auth:cancel', async () => {
    if (loginSession) loginSession.cancelled = true;
    loginSession = null;
    return { ok: true };
  });

  handle('auth:logout', async () => {
    accountLib.clear();
    await settingsLib.save({ loginMode: 'offline' });
    return { ok: true, data: { loggedIn: false } };
  });

  // ---------------- 启动 ----------------
  /**
   * 启动前把缺失的依赖补回来。
   * classpath 只收录磁盘上真实存在的 jar，少一个库，Java 就只会甩一句
   * 「找不到或无法加载主类」，用户完全看不出是缺文件，所以这一步必须前置。
   */
  async function ensureDeps(gameDir, versionId, logLine) {
    let report;
    try {
      report = repairLib.check(gameDir, versionId);
    } catch {
      return { ok: true }; // 元数据本身有问题时交给后面的流程报错，不在这里拦
    }

    if (report.missing.length) {
      logLine(`> 依赖自检：发现 ${report.missing.length} 个文件缺失，正在从镜像补全…`);
      const r = await repairLib.fix(gameDir, versionId, ({ done, total, rel }) => {
        if (done === total || done % 10 === 0) logLine(`> 补全依赖 ${done}/${total} · ${path.basename(rel)}`);
      });
      if (r.remaining.length) {
        return {
          ok: false,
          error: `启动失败：${r.remaining.length} 个依赖文件补全失败（例如 ${repairLib.coordOf(
            r.remaining[0].rel
          )}）。请检查网络后重试，或在「版本」页重新安装这个版本。`,
        };
      }
      logLine(`> 依赖已补全（${r.fixed} 个文件），继续启动`);
    }

    // 文件齐了但主类还是不在任何 jar 里，说明这份版本 JSON 和库对不上，先提醒一句
    const diag = repairLib.diagnose(gameDir, versionId);
    if (diag.mainClass && diag.found === false) {
      logLine(`> 提示：启动主类 ${diag.mainClass} 不在 classpath 的任何 jar 里，这个版本的库可能不完整`);
    }
    return { ok: true };
  }

  // 常见崩法一句话解释，省得用户对着 Java 的报错发呆
  // 只挑判断明确的几条：ClassNotFoundException 在模组缺前置时也会出现，不能一律归因于版本文件
  const LOG_HINTS = [
    [
      /找不到或无法加载主类|Could not find or load main class/i,
      '版本依赖文件不完整。点日志右上角「修复依赖」可自动补全，或在版本页重新安装该版本。',
    ],
    [/UnsupportedClassVersionError/i, 'Java 版本不符，请在「设置 → Java 运行时」里换成本版本要求的版本。'],
    [/Failed to locate library|UnsatisfiedLinkError/i, '缺少本机 DLL，点日志右上角「修复依赖」重新下载本地库。'],
    [/IllegalStateException: Duplicate key/i, 'classpath 里有重复的库，点日志右上角「修复依赖」或在版本页重新安装。'],
    [
      /无效会话|Invalid session|Failed to verify username|Failed to log in|Invalid credentials/i,
      '服务器开启了正版验证（Hypixel、多数公共服都是）。请在「设置 → 账号」用微软正版账号登录，离线账户进不去。',
    ],
  ];

  handle('game:launch', async (_e, { id, dir } = {}) => {
    if (gameProc) return { ok: false, error: '游戏已在运行中' };
    const versionId = safe.assertVersionId(id);
    const gameDir = dir ? assertInGameDirs(dir, '游戏目录') : settingsLib.all().mcDir;
    const settings = settingsLib.all();
    const logLine = (line) => win && !win.isDestroyed() && win.webContents.send('game:log', { line });
    try {
      const meta = versionLib.loadVersionJson(gameDir, versionId);

      const deps = await ensureDeps(gameDir, versionId, logLine);
      if (!deps.ok) return deps;

      if (!javaCache.length) await refreshJava().catch(() => {});
      const required = (meta.javaVersion && meta.javaVersion.majorVersion) || 8;
      const preferred = settings.javaPath
        ? javaCache.find((j) => j.java === settings.javaPath || j.path === settings.javaPath)
        : null;
      const picked = preferred || javaLib.pick(javaCache, required);

      if (!picked) {
        const have = javaCache.length
          ? javaCache.map((j) => j.major).sort((a, b) => a - b).join(' / ')
          : '无';
        return {
          ok: false,
          error: `该版本需要 Java ${required}，本机检测到的是 Java ${have}。请安装 Java ${required}，或在「设置 → Java 运行时」里手动指定。`,
        };
      }

      const account = settings.loginMode === 'msa' ? await freshAccount() : null;
      if (settings.loginMode === 'msa' && !account) {
        return { ok: false, error: '正版账号已失效，请在「设置 → 账号」重新登录' };
      }
      const runtime = {
        ...settings,
        javaPath: assertUsableJava(picked.path),
        sourceDir: gameDir,
        account: account
          ? { name: account.name, uuid: account.uuid, accessToken: account.accessToken, xuid: account.xuid }
          : null,
      };
      // 离线账户进正版验证服务器只会得到「无效会话」，提前写进日志免得白试
      if (!account && win && !win.isDestroyed()) {
        win.webContents.send('game:log', {
          line: '> 离线账户：Hypixel 等开启正版验证的服务器会提示「无效会话」，需先在「设置 → 账号」登录微软账号',
        });
      }
      if (picked.major !== required && win && !win.isDestroyed()) {
        win.webContents.send('game:log', {
          line: `> 提示：${versionId} 需要 Java ${required}，当前使用 Java ${picked.major}，可能无法正常启动`,
        });
      }

      const hinted = new Set();
      const proc = launcher.launch(versionId, runtime, {
        onLog: (line) => {
          logLine(line);
          for (const [re, hint] of LOG_HINTS) {
            if (hinted.has(re) || !re.test(line)) continue;
            hinted.add(re);
            logLine(`> 提示：${hint}`);
          }
        },
        onError: (err) => win && !win.isDestroyed() && win.webContents.send('game:error', { message: err.message }),
        onExit: (code) => {
          gameProc = null;
          if (win && !win.isDestroyed()) win.webContents.send('game:exit', { code });
        },
      });

      gameProc = proc.child;
      return {
        ok: true,
        data: { pid: proc.pid, java: picked, required, command: proc.command },
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  handle('game:kill', async () => {
    if (!gameProc) return { ok: false, error: '没有正在运行的游戏' };
    try {
      gameProc.kill();
      gameProc = null;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 手动补全依赖（日志面板的「修复依赖」）
  handle('game:repair', async (_e, { id, dir } = {}) => {
    const versionId = safe.assertVersionId(id);
    const gameDir = dir ? assertInGameDirs(dir, '游戏目录') : settingsLib.all().mcDir;
    const logLine = (line) => win && !win.isDestroyed() && win.webContents.send('game:log', { line });
    try {
      const before = repairLib.check(gameDir, versionId);
      if (!before.missing.length) {
        return { ok: true, data: { total: 0, fixed: 0, remaining: [], diagnose: repairLib.diagnose(gameDir, versionId) } };
      }
      logLine(`> 依赖自检：发现 ${before.missing.length} 个文件缺失，正在补全…`);
      const r = await repairLib.fix(gameDir, versionId, ({ done, total, rel }) => {
        if (done === total || done % 10 === 0) logLine(`> 补全依赖 ${done}/${total} · ${path.basename(rel)}`);
      });
      if (r.remaining.length) {
        logLine(`> 仍有 ${r.remaining.length} 个文件补全失败，例如 ${repairLib.coordOf(r.remaining[0].rel)}`);
      } else {
        logLine(`> 依赖已补全（${r.fixed} 个文件）`);
      }
      return { ok: true, data: r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  handle('settings:save', async (_e, patch) => {
    const clean = sanitizeSettingsPatch(patch);
    const next = settingsLib.save(clean);
    if (clean.javaPath !== undefined) {
      await refreshJava().catch(() => {});
    }
    return { ok: true, data: next };
  });

  // ---------------- 背景图（主题自定义） ----------------
  handle('wallpaper:pick', async () => {
    const r = await wallpaperLib.pick(win && !win.isDestroyed() ? win : undefined);
    return { ok: true, data: r };
  });

  handle('wallpaper:clear', async () => {
    const removed = wallpaperLib.clearAll();
    const next = settingsLib.save({ wallpaper: { enabled: false, image: '' } });
    return { ok: true, data: { removed, settings: next } };
  });

  handle('wallpaper:open', async () => {
    const dir = wallpaperLib.ensureDir();
    const err = await shell.openPath(dir);
    if (err) throw new Error(err);
    return { ok: true, data: { dir } };
  });

  // ---------------- 应用自身的更新 ----------------
  handle('update:check', async (_e, { silent = false } = {}) => {
    const r = await updater.check();
    if (r.ok && r.hasUpdate && win && !win.isDestroyed()) {
      win.webContents.send('update:available', r);
    } else if (!r.ok && !silent && win && !win.isDestroyed()) {
      win.webContents.send('update:failed', r);
    }
    return r;
  });

  // S3 + S4：不接受渲染进程传来的 asset，安装的永远是 check() 记录、并已校验 SHA256 的那一份
  handle('update:install', async (_e, { asset } = {}) => {
    if (win && !win.isDestroyed()) win.webContents.send('update:progress', { stage: 'download', percent: 0 });
    await updater.install(asset, (received, total) => {
      const percent = total ? Math.min(99, Math.round((received / total) * 100)) : 0;
      if (win && !win.isDestroyed()) {
        win.webContents.send('update:progress', { stage: 'download', percent, received, total });
      }
    });
    if (win && !win.isDestroyed()) win.webContents.send('update:progress', { stage: 'done', percent: 100 });
    settingsLib.save({ lastSeenVersion: '', pendingUpdate: true });
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 1200);
    return { ok: true };
  });

  handle('app:info', async () => ({
    ok: true,
    data: {
      version: app.getVersion(),
      packaged: app.isPackaged,
      repo: updater.REPO,
      electron: process.versions.electron,
    },
  }));

  // ---------------- 显卡偏好 ----------------
  // 把每个实例实际会用到的 javaw.exe 写进 Windows 图形设置，让 MC 走独立显卡。
  handle('gpu:applyAll', async (_e, { mode = 'high' } = {}) => {
    if (!gpuLib.supported()) return { ok: false, error: '该功能仅支持 Windows' };
    if (!(mode in gpuLib.MODES)) return { ok: false, error: `未知的显卡模式：${mode}` };
    try {
      if (!javaCache.length) await refreshJava().catch(() => {});
      const settings = settingsLib.all();
      const installed = versionLib.listInstalled(getDirs());
      const exePaths = [];
      const versions = [];

      for (const v of installed) {
        // listInstalled 已经把 javaVersion.majorVersion 读出来了，不必再解析一遍 JSON
        const required = v.javaMajor || 8;
        const preferred = settings.javaPath
          ? javaCache.find((j) => j.java === settings.javaPath || j.path === settings.javaPath)
          : null;
        const picked = preferred || javaLib.pick(javaCache, required);
        if (!picked) continue;
        exePaths.push(picked.path);
        versions.push({ id: v.id, java: picked.path, required, actual: picked.major });
      }

      // 没有实例时，至少把手动指定的 Java 也写进去
      if (settings.javaPath) exePaths.push(settings.javaPath);

      const result = await gpuLib.applyAll(exePaths, mode);
      return { ok: true, data: { ...result, versions, count: versions.length } };
    } catch (e) {
      return { ok: false, error: gpuLib.friendly(e) };
    }
  });

  handle('dialog:pickDir', async () => {
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择目录',
    });
    return { ok: true, data: res.canceled ? null : res.filePaths[0] };
  });

  handle('dialog:pickJava', async () => {
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      title: '选择 javaw.exe',
      filters: [{ name: 'Java 可执行文件', extensions: ['exe'] }],
    });
    const picked = res.canceled ? null : res.filePaths[0];
    // 记录用户亲自选过的路径，settings:save 只认这个集合 + 自动检测结果
    return { ok: true, data: picked };
  });

  // ---------------- 整合包（Modrinth / CurseForge） ----------------
  /** 按版本号从 Mojang 清单里找原版下载地址，整合包要拿它补底座 */
  const vanillaUrl = async (mcVersion) => {
    try {
      const data = await versionLib.getManifest(settingsLib.all().downloadSource, {});
      const hit = (data.versions || []).find((v) => v.id === mcVersion);
      return hit ? hit.url : '';
    } catch {
      return '';
    }
  };

  /** 按原版要求挑 Java，安装器要用 java.exe 才能拿到输出 */
  const javaFor = async (mcVersion) => {
    const settings = settingsLib.all();
    let required = 17;
    try {
      const meta = versionLib.loadVersionJson(settings.mcDir, mcVersion);
      required = (meta.javaVersion && meta.javaVersion.majorVersion) || 17;
    } catch {
      /* 元数据读不到就按 17 兜底 */
    }
    if (!javaCache.length) await refreshJava().catch(() => {});
    const preferred = settings.javaPath
      ? javaCache.find((j) => j.java === settings.javaPath || j.path === settings.javaPath)
      : null;
    const picked = preferred || javaLib.pick(javaCache, required);
    return picked ? picked.java || picked.path : '';
  };

  const cfKey = () => settingsLib.all().cfApiKey || '';

  handle('modpack:search', async (_e, { source, query, offset = 0 }) => {
    try {
      if (source === 'curseforge') {
        if (!cfKey()) return { ok: false, needKey: true, error: '需要 CurseForge API Key' };
        return { ok: true, data: await curseforgeLib.search(cfKey(), query, { offset }) };
      }
      return { ok: true, data: await modrinthLib.search(query, { offset }) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  handle('modpack:versions', async (_e, { source, projectId } = {}) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(projectId || ''))) throw new Error('项目 ID 不合法');
    if (source === 'curseforge') {
      if (!cfKey()) return { ok: false, needKey: true, error: '需要 CurseForge API Key' };
      return { ok: true, data: await curseforgeLib.files(cfKey(), projectId) };
    }
    return { ok: true, data: await modrinthLib.versions(projectId) };
  });

  handle('modpack:install', async (_e, { source, downloadUrl, fileName, mcVersion } = {}) => {
    if (source !== 'modrinth' && source !== 'curseforge') throw new Error('未知的整合包来源');
    const mc = safe.assertVersionId(mcVersion, '游戏版本');
    // 整合包文件只能来自两个 CDN，避免借安装流程下载任意内容
    safe.assertHttpUrl(downloadUrl, safe.PACK_HOSTS, '整合包下载地址');
    const name = String(fileName || '');
    if (!/^[A-Za-z0-9._ +-]{1,120}\.(jar|zip|mrpack)$/i.test(name)) throw new Error('整合包文件名不合法');

    const send = (p) => {
      if (win && !win.isDestroyed()) win.webContents.send('modpack:progress', p);
    };
    try {
      const baseUrl = await vanillaUrl(mc);
      const javaPath = await javaFor(mc);
      const common = {
        gameDir: settingsLib.all().mcDir,
        downloadUrl,
        fileName: name,
        javaPath,
        source: settingsLib.all().downloadSource === 'mojang' ? 'mojang' : 'bmcl',
        baseUrl,
        onProgress: send,
      };
      const r =
        source === 'curseforge'
          ? await curseforgeLib.installVersion({ ...common, apiKey: cfKey() })
          : await modrinthLib.installVersion(common);
      if (r.ok) send({ stage: 'done', message: '安装完成', percent: 100 });
      return r;
    } catch (e) {
      send({ stage: 'error', message: e.message });
      return { ok: false, error: e.message };
    }
  });

  handle('modpack:setKey', async (_e, { key }) => {
    const r = await settingsLib.save({ cfApiKey: String(key || '').trim() });
    return { ok: true, data: r };
  });

  // ---------------- 模组加载器 ----------------
  const sourceOf = () => (settingsLib.all().downloadSource === 'mojang' ? 'mojang' : 'bmcl');

  handle('loader:list', async (_e, { loader, mc }) => {
    try {
      return await loadersLib.listVersions(loader, mc, sourceOf());
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  handle('loader:install', async (_e, { loader, mc, loaderVersion, url } = {}) => {
    const LOADERS = new Set(['forge', 'fabric', 'quilt', 'neoforge', 'liteloader', 'optifine']);
    if (!LOADERS.has(String(loader || '').toLowerCase())) throw new Error('未知的模组加载器');
    const mcVersion = safe.assertVersionId(mc, '游戏版本');
    const loaderVer = safe.assertVersionId(loaderVersion, '加载器版本');
    if (url) safe.assertHttpUrl(url, safe.GAME_HOSTS, '版本元数据地址');

    const settings = settingsLib.all();
    const gameDir = settings.mcDir;

    const send = (p) => {
      if (win && !win.isDestroyed()) win.webContents.send('loader:progress', p);
    };

    // 底座没装就先补原版，否则加载器装完也启动不了
    const baseJson = safe.safeJoin(path.join(gameDir, 'versions'), mcVersion, `${mcVersion}.json`);
    if (!fs.existsSync(baseJson)) {
      if (!url) return { ok: false, error: `还没有安装原版 ${mcVersion}，请先在下方列表里下载` };
      send({ stage: 'base', message: `先补装原版 ${mcVersion}` });
      try {
        await installer.install(mcVersion, { url }, sourceOf(), (p) => {
          if (p && p.stage) send({ stage: 'base', percent: p.percent, message: `原版 ${mcVersion}：${p.message || ''}` });
        });
      } catch (e) {
        send({ stage: 'error', message: `原版安装失败：${e.message}` });
        return { ok: false, error: `原版安装失败：${e.message}` };
      }
    }

    // 按原版声明的 javaVersion 挑合适的运行时；安装器必须用 java.exe 才能拿到输出
    let required = 17;
    try {
      const meta = versionLib.loadVersionJson(gameDir, mcVersion);
      required = (meta.javaVersion && meta.javaVersion.majorVersion) || 17;
    } catch {
      /* 元数据读不到就按 17 兜底 */
    }
    if (!javaCache.length) await refreshJava().catch(() => {});
    const preferred = settings.javaPath
      ? javaCache.find((j) => j.java === settings.javaPath || j.path === settings.javaPath)
      : null;
    const picked = preferred || javaLib.pick(javaCache, required);
    const javaPath = picked ? assertUsableJava(picked.java || picked.path) : '';

    const r = await loadersLib.install({
      loader: String(loader).toLowerCase(),
      mcVersion,
      loaderVersion: loaderVer,
      gameDir,
      javaPath,
      source: sourceOf(),
      onProgress: send,
    });
    if (r.ok) send({ stage: 'done', message: '安装完成', id: r.data.id });
    return r;
  });
  // ---------------- 整合包导入 ----------------
  handle('pack:pick', async () => {
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      title: '选择整合包',
      filters: [{ name: '整合包 / 压缩包', extensions: ['zip', 'mrpack'] }],
    });
    return { ok: true, data: res.canceled ? null : res.filePaths[0] };
  });

  handle('pack:inspect', async (_e, { file } = {}) => {
    if (typeof file !== 'string' || !file) return { ok: false, error: '没有拿到有效的整合包路径' };
    if (!/\.(zip|mrpack)$/i.test(file)) return { ok: false, error: '只支持 zip / mrpack 整合包' };
    const resolved = path.resolve(file);
    let st;
    try {
      st = fs.statSync(resolved);
    } catch {
      return { ok: false, error: '整合包文件不存在' };
    }
    if (!st.isFile()) return { ok: false, error: '整合包路径不是文件' };
    return packLib.inspect(resolved);
  });

  handle('pack:import', async (_e, { file, targetDir } = {}) => {
    if (typeof file !== 'string' || !file) return { ok: false, error: '没有拿到有效的整合包路径' };
    if (!/\.(zip|mrpack)$/i.test(file)) return { ok: false, error: '只支持 zip / mrpack 整合包' };
    const resolved = path.resolve(file);
    let st;
    try {
      st = fs.statSync(resolved);
    } catch {
      return { ok: false, error: '整合包文件不存在' };
    }
    if (!st.isFile()) return { ok: false, error: '整合包路径不是文件' };
    // 导入目标只能是已登记的游戏目录，不能借 targetDir 往任意位置写
    const dir = targetDir ? assertInGameDirs(targetDir, '导入目录') : path.resolve(settingsLib.all().mcDir);
    const r = await packLib.importPack({ zipPath: resolved, targetDir: dir });
    if (r.ok) {
      // 导入后重新扫一遍，让列表立刻出现新实例
      await refreshJava().catch(() => {});
    }
    return r;
  });

  // ---------------- 资源下载（模组 / 光影 / 材质包） ----------------
  handle('content:search', async (_e, { kind, query, mcVersion, loader, offset, sort } = {}) => {
    try {
      return {
        ok: true,
        data: await contentLib.search(kind, { query, mcVersion, loader, offset, sort }),
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  handle('content:versions', async (_e, { kind, projectId, mcVersion, loader } = {}) => {
    try {
      if (!projectId || typeof projectId !== 'string') throw new Error('缺少项目 ID');
      return { ok: true, data: await contentLib.versions(projectId, { mcVersion, loader, kind }) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  handle('content:plan', async (_e, { dir, instanceId, kind, versionId, mcVersion, loader } = {}) => {
    try {
      const gameDir = dir ? assertInGameDirs(dir, '游戏目录') : path.resolve(settingsLib.all().mcDir);
      const p = await contentLib.plan({
        gameDir,
        instanceId: safe.assertVersionId(instanceId),
        kind,
        versionId,
        mcVersion,
        loader,
      });
      return { ok: true, data: p };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  handle('content:install', async (_e, { dir, instanceId, kind, versionId, mcVersion, loader, planned } = {}) => {
    const gameDir = dir ? assertInGameDirs(dir, '游戏目录') : path.resolve(settingsLib.all().mcDir);
    const send = (p) => {
      if (win && !win.isDestroyed()) win.webContents.send('content:progress', p);
    };
    try {
      return await contentLib.install({
        gameDir,
        instanceId: safe.assertVersionId(instanceId),
        kind,
        versionId,
        mcVersion,
        loader,
        planned,
        onProgress: send,
      });
    } catch (e) {
      send({ stage: 'error', message: e.message });
      return { ok: false, error: e.message };
    }
  });

  // ---------------- 导出整合包 ----------------
  /** 只读：列出可导出的内容，供界面勾选 */
  handle('pack:exportPlan', async (_e, { dir, id } = {}) => {
    try {
      const gameDir = dir ? assertInGameDirs(dir, '游戏目录') : path.resolve(settingsLib.all().mcDir);
      const versionId = safe.assertVersionId(id);
      const p = exportLib.plan({ gameDir, id: versionId });
      const instDir = path.join(gameDir, 'versions', versionId);
      return {
        ok: true,
        data: {
          id: p.id,
          mc: p.mc,
          loader: p.loader,
          java: p.java,
          hasJar: p.hasJar,
          // 非隔离实例的 mods/config 在游戏根目录，导不出去，必须提前说清楚
          isolated: require('./core/dirs').isIsolatedInstance(instDir),
          items: p.items.map((it) => ({
            key: it.key,
            label: it.label,
            enabled: it.enabled,
            available: it.available,
            files: it.files,
            bytes: it.bytes,
          })),
        },
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /** 选保存位置 */
  handle('pack:exportPick', async (_e, { defaultName } = {}) => {
    const safeName = String(defaultName || 'SMUCL整合包').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    const res = await dialog.showSaveDialog(win, {
      title: '保存整合包',
      defaultPath: path.join(app.getPath('desktop'), `${safeName}.zip`),
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
    });
    if (res.canceled || !res.filePath) return { ok: true, data: null };
    let out = res.filePath;
    if (!/\.zip$/i.test(out)) out += '.zip';
    return { ok: true, data: out };
  });

  handle('pack:export', async (_e, { dir, id, outPath, include } = {}) => {
    if (typeof outPath !== 'string' || !outPath) return { ok: false, error: '没有选择保存位置' };
    const gameDir = dir ? assertInGameDirs(dir, '游戏目录') : path.resolve(settingsLib.all().mcDir);
    const versionId = safe.assertVersionId(id);
    const send = (p) => {
      if (win && !win.isDestroyed()) win.webContents.send('pack:exportProgress', p);
    };
    const r = await exportLib.exportInstance({
      gameDir,
      id: versionId,
      outPath: path.resolve(outPath),
      include,
      onProgress: send,
    });
    if (r.ok) send({ percent: 100, message: '导出完成' });
    return r;
  });

  // S6：只允许打开游戏目录子树内的路径，'game' 是主目录的别名
  handle('open:path', async (_e, { target } = {}) => {
    const resolved =
      target === 'game' || !target ? path.resolve(settingsLib.all().mcDir) : assertInGameDirs(String(target));
    if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
    const err = await shell.openPath(resolved);
    if (err) throw new Error(err);
    return { ok: true };
  });

  handle('open:url', async (_e, { url } = {}) => {
    if (!safe.isHttpUrl(url)) throw new Error('非法链接');
    await shell.openExternal(url);
    return { ok: true };
  });

  // 无边框窗口控制（同样校验来源，避免被外部页面操控窗口）
  const onWin = (channel, fn) =>
    ipcMain.on(channel, (event) => {
      try {
        assertSender(event);
        fn();
      } catch (e) {
        console.warn('[ipc] 拒绝窗口调用', channel, e.message);
      }
    });
  onWin('win:minimize', () => win && win.minimize());
  onWin('win:maximize', () => {
    if (!win) return;
    win.isMaximized() ? win.unmaximize() : win.maximize();
  });
  onWin('win:close', () => win && win.close());
}

// ------------------------------------------------------------------ 生命周期
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    app.setAppUserModelId('cn.edu.shmtu.smucl');
    wallpaperLib.registerHandler();
    settingsLib.ensureGameDir();
    adoptLauncherDirIfNeeded();
    registerIpc();
    createWindow();

    // 启动后延迟检查一次最新版本，之后每 5 分钟一次
    setTimeout(() => checkLatest(false), 4000);
    setInterval(() => {
      if (settingsLib.all().autoCheck) checkLatest(true);
    }, 5 * 60 * 1000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
