// 生成测试壁纸（渐变天空 + 太阳 + 山脊），只用于本地验证背景图/蒙版效果
// 用法：node build/make_wp_test.js [输出路径] [--bright]
const fs = require('fs');
const zlib = require('zlib');

// bright：白天强光版，用来压测「背景很亮时文字是否还读得清」
const BRIGHT = process.argv.includes('--bright');
const OUT = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'build/wp-test.png';

const W = 1600;
const H = 900;

const SKY = BRIGHT
  ? [
      [92, 148, 222],
      [186, 218, 246],
      [250, 251, 252],
    ]
  : [
      [26, 38, 72],
      [200, 140, 110],
      [236, 168, 100],
    ];

const HILLS = BRIGHT
  ? [
      [104, 138, 172],
      [124, 158, 188],
      [148, 180, 204],
    ]
  : [
      [16, 26, 46],
      [26, 38, 58],
      [36, 50, 74],
    ];

const raw = Buffer.alloc((W * 4 + 1) * H);
const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
const lerp = (a, b, t) => a + (b - a) * t;

/** 三段插值：0 → 上，0.5 → 中，1 → 下 */
function skyAt(t) {
  const [a, b, c] = SKY;
  if (t < 0.5) {
    const k = t / 0.5;
    return [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
  }
  const k = (t - 0.5) / 0.5;
  return [lerp(b[0], c[0], k), lerp(b[1], c[1], k), lerp(b[2], c[2], k)];
}

const ridge = (x, seed) =>
  0.62 + 0.1 * Math.sin(x * 6.1 + seed) + 0.05 * Math.sin(x * 15.7 + seed * 2) + 0.025 * Math.sin(x * 39.3 + seed * 3);

for (let y = 0; y < H; y++) {
  const rowStart = y * (W * 4 + 1);
  raw[rowStart] = 0;
  const t = y / H;
  for (let x = 0; x < W; x++) {
    const u = x / W;
    const sky = skyAt(t);
    let [r, g, b] = sky;

    // 太阳
    const dx = (u - 0.68) * W;
    const dy = (t - 0.42) * H;
    const d = Math.sqrt(dx * dx + dy * dy);
    const glow = Math.exp(-Math.pow(d / 190, 2)) * (BRIGHT ? 0.75 : 0.85);
    r += 255 * glow * 0.5;
    g += 226 * glow * 0.45;
    b += 170 * glow * 0.38;

    for (let k = 0; k < 3; k++) {
      const base = ridge(u, k * 1.7) - k * 0.06;
      if (t > base) {
        const depth = Math.min(1, (t - base) * 3.2) * 0.92;
        const tone = HILLS[k];
        r = lerp(r, tone[0], depth);
        g = lerp(g, tone[1], depth);
        b = lerp(b, tone[2], depth);
      }
    }

    const p = rowStart + 1 + x * 4;
    raw[p] = clamp(r);
    raw[p + 1] = clamp(g);
    raw[p + 2] = clamp(b);
    raw[p + 3] = 255;
  }
}

// ---- 最小 PNG 编码 ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 8 })),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.writeFileSync(OUT, png);
console.log('written', OUT, (png.length / 1024).toFixed(0) + ' KB', `${W}x${H}`, BRIGHT ? 'bright' : 'dusk');
