'use strict';
/**
 * 中文检索层。
 *
 * Modrinth / CurseForge 的搜索只认英文，直接拿中文去查基本返回 0 条。
 * 这里做两件事：
 *   1) 把中文关键词映射成英文词，按「最具体 → 最笼统 → 原文」的顺序给出候选查询；
 *   2) 纯类目词（科技 / 魔法 / 冒险 / 优化 …）额外映射成 Modrinth 的 category，
 *      这样「科技整合包」能命中 categories:technology 的包，而不是只靠标题字面。
 *
 * 只做确定性的本地映射，不依赖翻译接口 —— 翻译服务挂了或走了代理也不会失灵。
 */

/** 中文 → 英文关键词。键按长度倒序参与匹配，避免「机械」抢走「机械动力」 */
const TERMS = [
  // —— 类型词（检索时会被丢掉，交给分类页签决定）——
  ['光影包', ''],
  ['材质包', ''],
  ['资源包', ''],
  ['整合包', ''],
  ['整合', ''],
  ['模组', ''],
  ['光影', ''],
  ['材质', ''],

  // —— 高频模组 / 项目 ——
  ['机械动力', 'create'],
  ['通用机械', 'mekanism'],
  ['应用能源', 'applied energistics'],
  ['工业时代', 'industrial craft'],
  ['匠魂', 'tinkers construct'],
  ['暮色森林', 'twilight forest'],
  ['神秘时代', 'thaumcraft'],
  ['植物魔法', 'botania'],
  ['血魔法', 'blood magic'],
  ['星辉魔法', 'astral sorcery'],
  ['龙之研究', 'draconic evolution'],
  ['虚无世界', 'divine rpg'],
  ['拔刀剑', 'slashblade'],
  ['东方小女仆', 'touhou little maid'],
  ['小女仆', 'touhou little maid'],
  ['车万', 'touhou'],
  ['热力膨胀', 'thermal expansion'],
  ['精致存储', 'refined storage'],
  ['存储抽屉', 'storage drawers'],
  ['沉浸工程', 'immersive engineering'],
  ['更好的战斗', 'better combat'],
  ['更好的下界', 'better nether'],
  ['更好的末地', 'better end'],
  ['农夫乐事', 'farmers delight'],
  ['帕姆', 'harvestcraft'],
  ['铁箱子', 'iron chests'],
  ['传送石碑', 'waystones'],
  ['任务书', 'ftb quests'],
  ['物品管理器', 'jei'],
  ['苹果皮', 'apple skin'],
  ['旅行地图', 'journeymap'],
  ['小地图', 'xaero minimap'],
  ['世界地图', 'xaero world map'],
  ['钠', 'sodium'],
  ['锂', 'lithium'],
  ['铱', 'iris'],
  ['铷', 'rubidium'],
  ['玉', 'jade'],
  ['方块宝可梦', 'cobblemon'],
  ['宝可梦', 'pixelmon'],
  ['起源', 'origins'],
  ['匠造', 'tinkers'],

  // —— 整合包专名 ——
  ['天空工厂', 'skyfactory'],
  ['一切整合', 'all the mods'],
  ['全都要', 'all the mods'],
  ['单方块', 'one block'],
  ['空岛生存', 'skyblock'],
  ['空岛', 'skyblock'],

  // —— 通用玩法词 ——
  ['优化', 'optimization'],
  ['性能', 'performance'],
  ['帧数', 'fps'],
  ['汉化', 'translation'],
  ['中文', 'chinese'],
  ['字体', 'font'],
  ['联机', 'multiplayer'],
  ['服务器', 'server'],
  ['生存', 'survival'],
  ['冒险', 'adventure'],
  ['科技', 'technology'],
  ['魔法', 'magic'],
  ['建筑', 'building'],
  ['农业', 'farming'],
  ['食物', 'food'],
  ['家具', 'furniture'],
  ['装饰', 'decoration'],
  ['地形', 'terrain'],
  ['生物', 'mobs'],
  ['怪物', 'mobs'],
  ['工具', 'utility'],
  ['地图', 'map'],
  ['背包', 'inventory'],
  ['配方', 'recipe'],
  ['工业', 'industrial'],
  ['能源', 'energy'],
  ['机械', 'machinery'],
  ['自动化', 'automation'],
  ['存储', 'storage'],
  ['管道', 'pipe'],
  ['电力', 'electric'],
  ['核', 'nuclear'],
  ['太空', 'space'],
  ['星球', 'planet'],
  ['龙', 'dragon'],
  ['宠物', 'pet'],
  ['钓鱼', 'fishing'],
  ['烹饪', 'cooking'],
  ['酿酒', 'brewing'],
  ['附魔', 'enchantment'],
  ['武器', 'weapon'],
  ['防具', 'armor'],
  ['交通', 'transport'],
  ['天气', 'weather'],
  ['季节', 'seasons'],
  ['村庄', 'village'],
  ['地牢', 'dungeon'],
  ['遗迹', 'ruins'],
  ['结构', 'structures'],
  ['任务', 'quests'],
  ['我的世界', 'minecraft'],
].sort((a, b) => b[0].length - a[0].length);

