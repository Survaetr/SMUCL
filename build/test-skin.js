'use strict';
/**
 * 皮肤导入/校验的自动化测试。
 * 用法：npx electron build/test-skin.js
 *
 * 覆盖：新版 64×64、旧版 64×32、高清 128×128、非法尺寸、非 PNG、导入后读取、移除。
 * 注意：core/skin 依赖 app.getPath('userData')，这里先用 setPath 指到临时目录，
 * 免得污染真实配置。
 */
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIX = path.join(__dirname, 'skin-fixtures');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok   ' + name);
  } catch (e) {
    fail++;
    console.log('  FAIL ' + name + ' → ' + e.message);
  }
}
function mustThrow(name, fn, expectPart) {
  try {
    fn();
    fail++;
    console.log('  FAIL ' + name + ' → 本应报错却成功了');
  } catch (e) {
    if (expectPart && !e.message.includes(expectPart)) {
      fail++;
      console.log(`  FAIL ${name} → 报错信息不符：${e.message}`);
      return;
    }
    pass++;
    console.log('  ok   ' + name + `（拒绝：${e.message}）`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

app.whenReady().then(() => {
  const ud = path.join(os.tmpdir(), `smucl-skin-test-${Date.now()}`);
  fs.mkdirSync(ud, { recursive: true });
  app.setPath('userData', ud);

  const skin = require('../core/skin');
  const read = (n) => fs.readFileSync(path.join(FIX, n));

  console.log('partsOf：尺寸识别');
  check('64×64 判定为新版', () => {
    const p = skin.partsOf(read('modern-64x64.png'));
    assert(p.modern === true, 'modern 应为 true');
    ['head', 'hat', 'body', 'arm', 'leg'].forEach((k) => {
      assert(typeof p[k] === 'string' && p[k].startsWith('data:image/png;base64,'), `${k} 不是 data URL`);
    });
  });
  check('64×32 判定为旧版', () => {
    assert(skin.partsOf(read('legacy-64x32.png')).modern === false, 'modern 应为 false');
  });
  check('128×128 高清按比例切片', () => {
    const p = skin.partsOf(read('hd-128x128.png'));
    assert(p.modern === true, '128 宽应视为新版');
  });
  mustThrow('32×32 被拒（宽度不是 64 的倍数）', () => skin.partsOf(read('bad-32x32.png')), '宽度');
  mustThrow('64×48 被拒（高度不是 32/64）', () => skin.partsOf(read('bad-64x48.png')), '高度');
  mustThrow('非 PNG 被拒', () => skin.importLocal('Steve', path.join(FIX, 'not-a-png.png')), 'PNG');

  console.log('本地皮肤：导入 → 读取 → 移除');
  check('导入 64×64 后可读回', () => {
    const r = skin.importLocal('Steve', path.join(FIX, 'modern-64x64.png'));
    assert(r.face && r.face.base, '导入没返回脸');
    const back = skin.localSkin('Steve');
    assert(back && back.parts && back.parts.body, '读不回皮肤');
  });
  check('玩家名大小写不敏感', () => {
    assert(skin.localSkin('steve') !== null, 'steve 应能读到 Steve 的皮肤');
    assert(skin.localSkin('STEVE') !== null, 'STEVE 应能读到 Steve 的皮肤');
  });
  check('未导入的名字返回 null', () => {
    assert(skin.localSkin('Notch') === null, '不该有皮肤');
  });
  check('名字里的路径字符被清洗', () => {
    const k = skin.keyOf('../../evil');
    assert(!k.includes('..') && !k.includes('/'), `清洗失败：${k}`);
  });
  mustThrow('空名字拒绝保存', () => skin.importLocal('   ', path.join(FIX, 'modern-64x64.png')), '玩家名');
  check('移除后读不到', () => {
    assert(skin.clearLocal('Steve') === true, 'clearLocal 应返回 true');
    assert(skin.localSkin('Steve') === null, '移除后仍能读到');
  });
  check('重复移除不报错', () => {
    assert(skin.clearLocal('Steve') === false, '第二次移除应返回 false');
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  try {
    fs.rmSync(ud, { recursive: true, force: true });
  } catch {
    /* 临时目录清不掉不影响结论 */
  }
  app.exit(fail ? 1 : 0);
});
