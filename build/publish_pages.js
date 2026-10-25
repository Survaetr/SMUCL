'use strict';
/**
 * 把 site-download/index.html 同步到 gh-pages 分支，供 GitHub Pages 托管。
 *
 * 用法：node build/publish_pages.js
 * 结果：https://survaetr.github.io/SMUCL/ 更新（推送后约 1 分钟生效）
 *
 * 之所以不直接发布 main 的子目录：GitHub Pages 的分支源只认 / 和 /docs，
 * 而本仓库的 docs/ 已经放了 README 截图，混在一起反而乱。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'site-download', 'index.html');
const TMP = path.join(os.tmpdir(), `smucl-pages-${Date.now()}`);

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function main() {
  if (!fs.existsSync(SRC)) throw new Error('找不到 site-download/index.html');

  console.log('拉取 gh-pages…');
  git(['fetch', 'origin', 'gh-pages'], ROOT);

  git(['worktree', 'add', '--detach', TMP, 'origin/gh-pages'], ROOT);
  try {
    fs.copyFileSync(SRC, path.join(TMP, 'index.html'));
    git(['add', 'index.html'], TMP);

    const dirty = (() => {
      try {
        git(['diff', '--cached', '--quiet'], TMP);
        return false;
      } catch {
        return true;
      }
    })();

    if (!dirty) {
      console.log('内容没有变化，跳过提交');
      return;
    }

    git(
      ['-c', 'user.name=Survaetr', '-c', 'user.email=survaetr@users.noreply.github.com', 'commit', '-m', 'docs: 同步下载页'],
      TMP
    );
    console.log('推送 gh-pages…');
    git(['-c', 'http.version=HTTP/1.1', 'push', 'origin', 'HEAD:gh-pages'], TMP);
    console.log('已推送。约 1 分钟后生效：https://survaetr.github.io/SMUCL/');
  } finally {
    try {
      git(['worktree', 'remove', '--force', TMP], ROOT);
    } catch {
      /* 清理失败不影响发布结果 */
    }
  }
}

try {
  main();
} catch (e) {
  console.error('同步失败：', (e.stderr || e.message || '').toString().trim());
  process.exit(1);
}
