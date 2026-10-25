'use strict';
// 临时脚本：整页截图本地落地页，用于自查排版
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();

const FILE = path.join(__dirname, '..', 'site-download', 'index.html');
const OUT = path.join(__dirname, 'site-shots');
fs.mkdirSync(OUT, { recursive: true });

async function shoot(width, name, maxHeight) {
  const win = new BrowserWindow({
    width,
    height: 900,
    show: false,
    webPreferences: { backgroundThrottling: false },
  });
  await win.loadFile(FILE);
  await new Promise((r) => setTimeout(r, 1600));
  const h = await win.webContents.executeJavaScript('document.documentElement.scrollHeight');
  const target = Math.min(h + 10, maxHeight || 20000);
  win.setSize(width, target);
  await new Promise((r) => setTimeout(r, 1200));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
  console.log('[shot]', name, 'height', target, 'scrollHeight', h);
  win.destroy();
}

app.whenReady().then(async () => {
  const W = Number(process.env.SHOT_W || 1280); await shoot(W, W < 600 ? 'mobile-full' : 'desktop-full', W < 600 ? 5200 : 20000);
  await shoot(390, 'mobile-full');
  app.quit();
});
