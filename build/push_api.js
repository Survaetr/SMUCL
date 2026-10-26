'use strict';
/**
 * 通过 GitHub Git Data API 把文件推到指定分支。
 *
 * 用途：本机 github.com:443 经常被代理掐成 502（api.github.com 仍然可用），
 * 这时 `git push` 无解，但 ref → blob → tree → commit → PATCH ref 这条链路是通的。
 *
 * 用法：
 *   node build/push_api.js --branch gh-pages --file site-download/index.html:index.html \
 *        --message "docs: 更新下载页"
 * 多个 --file 可重复，格式为 本地路径:仓库内路径
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const OWNER = 'Survaetr';
const REPO = 'SMUCL';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

function parseArgs(argv) {
  const out = { files: [], message: '', branch: 'gh-pages' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--branch') out.branch = argv[++i];
    else if (a === '--message') out.message = argv[++i];
    else if (a === '--file') out.files.push(argv[++i]);
    else if (a.startsWith('--')) throw new Error(`未知参数 ${a}`);
  }
  if (!out.files.length) throw new Error('至少要给一个 --file 本地路径:仓库路径');
  if (!out.message) throw new Error('缺少 --message');
  return out;
}

function readToken() {
  try {
    const raw = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
    });
    const m = raw.match(/^password=(.+)$/m);
    if (m) return m[1].trim();
  } catch {
    /* 走下面的环境变量兜底 */
  }
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return env.trim();
  throw new Error('拿不到 GitHub token（git credential fill 失败，也没有 GH_TOKEN）');
}

const TOKEN = readToken();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'smucl-push-'));

function api(method, endpoint, body) {
  const args = [
    '-s',
    '--ssl-no-revoke',
    '-m',
    '120',
    '-X',
    method,
    '-H',
    `Authorization: Bearer ${TOKEN}`,
    '-H',
    'Accept: application/vnd.github+json',
    '-H',
    'X-GitHub-Api-Version: 2022-11-28',
  ];
  if (body !== undefined) {
    const file = path.join(TMP, `body-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify(body));
    args.push('-H', 'Content-Type: application/json', '--data-binary', `@${file}`);
  }
  args.push(endpoint.startsWith('http') ? endpoint : API + endpoint);

  let raw;
  try {
    raw = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    throw new Error(`curl 调用失败：${e.message}`);
  }
  let json;
  try {
    json = JSON.parse(raw || '{}');
  } catch {
    throw new Error(`返回不是 JSON：${String(raw).slice(0, 200)}`);
  }
  if (json.message && !json.sha && !json.ref && !json.object) {
    throw new Error(`${method} ${endpoint} → ${json.message}`);
  }
  return json;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const ref = api('GET', `/git/ref/heads/${args.branch}`);
  const headSha = ref.object.sha;
  const parent = api('GET', `/git/commits/${headSha}`);
  const baseTree = parent.tree.sha;
  console.log(`分支 ${args.branch} 当前提交 ${headSha.slice(0, 7)}（${parent.message.split('\n')[0]}）`);

  const tree = [];
  for (const spec of args.files) {
    const idx = spec.lastIndexOf(':');
    const local = spec.slice(0, idx);
    const remote = spec.slice(idx + 1).replace(/^\/+/, '');
    const content = fs.readFileSync(local);
    const blob = api('POST', '/git/blobs', {
      content: content.toString('base64'),
      encoding: 'base64',
    });
    console.log(`  blob ${remote} ← ${local}（${content.length} 字节）`);
    tree.push({ path: remote, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const newTree = api('POST', '/git/trees', { base_tree: baseTree, tree });
  const commit = api('POST', '/git/commits', {
    message: args.message,
    tree: newTree.sha,
    parents: [headSha],
  });
  api('PATCH', `/git/refs/heads/${args.branch}`, { sha: commit.sha, force: false });
  console.log(`已提交 ${commit.sha.slice(0, 7)} → ${args.branch}`);
  console.log(`https://github.com/${OWNER}/${REPO}/commit/${commit.sha}`);
}

try {
  main();
} catch (e) {
  console.error('推送失败：', e.message);
  process.exit(1);
} finally {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
