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

// 新版 Electron / Node 把 process.resourcesPath 定义成只读属性，
// 直接赋值会抛 TypeError（Cannot assign to read only property），
// 这里用 defineProperty 覆盖成可写的值；万一也不允许就保留原值，
// 让受影响的用例自己报 FAIL，而不是整个脚本崩掉。
const FAKE_RESOURCES = path.join(TMP, 'resources');
try {
  Object.defineProperty(process, 'resourcesPath', {
    value: FAKE_RESOURCES,
    writable: true,
    configurable: true,
    enumerable: true,
  });
} catch {
  console.log(`  警告  无法覆盖 process.resourcesPath，继续使用 ${process.resourcesPath}`);
}

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

  console.log('\n[13] N6 皮肤头像参数校验');
  {
    // 只接受 UUID；其余一律拒绝，且不会去碰 skin 缓存目录
    const bad = ['../x', '', null, 'x'.repeat(40), '5bf37f37'];
    let allRejected = true;
    for (const v of bad) {
      const r = await invoke('account:skin', { uuid: v });
      if (r.ok !== false) {
        allRejected = false;
        console.log('  未拒绝:', JSON.stringify(v));
      }
    }
    check('非法 UUID 一律拒绝', allRejected);
  }

  {
    // 离线皮肤的读取/删除只接受玩家名，名字里的路径字符要被清洗掉：
    // 既不能读到 skins/local 之外的文件，也不能让 clear 误删别的东西
    const evil = ['../../smucl-config.json', '..\\..\\account.dat', 'C:/Windows/notepad.exe', '/etc/passwd'];
    let clean = true;
    for (const name of evil) {
      const r = await invoke('skin:local', { name });
      if (!r.ok || r.data !== null) {
        clean = false;
        console.log('  未落空:', JSON.stringify(name), JSON.stringify(r));
      }
      const c = await invoke('skin:clear', { name });
      if (!c.ok || (c.data && c.data.removed)) {
        clean = false;
        console.log('  误删:', JSON.stringify(name));
      }
    }
    check('离线皮肤名不会穿越目录', clean);
  }

  {
    // 空名字不能触发导入（导入会弹系统文件框，这里只验证前置拒绝）
    const r = await invoke('skin:import', { name: '   ' });
    check('空玩家名拒绝导入', r.ok === false);
  }

  console.log('\n[14] N7 壁纸取色与主题色');
  {
    // 取色入参是文件名，必须落在 wallpapers/ 目录内且符合命名规则
    let denied = true;
    for (const image of ['../../smucl-config.json', 'C:/Windows/win.ini', 'wall-1.png', '', null]) {
      const r = await invoke('wallpaper:palette', { image });
      if (!r.ok || r.data !== null) {
        denied = false;
        console.log('  未落空:', JSON.stringify(image), JSON.stringify(r));
      }
    }
    check('非壁纸目录的文件名不会触发取色', denied);
  }

  {
    // 主题色开关只接受两个枚举值
    const a = await invoke('settings:save', { accent: 'wallpaper' });
    check('主题色可以切到跟随壁纸', a.ok === true && a.data.accent === 'wallpaper');
    const b = await invoke('settings:save', { accent: 'rainbow' });
    check('非法主题色被拒绝', b.ok === false);
    const c = await invoke('settings:save', { accent: 'brand' });
    check('主题色可以切回校徽蓝', c.ok === true && c.data.accent === 'brand');
  }

  console.log('\n[15] N8 启动身份切换（正版 / 离线）');
  {
    const st = await invoke('auth:status');
    const logged = Boolean(st.ok && st.data && st.data.loggedIn);

    // 切离线永远允许：这是退路，不能因为账号失效就把人锁死
    const a = await invoke('auth:setMode', { mode: 'offline' });
    check('可以切到离线身份', a.ok === true && a.data.mode === 'offline');

    // 没登录就不许声称自己是正版
    if (!logged) {
      const b = await invoke('auth:setMode', { mode: 'msa' });
      check('未登录时切正版被拒绝', b.ok === false);
    }

    // 越界取值必须归一化，不能把任意字符串写进配置
    const c = await invoke('auth:setMode', { mode: 'admin' });
    check('非法身份取值被归一化为离线', c.ok === true && c.data.mode === 'offline');

    const d = await invoke('settings:save', { loginMode: 'msa' });
    check('设置层接受正版枚举', d.ok === true && d.data.loginMode === 'msa');
    const e = await invoke('settings:save', { loginMode: '../../evil' });
    check('设置层把非法身份归一化为离线', e.ok === true && e.data.loginMode === 'offline');
    const f = await invoke('settings:save', { loginMode: 'offline' });
    check('设置层可以切回离线', f.ok === true && f.data.loginMode === 'offline');
  }

  console.log('\n[16] N9 Java 运行时按需获取');
  {
    // 只接受三个受支持的版本号，且必须是数字：
    // 否则这个接口会变成「让主进程下载任意东西」的入口
    let denied = true;
    for (const major of [0, -1, 1, 8.5, 17.5, 99, '21', '8', null, undefined, 'abc', {}, [8]]) {
      const r = await invoke('java:ensure', { major });
      if (r.ok !== false) {
        denied = false;
        console.log('  未被拒绝:', JSON.stringify(major), JSON.stringify(r));
      }
    }
    check('非受支持的 Java 版本一律拒绝', denied);

    const jre = require(path.join(ROOT, 'core', 'jre'));
    check(
      '需求版本归一化到 8 / 17 / 21',
      [8, 11, 16, 17, 20, 21, 25].map(jre.normalizeMajor).join(',') === '8,17,17,17,17,21,21'
    );
    check(
      '归一化对非法输入兜底到 21',
      jre.normalizeMajor(undefined) === 21 && jre.normalizeMajor('x') === 21 && jre.normalizeMajor(0) === 21
    );
    // 找不到 java 时必须是空串，不能把目录当成可执行文件返回
    check('目录里没有 java 时返回空串', jre.findJava(path.join(TMP, 'no-such-jre')) === '');
    check('用不存在目录清理不抛异常', (() => {
      try {
        jre.removeTree(path.join(TMP, 'no-such-jre'));
        return true;
      } catch {
        return false;
      }
    })());
  }

  console.log('\n[17] N10 已装模组与实例默认设置');
  {
    const modsLib = require(path.join(ROOT, 'core', 'mods'));
    const optLib = require(path.join(ROOT, 'core', 'options'));

    // 造三个真假 jar：Fabric 元数据 / Forge mods.toml / 完全读不出的（无元数据）
    const modsDir = path.join(TMP, 'inst', 'mods');
    mkdir(modsDir);

    const makeJar = (name, entries) => {
      const z = new AdmZip();
      for (const [p, body] of Object.entries(entries)) z.addFile(p, Buffer.from(body, 'utf8'));
      z.writeZip(path.join(modsDir, name));
    };
    makeJar('sodium-fabric-0.5.8.jar', {
      'fabric.mod.json': JSON.stringify({ id: 'sodium', name: 'Sodium', version: '0.5.8' }),
    });
    makeJar('jei-1.20.1.jar', {
      'META-INF/mods.toml':
        'modLoader="javafml"\n[[mods]]\nmodId="jei"\ndisplayName="Just Enough Items"\nversion="${file.jarVersion}"\n',
      'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\nImplementation-Version: 15.2.0.27\n',
    });
    makeJar('mystery.jar', { 'readme.txt': 'nothing useful' });
    // 禁用的那份也要能被列出来
    fs.renameSync(path.join(modsDir, 'mystery.jar'), path.join(modsDir, 'mystery.jar.disabled'));

    const got = modsLib.list(modsDir);
    check('能列出 mods 目录里的全部 jar', got.total === 3, `实际 ${got.total}`);
    check('启用的只有 2 个（.disabled 不计）', got.enabled === 2, `实际 ${got.enabled}`);

    const byId = Object.fromEntries(got.mods.map((m) => [m.id || m.name, m]));
    check('Fabric 元数据读出名称与版本', byId.sodium && byId.sodium.name === 'Sodium' && byId.sodium.version === '0.5.8');
    check(
      'Forge mods.toml 读出名称，占位符版本用 MANIFEST 补全',
      byId.jei && byId.jei.name === 'Just Enough Items' && byId.jei.version === '15.2.0.27',
      JSON.stringify(byId.jei || null)
    );
    check('读不到元数据的 jar 退回文件名而不是崩掉', byId.mystery && byId.mystery.disabled === true);

    // 目录不存在的实例不应抛异常
    const none = modsLib.list(path.join(TMP, 'no-mods-dir'));
    check('mods 目录不存在时返回空列表', none.exists === false && none.total === 0);

    // 文件名是唯一的外部输入，必须挡住穿越
    let blocked = true;
    for (const bad of ['../../evil.jar', 'a/b.jar', 'C:\\evil.jar', '', '.hidden.jar', 'x.txt', 'a".jar']) {
      try {
        modsLib.assertModFile(bad);
        blocked = false;
        console.log('  未被拒绝:', JSON.stringify(bad));
      } catch {}
    }
    check('越界或非法的模组文件名被拒绝', blocked);

    // 启用/禁用只改扩展名，内容不动
    const before = fs.readFileSync(path.join(modsDir, 'sodium-fabric-0.5.8.jar')).length;
    const off = modsLib.toggle(modsDir, 'sodium-fabric-0.5.8.jar', false);
    check('禁用后扩展名变成 .disabled', off === 'sodium-fabric-0.5.8.jar.disabled');
    const on = modsLib.toggle(modsDir, off, true);
    check('启用后扩展名恢复', on === 'sodium-fabric-0.5.8.jar');
    check(
      '启用/禁用不改动文件内容',
      fs.readFileSync(path.join(modsDir, 'sodium-fabric-0.5.8.jar')).length === before
    );

    // options.txt：只补缺失键，不覆盖玩家自己的选择
    const gdir = path.join(TMP, 'optgame');
    mkdir(gdir);
    const first = optLib.ensureDefaults(gdir);
    const text1 = fs.readFileSync(path.join(gdir, 'options.txt'), 'utf8');
    check('首次启动写入 lang 与 narrator', first.created === true && /lang:zh_cn/.test(text1) && /narrator:0/.test(text1));

    const again = optLib.ensureDefaults(gdir);
    check('重复启动不再重复追加', again.added.length === 0);

    fs.writeFileSync(path.join(gdir, 'options.txt'), 'lang:en_us\nfov:0.5\n', 'utf8');
    const third = optLib.ensureDefaults(gdir);
    const text3 = fs.readFileSync(path.join(gdir, 'options.txt'), 'utf8');
    check('玩家自己选的英文不会被改回中文', /lang:en_us/.test(text3) && !/lang:zh_cn/.test(text3));
    check('缺失的 narrator 仍然补上', third.added.join(',') === 'narrator' && /narrator:0/.test(text3));
    check('原有其它设置原样保留', /fov:0\.5/.test(text3));
  }

  console.log('\n[18] N11 旧配置里的日志开关迁移');
  {
    const settingsLib = require(path.join(ROOT, 'core', 'settings'));
    const cfg = path.join(USER_DATA, 'smucl-config.json');

    // 旧版 save() 会把默认值整份写盘，所以老配置里常见 showLog:true 这种「被带出来」的值。
    // 模拟一份这样的配置，重新加载后必须被迁成「收起」。
    fs.writeFileSync(cfg, JSON.stringify({ showLog: true }), 'utf8');
    settingsLib.init();
    check('旧配置里的 showLog:true 被迁成收起', settingsLib.all().showLog === false);
    check('迁移标记已置位，不会反复生效', settingsLib.all().logDefaultMigrated === true);

    // 迁移之后用户主动打开，必须被尊重
    settingsLib.save({ showLog: true });
    const disk = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    check('迁移后用户主动开启日志会被保留', disk.showLog === true && disk.logDefaultMigrated === true);
  }

  console.log('\n[19] N12 光影 / 材质包的版本族匹配');
  {
    const contentLib = require(path.join(ROOT, 'core', 'content'));

    // 光影与材质包不依赖游戏补丁版本，只标注到 1.21.4 的包在 1.21.11 上同样可用，
    // 按单版本硬筛会把它们全部挡掉，所以这两类按小版本系列匹配。
    check('1.21.11 归入 1.21 系列', contentLib.familyOf('1.21.11') === '1.21');
    check('1.20.1 归入 1.20 系列', contentLib.familyOf('1.20.1') === '1.20');
    check('两段式版本号原样保留', contentLib.familyOf('26.3') === '26.3');
    check('非法/空输入不抛异常', contentLib.familyOf('') === '' && contentLib.familyOf(undefined) === '');

    // 类型白名单仍然生效：不能借「光影」这个入口绕过 kind 校验
    let threw = false;
    try {
      await contentLib.search('shaderpacks', { query: 'x' });
    } catch (e) {
      threw = /不支持的内容类型/.test(e.message);
    }
    check('未知内容类型被拒绝', threw);
  }

  console.log('\n[20] N13 资源详情接口的入参校验');
  {
    // 详情只接受非空字符串 ID，避免被当成任意 URL / 路径入口
    const empty = await invoke('content:detail', { projectId: '' });
    check('空项目 ID 被拒绝', empty.ok === false);

    const notString = await invoke('content:detail', { projectId: { $ne: 1 } });
    check('非字符串项目 ID 被拒绝', notString.ok === false);

    const missing = await invoke('content:detail', {});
    check('缺少项目 ID 被拒绝', missing.ok === false);
  }

  console.log('\n[21] N14 中文检索映射');
  {
    const cn = require(path.join(ROOT, 'core', 'cnsearch'));

    check('识别中文', cn.hasCJK('机械动力') === true && cn.hasCJK('sodium') === false);
    check('英文查询原样返回', JSON.stringify(cn.candidates('sodium')) === '["sodium"]');
    check('常见模组名映射成英文', cn.candidates('机械动力').includes('create'));
    check('多词短语补核心词', cn.candidates('小地图').includes('minimap'));

    // 纯类型词（光影 / 整合包）不该拿中文去硬查，应直接列该分类
    check('光影归入分类浏览', JSON.stringify(cn.candidates('光影')) === '[""]');
    check('整合包归入分类浏览', JSON.stringify(cn.candidates('整合包')) === '[""]');

    check('类目词映射到 category', cn.categories('科技整合包').includes('technology'));
    check('无类目词时为空', cn.categories('sodium').length === 0);

    // 完全没收录的中文：至少保留原文，不能变成空查询把全站拉出来
    check('未收录中文保留原文', JSON.stringify(cn.candidates('你蒸程')) === '["你蒸程"]');
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