/** 纯类目词 → Modrinth category（用于 facets，比文字匹配更准） */
const CATEGORIES = [
  ['科技', 'technology'],
  ['工业', 'technology'],
  ['机械', 'technology'],
  ['魔法', 'magic'],
  ['冒险', 'adventure'],
  ['探索', 'adventure'],
  ['优化', 'optimization'],
  ['性能', 'optimization'],
  ['任务', 'quests'],
  ['建筑', 'building'],
  ['生存', 'adventure'],
  ['空岛', 'adventure'],
  ['世界生成', 'worldgen'],
  ['地形', 'worldgen'],
];

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;

function hasCJK(s) {
  return CJK.test(String(s || ''));
}

/**
 * 候选查询列表：先用最具体的映射，再用全部命中词的组合，最后退回原文。
 * 调用方按顺序试，拿到结果就停。
 */
function candidates(query) {
  const raw = String(query || '').trim();
  if (!raw || !hasCJK(raw)) return [raw];

  let rest = raw.toLowerCase();
  const words = [];
  let sawTypeWord = false;
  for (const [cn, en] of TERMS) {
    if (!rest.includes(cn)) continue;
    rest = rest.split(cn).join(' ');
    if (en) {
      if (!words.includes(en)) words.push(en);
    } else {
      sawTypeWord = true;
    }
  }

  const leftoverCn = /[\u3400-\u4dbf\u4e00-\u9fff]/.test(rest);
  // 剩下的英文（用户可能中英混输）与未被映射的片段
  rest = rest
    .replace(/[\u3400-\u4dbf\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // 「光影」「整合包」这类纯类型词：直接列该分类的热门，而不是拿中文去硬查
  if (!leftoverCn && !words.length) {
    if (sawTypeWord) return [''];
    return [raw];
  }

  const out = [];
  if (rest) out.push(rest);
  if (words.length) out.push(words.join(' '));
  for (const w of words) {
    out.push(w);
    // 多词短语再补一个核心词：「xaero minimap」单查命中太少时用「minimap」兜底
    const parts = w.split(' ');
    if (parts.length > 1) out.push(parts[parts.length - 1]);
  }
  out.push(raw);
  return [...new Set(out.filter(Boolean))].slice(0, 4);
}

/** 中文类目词对应的 Modrinth categories（可能为空） */
function categories(query) {
  if (!hasCJK(query)) return [];
  const q = String(query);
  const out = [];
  for (const [cn, cat] of CATEGORIES) {
    if (q.includes(cn) && !out.includes(cat)) out.push(cat);
  }
  return out;
}

/** 给界面用的一句话说明，没有映射时返回空串 */
function explain(query) {
  const list = candidates(query);
  if (!list.length) return '';
  const first = list[0];
  if (!hasCJK(query)) return '';
  return first;
}

module.exports = { hasCJK, candidates, categories, explain };
