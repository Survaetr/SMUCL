'use strict';
/**
 * 打「免安装版」分享包：把 dist/SMUCL-win32-x64 压成带 deflate 的 zip。
 *
 * 为什么不直接用桌面上的文件夹：
 *   桌面那个目录里混着 源码/node_modules（384 MB，用户完全用不到），
 *   一起打包会把 1.3 GB 的分享包做大 10 倍。
 *
 * 为什么不用 core/zipper.js：
 *   那边是 store（不压缩）模式，专为 jar 设计；这里的 Electron 二进制
 *   不压就 330 MB、压完约 90 MB，必须真压缩。
 *
 * 语言包只保留 zh-CN / zh-TW / en-US / en-GB：Chromium 找不到对应 pak 时
 * 会回退到 en-US，剩下 51 个外语包纯粹是占体积。
 *
 * 用法：node build/pack_portable.js [版本号]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { crc32 } = require('../core/zipper');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'dist', 'SMUCL-win32-x64');
const KEEP_LOCALES = new Set(['zh-CN.pak', 'zh-TW.pak', 'en-US.pak', 'en-GB.pak']);
const SKIP_NAMES = new Set(['debug.log', '.DS_Store', 'Thumbs.db']);

function dosStamp(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f),
  };
}

/** 递归收集待打包文件，返回 [{ abs, name }] */
function collect(dir, prefix, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    const name = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      collect(abs, name, out);
      continue;
    }
    if (!ent.isFile()) continue;
    if (SKIP_NAMES.has(ent.name)) continue;
    // 语言包过滤
    if (prefix === 'locales' && !KEEP_LOCALES.has(ent.name)) continue;
    out.push({ abs, name });
  }
  return out;
}

class DeflateZip {
  constructor(outPath) {
    this.stream = fs.createWriteStream(outPath);
    // 每次回压都会挂一个临时 error 监听，条目多时会触发 MaxListeners 警告
    this.stream.setMaxListeners(0);
    this.offset = 0;
    this.entries = [];
  }

  _write(buf) {
    this.offset += buf.length;
    if (this.stream.write(buf)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.stream.once('drain', resolve);
      this.stream.once('error', reject);
    });
  }

  async addFile(abs, name) {
    const st = fs.statSync(abs);
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
    const { time, date } = dosStamp(st.mtime);

    // 整文件读入再 deflateRawSync：流式 pipe 在本机 Node 上会因管道回压死锁，
    // 进程没有 pending handle 就直接静默退出（表现为只生成一个几百 KB 的残包）。
    // 最大的文件是 249 MB 的 exe，压缩后约 90 MB，内存峰值可控。
    const rawBuf = fs.readFileSync(abs);
    const crc = crc32(0, rawBuf);
    const packedBuf = zlib.deflateRawSync(rawBuf, { level: 9 });
    const raw = rawBuf.length;
    const packed = packedBuf.length;
    const localStart = this.offset;

    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0008, 6); // bit11=UTF-8 文件名
    head.writeUInt16LE(8, 8); // method 8 = deflate
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed, 18);
    head.writeUInt32LE(raw, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    await this._write(head);
    await this._write(nameBuf);
    await this._write(packedBuf);

    this.entries.push({ nameBuf, crc, raw, packed, offset: localStart, time, date });
    return { raw, packed };
  }

  async close() {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(0x0008, 8);
      h.writeUInt16LE(8, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.packed, 20);
      h.writeUInt32LE(e.raw, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt32LE(e.offset, 42);
      await this._write(h);
      await this._write(e.nameBuf);
    }
    const cdSize = this.offset - cdStart;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    await this._write(eocd);
    await new Promise((r, j) => this.stream.end((e) => (e ? j(e) : r())));
  }
}

async function main() {
  const ver = process.argv[2] || require('../package.json').version;
  const out = path.join(ROOT, 'dist', `SMUCL-${ver}-portable.zip`);
  if (!fs.existsSync(SRC)) throw new Error(`找不到构建产物：${SRC}`);

  const files = collect(SRC, '', []);
  // 使用说明以项目根目录为准（dist 里那份可能是旧的），同名条目先剔除再补，
  // 否则 zip 里会出现两条同名记录，解压工具行为不一致
  const readme = path.join(ROOT, '使用说明.txt');
  if (fs.existsSync(readme)) {
    const idx = files.findIndex((f) => f.name === '使用说明.txt');
    if (idx >= 0) files.splice(idx, 1);
    files.push({ abs: readme, name: '使用说明.txt' });
  }

  console.log(`打包 ${files.length} 个文件 → ${out}`);
  const zip = new DeflateZip(out);
  let total = 0;
  let i = 0;
  for (const f of files) {
    const r = await zip.addFile(f.abs, f.name);
    total += r.raw;
    if (++i % 50 === 0 || r.raw > 5e7) console.log(`  ${i}/${files.length}  ${f.name}`);
  }
  await zip.close();

  const st = fs.statSync(out);
  console.log(`\n完成：${(total / 1048576).toFixed(1)} MB → ${(st.size / 1048576).toFixed(1)} MB`);
  console.log(`输出：${out}`);
}

main().catch((e) => {
  console.error('打包失败：', e.message);
  process.exit(1);
});
