'use strict';
/**
 * 微软正版登录（设备码流程）
 *
 * 为什么用设备码：不需要注册回调地址、不需要起本地 HTTP 服务器，最适合桌面启动器。
 *
 * 认证链（少一步都拿不到游戏档案）：
 *   Microsoft OAuth  →  Xbox Live (user.auth)  →  XSTS  →  Minecraft Services  →  profile
 *
 * 客户端 ID：必须是你自己在 Azure 注册的应用（免费），并要求开启
 *   「Allow public client flows」。这里不内置任何第三方 ID。
 */
const net = require('./net');

const DEVICE_CODE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode';
const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const SCOPE = 'XboxLive.signin offline_access';

/*
 * 免注册通道（默认）。
 *
 * 微软已经不允许个人账号在「目录外」注册应用，而没有 Azure 订阅就拿不到目录，
 * 普通用户因此根本注册不出客户端 ID —— 这条 Azure 通道实际上只剩开发者能用。
 * 所以默认改走微软自家的 Live OAuth 公共客户端（MBI_SSL），和 HMCL / PCL 用的是同一条：
 *   · 不需要任何注册
 *   · 设备码在 https://www.microsoft.com/link 输入
 *   · 拿到的 token 换 Xbox Live 时要用 t= 前缀（Azure v2 通道用 d=，这是唯一关键差异）
 * 授权页显示的是微软自家应用名，不是 SMUCL，属预期行为。
 *
 * 如果用户自己在设置里填了 Azure 客户端 ID，则优先走 Azure 通道。
 */
const LIVE_CLIENT_ID = '00000000402b5328';
const LIVE_DEVICE_URL = 'https://login.live.com/oauth20_connect.srf';
const LIVE_TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
const LIVE_SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL';

const XBL_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.body = json || { raw: text.slice(0, 300) };
    throw err;
  }
  return json;
}

async function postForm(url, form) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(25000),
  });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}

/** 第一步：拿设备码，给用户看 user_code */
/**
 * 第一步：取设备码。
 * clientId 为空 → 走免注册的 Live 通道；填了 → 走 Azure 通道。
 */
async function startDeviceCode(clientId) {
  const azure = Boolean(clientId);
  const r = azure
    ? await postForm(DEVICE_CODE_URL, { client_id: clientId, scope: SCOPE })
    : await postForm(LIVE_DEVICE_URL, {
        client_id: LIVE_CLIENT_ID,
        scope: LIVE_SCOPE,
        response_type: 'device_code',
      });
  if (!r.ok || !r.json || !r.json.device_code) {
    const msg = (r.json && (r.json.error_description || r.json.error)) || `HTTP ${r.status}`;
    throw new Error(`获取设备码失败：${msg}`);
  }
  return {
    mode: azure ? 'azure' : 'live',
    deviceCode: r.json.device_code,
    userCode: r.json.user_code,
    url: r.json.verification_uri,
    expiresIn: r.json.expires_in,
    interval: r.json.interval || 5,
    message: r.json.message,
  };
}

/**
 * 第二步：轮询换 token。用户没完成时返回 pending，其他错误直接抛。
 */
async function pollToken(clientId, deviceCode, mode = 'azure') {
  const live = mode === 'live';
  const r = live
    ? await postForm(LIVE_TOKEN_URL, {
        client_id: LIVE_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      })
    : await postForm(TOKEN_URL, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: clientId,
        device_code: deviceCode,
      });
  if (r.ok && r.json && r.json.access_token) {
    return { done: true, tokens: r.json };
  }
  const err = (r.json && r.json.error) || '';
  if (err === 'authorization_pending') return { done: false, reason: 'pending' };
  if (err === 'slow_down') return { done: false, reason: 'slow' };
  if (err === 'expired_token') return { done: false, reason: 'expired' };
  if (err === 'authorization_declined') return { done: false, reason: 'declined' };

  const desc = (r.json && r.json.error_description) || `HTTP ${r.status}`;
  throw new Error(desc);
}

/** 刷新令牌 */
async function refreshToken(clientId, refresh, mode = 'azure') {
  const live = mode === 'live';
  const r = live
    ? await postForm(LIVE_TOKEN_URL, {
        grant_type: 'refresh_token',
        client_id: LIVE_CLIENT_ID,
        refresh_token: refresh,
        scope: LIVE_SCOPE,
      })
    : await postForm(TOKEN_URL, {
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refresh,
        scope: SCOPE,
      });
  if (r.ok && r.json && r.json.access_token) return r.json;
  const desc = (r.json && (r.json.error_description || r.json.error)) || `HTTP ${r.status}`;
  const e = new Error(desc);
  e.invalidGrant = /invalid_grant/.test(desc) || (r.json && r.json.error === 'invalid_grant');
  throw e;
}

/** Xbox Live → XSTS → Minecraft */
async function xboxToMinecraft(msAccessToken, mode = 'azure') {
  // Live 通道的 token 用 t= 前缀，Azure v2 通道用 d=，混用会直接 401
  const ticket = mode === 'live' ? `t=${msAccessToken}` : `d=${msAccessToken}`;
  let xbl;
  try {
    xbl = await postJson(XBL_URL, {
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: ticket },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    });
  } catch (e) {
    throw new Error(`Xbox Live 认证失败：${(e.body && e.body.Message) || e.message}`);
  }

  const uhs = xbl.DisplayClaims && xbl.DisplayClaims.xui && xbl.DisplayClaims.xui[0] && xbl.DisplayClaims.xui[0].uhs;
  if (!uhs) throw new Error('Xbox Live 返回里没有用户标识');

  let xsts;
  try {
    xsts = await postJson(XSTS_URL, {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT',
    });
  } catch (e) {
    const xerr = e.body && e.body.XErr;
    const map = {
      2148916233: '这个微软账号还没有 Xbox 账号，请先去 xbox.com 创建',
      2148916235: '所在地区不支持 Xbox Live',
      2148916236: '需要先在网页上完成年龄验证',
      2148916237: '需要先在网页上完成年龄验证',
      2148916238: '这是未成年账号，需要家长把它加入家庭组',
    };
    throw new Error(map[xerr] || `XSTS 授权失败：${(e.body && e.body.Message) || e.message}`);
  }

  let mc;
  try {
    mc = await postJson(MC_LOGIN_URL, { identityToken: `XBL3.0 x=${uhs};${xsts.Token}` });
  } catch (e) {
    throw new Error(`Minecraft 登录失败：${e.message}`);
  }

  const profileRes = await fetch(MC_PROFILE_URL, {
    headers: { Authorization: `Bearer ${mc.access_token}` },
    signal: AbortSignal.timeout(20000),
  });
  if (profileRes.status === 404) {
    throw new Error('这个账号没有购买 Minecraft: Java 版');
  }
  if (!profileRes.ok) throw new Error(`获取游戏档案失败：HTTP ${profileRes.status}`);
  const profile = await profileRes.json();

  return {
    accessToken: mc.access_token,
    // Minecraft 的 token 固定 24 小时
    expiresAt: Date.now() + (mc.expires_in ? mc.expires_in * 1000 : 86400000),
    name: profile.name,
    uuid: profile.id,
    skins: (profile.skins || []).map((s) => ({ id: s.id, state: s.state, url: s.url })),
    xuid: (xbl.DisplayClaims.xui[0] && xbl.DisplayClaims.xui[0].xid) || '',
  };
}

module.exports = { startDeviceCode, pollToken, refreshToken, xboxToMinecraft, sleep };
