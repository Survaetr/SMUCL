'use strict';
// 临时脚本：截图本地落地页，用于自查排版
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();

const FILE = path.join(__dirname, '..', 'site-download', 'index.html');
const OUT = path.join(__dirname, 'site-shots');
fs.mkdirSync(OUT, { recursive: true });

// 页面用 IntersectionObserver 做滚动入场，无滚动的截图里下半屏会一直是 opacity:0，
// 所以截图前强制把所有 .reveal 标成已入场
const REVEAL_ALL = `(() => {
  document.querySelectorAll('.reveal').forEach(el => el.classList.add('in'));
  return document.querySelectorAll('.reveal').length;
})()`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  // 反复 new BrowserWindow + destroy 时会偶发 ERR_FAILED(-2)，
  // 改成全程复用同一个窗口，靠 setSize 切换尺寸（媒体查询会跟着重算）
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: { backgroundThrottling: false },
  });

  await win.loadFile(FILE);
  await wait(900);
  const revealed = await win.webContents.executeJavaScript(REVEAL_ALL);
  await wait(900);
  console.log('[shot] revealed', revealed);

  async function grab(w, h, name) {
    win.setSize(w, h);
    await wait(700);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    console.log('[shot]', name, w + 'x' + h);
  }

  async function fullHeight() {
    const h = await win.webContents.executeJavaScript('document.documentElement.scrollHeight');
    return Math.min(h + 10, 8000);
  }

  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });

  async function overflow(w, h) {
    win.setSize(w, h);
    await wait(500);
    const r = await win.webContents.executeJavaScript(
      'JSON.stringify({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sh: document.documentElement.scrollHeight})'
    );
    const d = JSON.parse(r);
    console.log(`[size] ${w}x${h} scrollWidth=${d.sw} clientWidth=${d.cw} ${d.sw > d.cw ? 'OVERFLOW +' + (d.sw - d.cw) : 'ok'} height=${d.sh}`);
  }

  for (const w of [320, 390, 560, 768, 1024, 1280]) await overflow(w, 900);

  await grab(1280, 900, 'desktop-hero');
  await grab(1280, await fullHeight(), 'desktop-full');
  await grab(1024, 860, 'tablet-hero');
  await grab(390, 844, 'mobile-hero');
  await grab(390, await fullHeight(), 'mobile-full');

  console.log('[console] errors:', errors.length ? errors : 'none');
  win.destroy();
  app.quit();
});
