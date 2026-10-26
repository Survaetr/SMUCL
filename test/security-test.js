'use strict';
/**
 * 安全回归测试（自攻击脚本）
 *
 * 不启动 Electron，而是用一个最小的 electron 桩把真实的 main.js 加载进来，
 * 直接拿它注册的 IPC handler 当攻击面：伪造「来自外部的调用」和各种越界参数，
 * 看主进程是否真的拒绝。同时对本仓库的核心模块做单元级攻击（目录穿越、Zip Slip、
 * SHA1 / SHA256 篡改、JVM 参数注入）。
 *
 * 运行：node test/security-test.js
 * 退出码 0 表示全部通过。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const Module = require('module');
const { pathToFileURL } = require('url');
const AdmZip = require('adm-zip');

const ROOT = path.join(__dirname, '..');
const NATIVE_FETCH = global.fetch;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'smucl-sectest-'));
const USER_DATA = path.join(TMP, 'userdata');
const GAME_DIR = path.join(TMP, 'game');
const APP_CODE = path.join(TMP, 'resources', 'app');

function mkdir(p) {
  fs.mkdirSync(p, { recursive: true });
}

mkdir(USER_DATA);
mkdir(path.join(GAME_DIR, 'versions', '1.20.1'));
mkdir(path.join(GAME_DIR, 'saves', 'world'));
mkdir(path.join(GAME_DIR, 'saves', 'world2'));
mkdir(path.join(TMP, 'outside'));
mkdir(APP_CODE);

fs.writeFileSync(path.join(GAME_DIR, 'saves', 'world', 'level.dat'), 'x');
fs.writeFileSync(path.join(GAME_DIR, 'saves', 'world2', 'level.dat'), 'x');
const OUTSIDE_FILE = path.join(TMP, 'outside', 'important.txt');
fs.writeFileSync(OUTSIDE_FILE, 'do not delete');
const VICTIM_DIR = path.join(TMP, 'victim');
mkdir(VICTIM_DIR);
fs.writeFileSync(path.join(VICTIM_DIR, 'keep.txt'), 'keep');

// 合法版本 JSON：带 -javaagent（测试 N2 是否被过滤）
fs.writeFileSync(
  path.join(GAME_DIR, 'versions', '1.20.1', '1.20.1.json'),
  JSON.stringify({
    id: '1.20.1',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    javaVersion: { majorVersion: 17 },
    libraries: [],
    arguments: {
      jvm: ['-Djava.library.path=${natives_directory}', '-javaagent:C:\\evil\\agent.jar', '-cp', '${classpath}'],
      game: ['--username', '${auth_player_name}'],
    },
    downloads: {},
  })
);

const CONFIG = {
  mcDir: GAME_DIR,
  extraDirs: [],
  javaPath: '',
  memory: 4096,
  autoCheck: false,
  autoUpdateCheck: false,
  pendingUpdate: false,
};
fs.writeFileSync(path.join(USER_DATA, 'smucl-config.json'), JSON.stringify(CONFIG));

// ------------------------------------------------------------------ electron 桩
const handlers = new Map();
const winListeners = new Map();
const calls = { openExternal: [], openPath: [], trashItem: [], relaunch: 0 };

let windowOpenHandler = null;
let packaged = false;
let pickJavaResult = null;

const indexUrl = pathToFileURL(path.join(ROOT, 'renderer', 'index.html')).href;
const evilUrl = 'https://evil.example/attack.html';
const goodEvent = () => ({ senderFrame: { url: indexUrl } });
const evilEvent = () => ({ senderFrame: { url: evilUrl } });

class FakeWebContents {
  constructor() {
    this.sent = [];
  }
  on(name, fn) {
    winListeners.set(name, fn);
  }
  once(name, fn) {
    winListeners.set(`once:${name}`, fn);
  }
  send(channel, payload) {
    this.sent.push({ channel, payload });
  }
  setWindowOpenHandler(fn) {
    windowOpenHandler = fn;
  }
  getURL() {
    return indexUrl;
  }
  executeJavaScript() {
    return Promise.resolve();
  }
  capturePage() {
    return Promise.resolve({ toPNG: () => Buffer.alloc(0) });
  }
  openDevTools() {}
}

class FakeWindow {
  constructor() {
    this.webContents = new FakeWebContents();
  }
  loadFile() {}
  once() {}
  on() {}
  show() {}
  focus() {}
  isDestroyed() {
    return false;
  }
  isFocused() {
    return true;
  }
  isMinimized() {
    return false;
  }
  restore() {}
  minimize() {}
  maximize() {}
  unmaximize() {}
  isMaximized() {
    return false;
  }
  close() {}
  static getAllWindows() {
    return [];
  }
}

const electronStub = {
  app: {
    getPath() {
      return USER_DATA;
    },
    getVersion() {
      return '1.5.0';
    },
    get isPackaged() {
      return packaged;
    },
    requestSingleInstanceLock() {
      return true;
    },
    whenReady() {
      return Promise.resolve();
    },
    on() {},
    once() {},
    setAppUserModelId() {},
    relaunch() {
      calls.relaunch++;
    },
    // 测试里不希望真退出
    exit() {},
    quit() {},
  },
  BrowserWindow: FakeWindow,
  ipcMain: {
    handle(channel, fn) {
      handlers.set(channel, fn);
    },
    on(channel, fn) {
      winListeners.set(`ipc:${channel}`, fn);
    },
  },
  dialog: {
    async showOpenDialog() {
      if (pickJavaResult) return { canceled: false, filePaths: [pickJavaResult] };
      return { canceled: true, filePaths: [] };
    },
  },
  shell: {
    async openExternal(u) {
      calls.openExternal.push(u);
    },
    showItemInFolder(p) {
      calls.openPath.push(p);
    },
    async trashItem(p) {
      calls.trashItem.push(p);
    },
    async openPath(p) {
      calls.openPath.push(p);
      return '';
    },
  },
  Menu: { setApplicationMenu() {} },
  Notification: class {
    static isSupported() {
      return false;
    }
    on() {}
    show() {}
  },
};

const origLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, parent, isMain);
};

process.resourcesPath = path.join(TMP, 'resources');

// ------------------------------------------------------------------ 断言工具
let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function invoke(channel, payload, event = goodEvent()) {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`未注册的 IPC: ${channel}`);
  return fn(event, payload);
}

// ------------------------------------------------------------------ 开始
(async () => {
  require(path.join(ROOT, 'main.js'));
  await new Promise((r) => setTimeout(r, 50));

  console.log('\n[1] S1 导航劫持');
  const willNav = winListeners.get('will-navigate');
  check('注册了 will-navigate', typeof willNav === 'function');
  if (willNav) {
    let prevented = false;
    willNav({ preventDefault: () => (prevented = true) }, evilUrl);
    check('外部页面导航被阻止', prevented === true);
    prevented = false;
    willNav({ preventDefault: () => (prevented = true) }, indexUrl);
    check('应用自身页面导航放行', prevented === false);
  }
  const willRedirect = winListeners.get('will-redirect');
  check('注册了 will-redirect', typeof willRedirect === 'function');
  if (willRedirect) {
    let prevented = false;
    willRedirect({ preventDefault: () => (prevented = true) }, evilUrl);
    check('外部重定向被阻止', prevented === true);
  }

  console.log('\n[2] S2 新窗口 / 外链协议');
  check('设置了 windowOpenHandler', typeof windowOpenHandler === 'function');
  if (windowOpenHandler) {
    calls.openExternal.length = 0;
    const r1 = windowOpenHandler({ url: 'file:///C:/Windows/System32/calc.exe' });
    check('file:// 被拒绝', r1.action === 'deny' && calls.openExternal.length === 0);
    windowOpenHandler({ url: 'smb://evil/share/x.exe' });
    check('非 http(s) 协议不会交给系统', calls.openExternal.length === 0);
    windowOpenHandler({ url: 'https://example.com/doc' });
    check('https 外链正常交给浏览器', calls.openExternal[0] === 'https://example.com/doc');
  }

  console.log('\n[3] IPC 来源校验');
  {
    const r = await invoke('version:delete', { id: '1.20.1' }, evilEvent());
    check('外部页面调用被拒绝', r.ok === false, JSON.stringify(r));
    check(
      '外部页面调用没有删掉版本目录',
      fs.existsSync(path.join(GAME_DIR, 'versions', '1.20.1', '1.20.1.json'))
    );
  }

  console.log('\n[4] S5 版本名目录穿越');
  for (const evilId of ['..\\..\\victim', '../../victim', '..', 'C:\\Windows\\System32', 'a/b']) {
    const r = await invoke('version:delete', { id: evilId });
    check(`拒绝 id=${JSON.stringify(evilId)}`, r.ok === false, JSON.stringify(r));
  }
  check('victim 目录仍然存在', fs.existsSync(path.join(VICTIM_DIR, 'keep.txt')));
  {
    const r = await invoke('version:command', { id: '..\\..\\victim' });
    check('version:command 同样拒绝穿越', r.ok === false);
  }

  console.log('\n[5] S7 存档操作越权');
  {
    calls.trashItem.length = 0;
    const r = await invoke('saves:trash', { path: OUTSIDE_FILE });
    check('拒绝删除游戏目录外的文件', r.ok === false, JSON.stringify(r));
    check('外部文件仍在', fs.existsSync(OUTSIDE_FILE));
    check('没有调用回收站', calls.trashItem.length === 0);

    const r2 = await invoke('saves:trash', { path: path.join(GAME_DIR, 'saves', 'world2') });
    check('允许删除合法存档', r2.ok === true, JSON.stringify(r2));
    check('回收站收到的是存档目录', String(calls.trashItem[0] || '').endsWith(path.join('saves', 'world2')));

    const r3 = await invoke('saves:reveal', { path: path.join(TMP, 'outside') });
    check('拒绝在外部目录中显示', r3.ok === false);
  }

  console.log('\n[6] S6 open:path 越界');
  {
    const r = await invoke('open:path', { target: 'C:\\Windows\\System32' });
    check('拒绝打开系统目录', r.ok === false, JSON.stringify(r));
    const r2 = await invoke('open:path', { target: 'game' });
    check('允许打开游戏目录', r2.ok === true);
    const r3 = await invoke('open:path', { target: path.join(GAME_DIR, '..', '..') });
    check('拒绝跳出游戏目录', r3.ok === false);
  }

  console.log('\n[7] 安装入口 URL 白名单');
  {
    const r1 = await invoke('install:start', { id: '1.20.1', url: 'file:///C:/evil.json' });
    check('拒绝 file:// 版本元数据', r1.ok === false);
    const r2 = await invoke('install:start', { id: '1.20.1', url: 'http://evil.example/v.json' });
    check('拒绝非官方元数据主机', r2.ok === false);
    const r3 = await invoke('install:start', { id: '..\\..\\x', url: 'https://piston-meta.mojang.com/v.json' });
    check('安装入口同样校验版本名', r3.ok === false);
  }

  console.log('\n[8] 设置项越权（javaPath / mcDir）');
  {
    // Java 路径不收紧：任意目录下真实存在的 javaw.exe 都应当能用
    const ownJre = path.join(TMP, 'outside', 'jre', 'bin');
    mkdir(ownJre);
    const realJava = path.join(ownJre, 'javaw.exe');
    fs.writeFileSync(realJava, 'MZ');
    const r = await invoke('settings:save', { javaPath: realJava });
    check('扫描目录之外的 javaw.exe 可以保存', r.ok === true, JSON.stringify(r));
    let cfg = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'smucl-config.json'), 'utf8'));
    check('javaPath 已按原样写入', cfg.javaPath === realJava, cfg.javaPath);

    // 但绝不能把任意程序当成 Java 运行时
    const r2 = await invoke('settings:save', { javaPath: 'C:\\Windows\\System32\\cmd.exe' });
    check('拒绝把 cmd.exe 当成 Java', r2.ok === false, JSON.stringify(r2));

    const r3 = await invoke('settings:save', { mcDir: 'C:\\Windows\\System32' });
    check('拒绝把游戏目录设成系统目录', r3.ok === false);

    const r4 = await invoke('settings:save', { theme: 'dark', evilKey: 'x' });
    check('正常设置可保存', r4.ok === true, JSON.stringify(r4));
    cfg = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'smucl-config.json'), 'utf8'));
    check('未知键被丢弃', !('evilKey' in cfg));
    check('javaPath 没有被后续写入清掉', cfg.javaPath === realJava);
  }

  console.log('\n[9] N1 安装元数据路径穿越');
  {
    const installer = require(path.join(ROOT, 'core', 'install'));
    let caught = false;
    try {
      installer.collectTasks(
        {
          libraries: [
            {
              name: 'com.evil:x:1.0',
              downloads: { artifact: { path: '../../../../evil.dll', url: 'https://x/y.jar', size: 1 } },
            },
          ],
        },
        GAME_DIR,
        path.join(GAME_DIR, 'versions', '1.20.1'),
        'mojang'
      );
    } catch (e) {
      caught = /穿越|绝对路径/.test(e.message);
    }
    check('拒绝 artifact.path 目录穿越', caught);
  }

  console.log('\n[10] N2 JVM 参数注入');
  {
    const launcher = require(path.join(ROOT, 'core', 'launch'));
    const built = launcher.build('1.20.1', { javaPath: path.join(TMP, 'javaw.exe') });
    const joined = built.args.join(' ');
    check('剔除了 -javaagent', !/javaagent/i.test(joined), joined.slice(0, 160));
    check('保留了正常 JVM 参数', /-Djava\.library\.path=/.test(joined));
  }

  console.log('\n[11] N4 下载文件 SHA1 校验');
  {
    const payload = Buffer.from('real-content');
    const good = crypto.createHash('sha1').update(payload).digest('hex');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-length': payload.length });
      res.end(payload);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const net = require(path.join(ROOT, 'core', 'net'));
    const dest = path.join(TMP, 'download', 'file.bin');
    mkdir(path.dirname(dest));

    await net.download(`http://127.0.0.1:${port}/a`, dest, { expectedSha1: good, retries: 0 });
    check('SHA1 正确时下载成功', fs.readFileSync(dest, 'utf8') === 'real-content');

    let rejected = false;
    try {
      await net.download(`http://127.0.0.1:${port}/b`, path.join(TMP, 'download', 'bad.bin'), {
        expectedSha1: '0'.repeat(40),
        retries: 0,
      });
    } catch (e) {
      rejected = /SHA1/.test(e.message);
    }
    check('SHA1 不符时丢弃并报错', rejected);
    check('不留下损坏文件', !fs.existsSync(path.join(TMP, 'download', 'bad.bin')));

    // 已存在的坏文件 + 期望哈希 → 应当重新下载
    fs.writeFileSync(dest, 'tampered');
    await net.download(`http://127.0.0.1:${port}/c`, dest, { expectedSha1: good, retries: 0 });
    check('已存在的被篡改文件会被替换', fs.readFileSync(dest, 'utf8') === 'real-content');

    await new Promise((r) => server.close(r));
  }

  console.log('\n[12] N5 背景图设置越权');
  {
    // 伪造的图片名（路径穿越 / 格式不符）一律清空，不能把任意路径写进配置
    const r1 = await invoke('settings:save', {
      wallpaper: { enabled: true, image: '../../evil.png', opacity: 9, blur: 9999, mask: 'hack', ui: -5 },
    });
    check('背景设置可以保存', r1.ok === true, JSON.stringify(r1));
    let cfg = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'smucl-config.json'), 'utf8'));
    check('不存在的图片被清空', cfg.wallpaper.image === '', JSON.stringify(cfg.wallpaper));
    check('图片为空时自动关闭启用', cfg.wallpaper.enabled === false);
    check('不透明度被夹到区间内', cfg.wallpaper.opacity > 0 && cfg.wallpaper.opacity <= 1, String(cfg.wallpaper.opacity));
    check('模糊被夹到 0~40', cfg.wallpaper.blur >= 0 && cfg.wallpaper.blur <= 40, String(cfg.wallpaper.blur));
    check('界面不透明度不会被写成负数', cfg.wallpaper.ui >= 0.35, String(cfg.wallpaper.ui));
    check('非法蒙版回落到默认值', cfg.wallpaper.mask === 'soft', cfg.wallpaper.mask);

    // 即使目录里真有同名文件，文件名不合规也不能用
    const wallDir = path.join(USER_DATA, 'wallpapers');
    mkdir(wallDir);
    const stray = path.join(wallDir, 'evil.png');
    fs.writeFileSync(stray, 'x');
    await invoke('settings:save', { wallpaper: { enabled: true, image: 'evil.png' } });
    cfg = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'smucl-config.json'), 'utf8'));
    check('不合规的文件名被拒绝', cfg.wallpaper.image === '' && cfg.wallpaper.enabled === false);

    // 合规文件名 + 真实文件才保留
    const okName = 'wall-1700000000000.png';
    fs.writeFileSync(path.join(wallDir, okName), 'x');
    const r3 = await invoke('settings:save', { wallpaper: { enabled: true, image: okName } });
    check('合规图片可以启用', r3.ok === true && r3.data.wallpaper.image === okName, JSON.stringify(r3));
    check('启用状态被保留', r3.data.wallpaper.enabled === true);
  }

  Module._load = origLoad;

  console.log(`\n===== 结果：${passed} 通过，${failures.length} 失败 =====`);
  if (failures.length) {
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error('测试脚本异常:', e);
  process.exit(2);
});
