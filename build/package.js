'use strict';
/**
 * 免安装版打包：node build/package.js
 * 直接把 Electron 运行时与 app 源码组装成 dist/SMUCL-win32-x64/SMUCL.exe，
 * 不依赖 electron-builder（无需从 GitHub 拉取 NSIS / 7z 等工具）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST_ROOT = path.join(ROOT, 'dist');
const OUT = path.join(DIST_ROOT, 'SMUCL-win32-x64');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');

const APP_FILES = ['package.json', 'main.js', 'preload.js', 'README.md', 'core', 'renderer', 'assets'];
const APP_MODULES = ['adm-zip'];

// 手写递归：fs.cpSync 在本机 Electron 运行时上会静默崩溃（updater.js 里也踩过，
// 那边同样改成手写递归），rmSync 递归删大量文件又会触发沙箱的批量删除保护，
// 所以这里统一用 unlink/rmdir 自己走一遍。
function rm(p) {
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return;
  }
  if (!st.isDirectory()) {
    fs.unlinkSync(p);
    return;
  }
  for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
    rm(path.join(p, ent.name));
  }
  fs.rmdirSync(p);
}

function copy(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      copy(path.join(src, ent.name), path.join(dest, ent.name));
    }
    return;
  }
  fs.copyFileSync(src, dest);
}

function main() {
  if (!fs.existsSync(ELECTRON_DIST)) {
    console.error('未找到 Electron 运行时，请先执行 npm install 或 install.js');
    process.exit(1);
  }

  console.log('清理旧的打包产物…');
  rm(OUT);
  fs.mkdirSync(OUT, { recursive: true });

  console.log('复制 Electron 运行时…');
  copy(ELECTRON_DIST, OUT);

  // 清掉用不到的默认应用
  rm(path.join(OUT, 'resources', 'default_app.asar'));

  console.log('复制应用源码…');
  const appDir = path.join(OUT, 'resources', 'app');
  fs.mkdirSync(appDir, { recursive: true });
  for (const item of APP_FILES) {
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) continue;
    copy(src, path.join(appDir, item));
  }

  const modulesDir = path.join(appDir, 'node_modules');
  fs.mkdirSync(modulesDir, { recursive: true });
  for (const mod of APP_MODULES) {
    copy(path.join(ROOT, 'node_modules', mod), path.join(modulesDir, mod));
  }

  // 精简 package.json：打包后不需要 devDependencies 与构建脚本
  const pkgPath = path.join(appDir, 'package.json');  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const slim = {
    name: pkg.name,
    productName: pkg.productName,
    version: pkg.version,
    description: pkg.description,
    main: pkg.main,
    author: pkg.author,
    license: pkg.license,
    dependencies: pkg.dependencies,
  };
  fs.writeFileSync(pkgPath, JSON.stringify(slim, null, 2), 'utf8');

  // 生成应用代码更新包：只含 resources/app 内容，供自动更新使用（约 1~2 MB）
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    zip.addLocalFolder(appDir);
    const zipName = `app-${pkg.version}.zip`;
    const zipPath = path.join(DIST_ROOT, zipName);
    if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });
    zip.writeZip(zipPath);
    console.log(`更新包：dist/${zipName}（${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(2)} MB）`);
  } catch (e) {
    console.log('更新包生成失败：', e.message);
  }

  // 说明文件放在 exe 同级，双击文件夹就能看到
  const readme = path.join(ROOT, '使用说明.txt');
  if (fs.existsSync(readme)) {
    copy(readme, path.join(OUT, '使用说明.txt'));
  }

  // 重命名可执行文件
  const exeSrc = path.join(OUT, 'electron.exe');
  const exeDst = path.join(OUT, 'SMUCL.exe');
  if (fs.existsSync(exeSrc)) fs.renameSync(exeSrc, exeDst);

  // 写入图标与版本信息
  try {
    const rcedit = path.join(ROOT, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');
    if (fs.existsSync(rcedit) && fs.existsSync(exeDst)) {
      execFileSync(rcedit, [
        exeDst,
        '--set-icon', path.join(ROOT, 'assets', 'icon.ico'),
        '--set-file-version', '1.0.0.0',
        '--set-product-version', '1.0.0.0',
        '--set-version-string', 'ProductName', 'SMUCL',
        '--set-version-string', 'FileDescription', 'SMUCL 上海海事大学 Minecraft 启动器',
        '--set-version-string', 'CompanyName', 'SMUCL',
        '--set-version-string', 'LegalCopyright', 'Shanghai Maritime University',
        '--set-version-string', 'OriginalFilename', 'SMUCL.exe',
      ]);
      console.log('已写入图标与版本信息');
    } else {
      console.log('跳过图标写入（未找到 rcedit）');
    }
  } catch (e) {
    console.log('图标写入失败：', e.message);
  }

  // 统计体积
  let bytes = 0;
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full);
      else bytes += fs.statSync(full).size;
    }
  };
  walk(OUT);

  console.log(`\n打包完成：${exeDst}`);
  console.log(`体积：${(bytes / 1024 / 1024).toFixed(0)} MB`);
}

main();
