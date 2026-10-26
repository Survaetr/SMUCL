'use strict';
/**
 * 正版账号的本地存储
 *
 * refresh_token 等同于账号密码，不能明文躺在 JSON 里。
 * 优先用 Electron 的 safeStorage（Windows 上走 DPAPI，绑定当前用户），
 * 不可用时降级为明文并在状态里标记出来，让界面提示用户。
 */
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

let cache = null;

function filePath() {
  return path.join(app.getPath('userData'), 'account.dat');
}

function canEncrypt() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function save(account) {
  const payload = JSON.stringify({
    name: account.name || '',
    uuid: account.uuid || '',
    xuid: account.xuid || '',
    accessToken: account.accessToken || '',
    refreshToken: account.refreshToken || '',
    expiresAt: account.expiresAt || 0,
    // 刷新令牌要用与登录时相同的通道：live = 免注册的 Live 通道，azure = 自备客户端 ID
    authMode: account.authMode === 'live' ? 'live' : 'azure',
  });

  let out;
  if (canEncrypt()) {
    out = { v: 1, encrypted: true, data: safeStorage.encryptString(payload).toString('base64') };
  } else {
    out = { v: 1, encrypted: false, data: payload };
  }
  fs.writeFileSync(filePath(), JSON.stringify(out), 'utf8');
  cache = { ...account, encrypted: out.encrypted };
  return cache;
}

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    const json = raw.encrypted ? JSON.parse(safeStorage.decryptString(Buffer.from(raw.data, 'base64'))) : JSON.parse(raw.data);
    cache = { ...json, encrypted: Boolean(raw.encrypted) };
    return cache;
  } catch {
    return null;
  }
}

function clear() {
  cache = null;
  try {
    fs.unlinkSync(filePath());
  } catch {
    /* 本来就没有就算了 */
  }
}

/** 给界面用的公开信息，绝不带 token */
function publicInfo() {
  const a = load();
  if (!a || !a.name) return { loggedIn: false };
  return {
    loggedIn: true,
    name: a.name,
    uuid: a.uuid,
    expiresAt: a.expiresAt,
    authMode: a.authMode || 'azure',
    encrypted: Boolean(a.encrypted),
  };
}

module.exports = { save, load, clear, publicInfo, canEncrypt, filePath };
