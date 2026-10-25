'use strict';
/**
 * 流式 ZIP 写入器（store 模式，不压缩）。
 *
 * 为什么不用现成的库：
 *   - adm-zip 的 addLocalFile 会把整个文件读进内存，导出几百 MB 的 mods 会直接把主进程撑爆
 *   - 打包对象主要是 .jar（本身已经是 deflate 压缩过的），再压一遍收益极小、耗时翻倍
 *
 * 实现要点：
 *   - 每个条目用 data descriptor（通用标志位 bit 3）回填 CRC 与大小，
 *     这样才能一边读文件一边写，不必先知道压缩后体积
 *   - 文件名用 UTF-8 并置 bit 11，避免中文实例名在别的解压工具里乱码
 *   - 单文件上限 4 GB（未启用 zip64），超出直接报错而不是写出坏包
 */
const fs = require('fs');

const MAX_ENTRY = 0xffffffff;

// ---------------------------------------------------------------- CRC32
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(crc, buf) {
  let c = (crc ^ -1) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** DOS 时间/日期：zip 格式固定用 1980 纪元的 16 位字段 */
function dosStamp(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f),
  };
}

class ZipWriter {
  constructor(stream) {
    this.stream = stream;
    this.offset = 0;
    this.entries = [];
    this.closed = false;
  }

  _write(buf) {
    this.offset += buf.length;
    if (this.stream.write(buf)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onDrain = () => {
        this.stream.removeListener('error', onError);
        resolve();
      };
      const onError = (e) => {
        this.stream.removeListener('drain', onDrain);
        reject(e);
      };
      this.stream.once('drain', onDrain);
      this.stream.once('error', onError);
    });
  }

  /**
   * 追加一个文件。
   * @param {string} absPath 源文件绝对路径
   * @param {string} entryName 包内路径，统一用 / 分隔
   */
  async addFile(absPath, entryName) {
    if (this.closed) throw new Error('压缩包已关闭');
    const st = fs.statSync(absPath);
    if (!st.isFile()) return 0;
    if (st.size > MAX_ENTRY) throw new Error(`文件过大（超过 4 GB）：${entryName}`);

    const nameBuf = Buffer.from(entryName.replace(/\\/g, '/'), 'utf8');
    const { time, date } = dosStamp(st.mtime instanceof Date ? st.mtime : new Date(st.mtime));
    const start = this.offset;

    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    head.writeUInt16LE(20, 4); // 解压所需版本 2.0
    head.writeUInt16LE(0x0808, 6); // bit3=data descriptor，bit11=UTF-8 文件名
    head.writeUInt16LE(0, 8); // 0 = store
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(0, 14); // CRC 稍后由 data descriptor 提供
    head.writeUInt32LE(0, 18);
    head.writeUInt32LE(0, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    head.writeUInt16LE(0, 28);
    await this._write(head);
    await this._write(nameBuf);

    let crc = 0;
    let size = 0;
    const rs = fs.createReadStream(absPath, { highWaterMark: 1 << 20 });
    for await (const chunk of rs) {
      crc = crc32(crc, chunk);
      size += chunk.length;
      await this._write(chunk);
    }

    const tail = Buffer.alloc(16);
    tail.writeUInt32LE(0x08074b50, 0); // data descriptor 签名
    tail.writeUInt32LE(crc, 4);
    tail.writeUInt32LE(size, 8);
    tail.writeUInt32LE(size, 12);
    await this._write(tail);

    this.entries.push({ nameBuf, crc, size, offset: start, time, date });
    return size;
  }

  /** 写中央目录与 EOCD，然后关闭流 */
  async close() {
    if (this.closed) return;
    this.closed = true;

    const cdStart = this.offset;
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0); // 中央目录头签名
      h.writeUInt16LE(20, 4); // 创建版本
      h.writeUInt16LE(20, 6); // 解压所需版本
      h.writeUInt16LE(0x0808, 8);
      h.writeUInt16LE(0, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.size, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt16LE(0, 30); // extra
      h.writeUInt16LE(0, 32); // comment
      h.writeUInt16LE(0, 34); // disk
      h.writeUInt16LE(0, 36); // internal attrs
      h.writeUInt32LE(0, 38); // external attrs
      h.writeUInt32LE(e.offset, 42);
      await this._write(h);
      await this._write(e.nameBuf);
    }
    const cdSize = this.offset - cdStart;

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    await this._write(eocd);

    await new Promise((resolve, reject) => {
      this.stream.end((err) => (err ? reject(err) : resolve()));
    });
  }
}

/** 打开一个待写入的 zip；调用方负责在 finally 里 close()/abort() */
function create(outPath) {
  const stream = fs.createWriteStream(outPath);
  const writer = new ZipWriter(stream);
  writer.outPath = outPath;
  // 出错时尽快释放句柄，避免留下半个文件
  writer.abort = async () => {
    try {
      stream.destroy();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(outPath, { force: true });
    } catch {
      /* ignore */
    }
  };
  return writer;
}

module.exports = { create, crc32 };
