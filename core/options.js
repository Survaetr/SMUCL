'use strict';
/**
 * 游戏内设置的默认值。
 *
 * 目的有两个：
 *   1. 新玩家第一次进游戏就是中文界面，不用在满是英文的菜单里找语言选项；
 *   2. 关掉复述功能（Narrator）—— 它会把菜单项朗读出来，一旦误开，
 *      每次点按都出声，而关闭入口藏在「辅助功能」里，很多人找不到。
 *
 * 关键约束：**只补缺失的键，绝不覆盖用户已经选过的值**。
 * 玩家自己在游戏里切回英文、或者主动开启复述，下次启动不会被改回去。
 */
const fs = require('fs');
const path = require('path');

/** options.txt 的键值对，顺序即追加顺序 */
const DEFAULTS = [
  ['lang', 'zh_cn'], // 简体中文
  ['narrator', '0'], // 0 = 关闭复述；1 全部 2 仅聊天 3 仅系统
];

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 保证 options.txt 里存在这些默认键。
 * @param {string} gameDir 传给游戏的 --gameDir
 * @param {Array<[string,string]>} [defaults]
 * @returns {{file:string, created:boolean, added:string[], error?:string}}
 */
function ensureDefaults(gameDir, defaults = DEFAULTS) {
  const file = path.join(gameDir, 'options.txt');
  const text = readText(file);
  const blank = text === null || !text.trim();
  const lines = blank ? [] : text.split(/\r?\n/);

  // 已有键一律不碰，包括用户显式设成别的值的情况
  const present = new Set();
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i > 0) present.add(line.slice(0, i).trim());
  }

  const added = [];
  for (const [key, value] of defaults) {
    if (!present.has(key)) {
      lines.push(`${key}:${value}`);
      added.push(key);
    }
  }
  if (!added.length) return { file, created: false, added: [] };

  // 去掉尾部空行再落盘，避免每启动一次就多一行空白
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();

  try {
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    return { file, created: blank, added };
  } catch (e) {
    return { file, created: false, added: [], error: e.message };
  }
}

module.exports = { ensureDefaults, DEFAULTS };
