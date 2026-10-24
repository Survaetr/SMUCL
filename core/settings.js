'use strict';
/**
 * 配置持久化。所有可调项集中在此，避免散落在各处。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');

const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');

const DEFAULTS = {
  mcDir: path.join(APPDATA, '.minecraft'),
  extraDirs: [],
  javaPath: '',
  memory: 4096,
  downloadSource: 'bmcl', // bmcl = BMCLAPI 镜像（国内快） | mojang = 官方源
  playerName: 'Steve',
  showLog: true,
  fullscreen: false,
  resolution: { enabled: false, width: 925, height: 530 },
  jvmArgs: '',
  downloadThreads: 8,
  autoCheck: true, // 后台自动检查新版本
  gpuFallback: false, // GPU 进程崩溃后自动切换的兼容启动模式
  theme: 'auto', // auto | dark | light
  autoUpdateCheck: true, // 启动时检查 GitHub 是否有新版本
  lastSeenVersion: '', // 用于判断是否需要弹出更新日志
  gpuHighPerf: false, // 已把 javaw.exe 写入 Windows「高性能显卡」偏好
  saveGroup: 'folder', // 存档分组：folder | version | time
  cfApiKey: '', // CurseForge API Key（仅本地保存，用于整合包搜索与下载）
  msClientId: '', // 正版登录用的 Azure 应用 ID（自己注册，公开客户端）
  loginMode: 'offline', // offline = 离线账户 | msa = 微软正版
};

let configPath = null;
let cache = null;

function init() {
  configPath = path.join(app.getPath('userData'), 'smucl-config.json');
  cache = null;
  return load();
}

function load() {
  if (cache) return cache;
  let disk = {};
  try {
    if (configPath && fs.existsSync(configPath)) {
      disk = JSON.parse(fs.readFileSync(configPath, 'utf8')) || {};
    }
  } catch (e) {
    console.warn('[settings] 读取失败，使用默认值:', e.message);
    disk = {};
  }
  cache = { ...DEFAULTS, ...disk, resolution: { ...DEFAULTS.resolution, ...(disk.resolution || {}) } };
  return cache;
}

function all() {
  return load();
}

function save(patch = {}) {
  const next = { ...load(), ...patch };
  if (patch.resolution) next.resolution = { ...load().resolution, ...patch.resolution };
  if (patch.extraDirs && !Array.isArray(patch.extraDirs)) next.extraDirs = load().extraDirs;
  cache = next;
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf8');
  } catch (e) {
    console.error('[settings] 写入失败:', e.message);
  }
  return next;
}

/** 确保游戏目录存在，返回绝对路径 */
function ensureGameDir() {
  const dir = load().mcDir;
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'versions'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'libraries'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  return dir;
}

module.exports = { init, all, save, ensureGameDir, DEFAULTS };
