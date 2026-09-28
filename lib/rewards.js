/**
 * 回响邮局 · 纯逻辑模块（echo-post-office/lib/rewards.js）
 * ============================================================================
 * 覆盖玩法：十连补给 drawTen / 星愿刮刮乐 scratch / 连锁福袋 bag /
 *           收藏馆 collection / 佩戴 equip / 星屑兑换 redeem。
 *
 * 设计约束
 *  - 纯逻辑：不依赖框架、不读写文件、不联网；只用内置 Math 与 Date（Date 仅做日历换算）。
 *  - ESM：全部命名导出；文案自带，不依赖任何外部素材（assets 缺失时由上层降级渲染）。
 *  - 随机：全部来自注入的 rng()（默认 Math.random），调用顺序固定 → 同一种子可复现。
 *  - 状态：直接原地修改调用方传入的 profile（普通 JSON 对象）并原样返回；
 *          缺字段自动初始化；任何路径都不会让星屑变成负数。
 *
 * profile 结构（每个字段都可缺省，进函数时自动补齐；字段语义见注释）
 *  {
 *    __rewards: { module, version },                  // 本模块的归属标记
 *    createdAt: 'yyyy-mm-dd' | null, updatedAt: 'yyyy-mm-dd',
 *    daily:  { day, ten, scratch, bag },              // 当日各玩法的「已用次数」
 *    pity:   { counter, gold, forcedGold, bestSpan }, // counter = 距上次金的抽数
 *    draws:  { ten, single, total, golds, dupes },
 *    cards:  { [cardId]: 拥有张数 },                   // 重复卡也计数，同时折算星屑
 *    stardust, stardustEarned,
 *    titles: [titleId], frames: [frameId],
 *    equippedTitle: titleId | null, equippedFrame: frameId,
 *    scratch: { plays, big, history: [], pending: ticket | null },
 *    bag:     { opens, best, lastChain, history: [] },
 *    shop:    { redeemed, spent, history: [] },
 *    log:     [ 最近事件 ]
 *  }
 *
 * 卡牌 id 同时就是美术资源 id（presentation.render 会去找 assets/cards/<id>.png），
 * 因此 id 一律使用 [a-z0-9_]，不使用中文。
 *
 * 星愿刮刮乐的展示约定
 *  - 9 格票面必定至少有一条中奖线；3 条及以上中奖线即「三连同图·大奖」。
 *  - 奖赏在开票瞬间就已经结算进 profile，ticket.reveal.shown 只是「展示进度」。
 *  - 调用方可用 advanceScratch(profile, n) 或直接改写 ticket.reveal.shown / order 来
 *    控制逐格揭开节奏；改这些字段不会改变已结算的结果。
 *
 * RNG 调用顺序（便于注入固定序列做测试）
 *  - 单抽：稀有度 1 次 →（金卡且非保底）UP 判定 1 次 → 定卡 1 次。
 *  - 十连：10 次单抽依次调用。
 *  - 刮刮乐：目标线数 1 次 → 主符号 1 次 → 起始线位 1 次 → 每空格 1 次
 *            →（大奖时）金奖卡 1 次；线数不理想时最多重抽 6 轮。
 *  - 福袋：每连 1 次续连判定 → 出卡时（稀有度 1 次 + 定卡 1 次）。
 */

/* ============================== 1. 配置 ============================== */

/** 玩法配额与保底：十连 2 次/天、刮刮乐 2 张/天、福袋 1 个/天、30 抽必金。 */
export const rewardsConfig = {
  dailyTen: 2,
  dailyScratch: 2,
  dailyBag: 1,
  pity: 30,
};

const MODULE_ID = 'echo-post-office/rewards';
const MODULE_VERSION = 1;
const DEFAULT_FRAME = 'f_plain';
const MAX_CHAIN = 12;          // 福袋连锁上限
const CHAIN_TITLE_AT = 10;     // 10 连锁以上发头衔
const REVEAL_TOTAL = 9;        // 刮刮乐 3x3
const UP_SSR_RATE = 0.5;       // 金卡走 UP 池的概率（保底金必为 UP）
const LOG_LIMIT = 24;
const HISTORY_LIMIT = 12;
const CARD_PRICE = { N: 20, R: 40, SR: 120, SSR: 400 };

/* ============================ 2. 稀有度 ============================ */

/** rate 之和为 1；style 直接对接 presentation.render 的 gold / purple 样式。 */
export const rarities = [
  { id: 'SSR', name: '传说', alias: '金', rate: 0.03, stardust: 60, glyph: '✸', style: 'gold', color: '#c8912f' },
  { id: 'SR', name: '稀有', alias: '紫', rate: 0.17, stardust: 15, glyph: '✧', style: 'purple', color: '#8a5fc0' },
  { id: 'R', name: '精良', alias: '蓝', rate: 0.4, stardust: 5, glyph: '◇', style: '', color: '#4c8290' },
  { id: 'N', name: '普通', alias: '灰', rate: 0.4, stardust: 2, glyph: '·', style: '', color: '#6b7a83' },
];

const RARITY = {};
for (const row of rarities) RARITY[row.id] = row;

/* ============================ 3. 卡片目录 ============================ */
/* 共 50 张；type 覆盖 角色 / 信物 / 场景 / 彩蛋；彩蛋 4 张（8%，落在 5%~10% 区间）。 */

export const cards = [
  // 邮局常驻（12）
  { id: 'po_01', name: '夜班邮差·阿澈', rarity: 'N', type: '角色', set: 'post_office', flavor: '凌晨三点，他把最后一封信塞进月亮的投递口。' },
  { id: 'po_02', name: '铜制邮戳', rarity: 'N', type: '信物', set: 'post_office', flavor: '盖下去的一声脆响，是一天里最早的问候。' },
  { id: 'po_03', name: '牛皮纸信封', rarity: 'N', type: '信物', set: 'post_office', flavor: '边角磨得发白，装过许多没说出口的话。' },
  { id: 'po_04', name: '门廊的老猫', rarity: 'N', type: '场景', set: 'post_office', flavor: '它只替值夜的人看门，白天谁也不理。' },
  { id: 'po_05', name: '挂号回执', rarity: 'R', type: '信物', set: 'post_office', flavor: '回执上写着：已送达，收件人正在微笑。' },
  { id: 'po_06', name: '分拣室的白灯', rarity: 'R', type: '场景', set: 'post_office', flavor: '灯光把影子拉成传送带的形状，一直亮到天亮。' },
  { id: 'po_07', name: '手摇胶水', rarity: 'R', type: '信物', set: 'post_office', flavor: '一滴就够，多了会把两页心事粘成一块。' },
  { id: 'po_08', name: '老式天平', rarity: 'R', type: '信物', set: 'post_office', flavor: '称不出思念的重量，只称得出邮票够不够。' },
  { id: 'po_09', name: '骑单车的信使', rarity: 'R', type: '角色', set: 'post_office', flavor: '车筐里永远留一个空位，给顺路的心愿。' },
  { id: 'po_10', name: '柜台小姐·寄', rarity: 'SR', type: '角色', set: 'post_office', flavor: '她说：寄不出去的东西，可以先存在我这里。' },
  { id: 'po_11', name: '万国邮册', rarity: 'SR', type: '信物', set: 'post_office', flavor: '翻开哪一页，哪一页的邮票就开始呼吸。' },
  { id: 'po_12', name: '回响总局', rarity: 'SSR', type: '场景', set: 'post_office', flavor: '所有的信都在这里排队，等一个愿意读的人。' },

  // 星愿站台（9）
  { id: 'sw_01', name: '流星候车牌', rarity: 'N', type: '场景', set: 'star_platform', flavor: '站牌上写着：等许愿的人齐了就走。' },
  { id: 'sw_02', name: '铁轨上的星屑', rarity: 'N', type: '场景', set: 'star_platform', flavor: '踩上去会响，像很轻的祝福碎了一地。' },
  { id: 'sw_03', name: '许愿零钱', rarity: 'N', type: '信物', set: 'star_platform', flavor: '投进闸机的那一枚，是今天唯一不心疼的花销。' },
  { id: 'sw_04', name: '站台长椅', rarity: 'R', type: '场景', set: 'star_platform', flavor: '坐过的愿望太多，木头都被坐得发亮。' },
  { id: 'sw_05', name: '星空时刻表', rarity: 'R', type: '信物', set: 'star_platform', flavor: '车次名称一律写作：未命名的心愿。' },
  { id: 'sw_06', name: '检票员·玖', rarity: 'SR', type: '角色', set: 'star_platform', flavor: '她撕下票根的那一下，愿望就算正式生效。' },
  { id: 'sw_07', name: '折叠星图', rarity: 'SR', type: '信物', set: 'star_platform', flavor: '展开是夜空，合上是一封很短的信。' },
  { id: 'sw_08', name: '织星人·澜', rarity: 'SSR', type: '角色', set: 'star_platform', flavor: '她把昨夜的流星拆成线，织给还没睡着的人。' },
  { id: 'sw_09', name: '星愿特快', rarity: 'SSR', type: '场景', set: 'star_platform', flavor: '终点站不在地图上，只在你说出口的那句话里。' },

  // 雾都夜航（8）
  { id: 'fg_01', name: '雾里的路牌', rarity: 'N', type: '场景', set: 'fog_city', flavor: '指向三条街，三条都通向同一家邮局。' },
  { id: 'fg_02', name: '伞骨上的水珠', rarity: 'N', type: '场景', set: 'fog_city', flavor: '路灯把每一颗都照成很小的月亮。' },
  { id: 'fg_03', name: '夜航班次表', rarity: 'R', type: '场景', set: 'fog_city', flavor: '班次栏只写了一行字：等雾散。' },
  { id: 'fg_04', name: '黄铜望远镜', rarity: 'R', type: '信物', set: 'fog_city', flavor: '能看见对面楼里的人，也在等着写信。' },
  { id: 'fg_05', name: '灯塔信标员·霜', rarity: 'SR', type: '角色', set: 'fog_city', flavor: '他数着雾里的光，一盏都不敢认错。' },
  { id: 'fg_06', name: '玻璃信筒', rarity: 'SR', type: '信物', set: 'fog_city', flavor: '投进去的信会亮一下，像在说：我收到了。' },
  { id: 'fg_07', name: '雾都钟楼', rarity: 'SSR', type: '场景', set: 'fog_city', flavor: '钟声穿过雾，比信先一步抵达。' },
  { id: 'fg_08', name: '雨夜投递员·岚', rarity: 'SR', type: '角色', set: 'fog_city', flavor: '他的雨衣永远半干，因为总在回程时下雨。' },

  // 海底灯塔（8）
  { id: 'lh_01', name: '珊瑚邮筒', rarity: 'N', type: '信物', set: 'sea_lighthouse', flavor: '海底的邮筒不投信件，只投泡得发亮的石头。' },
  { id: 'lh_02', name: '潜水员的海图', rarity: 'N', type: '信物', set: 'sea_lighthouse', flavor: '上面标着七艘沉船，和一个一定会回信的人。' },
  { id: 'lh_03', name: '潮声听筒', rarity: 'R', type: '信物', set: 'sea_lighthouse', flavor: '戴上它，能听见三海里外的一句晚安。' },
  { id: 'lh_04', name: '备用灯芯', rarity: 'R', type: '信物', set: 'sea_lighthouse', flavor: '每一根都写着日期，等着被点亮的那一晚。' },
  { id: 'lh_05', name: '深海灯塔守·澄', rarity: 'SR', type: '角色', set: 'sea_lighthouse', flavor: '她一生只改过一次航向：为了收到回信。' },
  { id: 'lh_06', name: '玻璃穹顶海室', rarity: 'SR', type: '场景', set: 'sea_lighthouse', flavor: '抬头是天，低头是海，中间是没写完的信。' },
  { id: 'lh_07', name: '海沟里的信箱', rarity: 'SR', type: '信物', set: 'sea_lighthouse', flavor: '锁着，钥匙挂在某个许过愿的人脖子上。' },
  { id: 'lh_08', name: '沉船的最后一封信', rarity: 'SSR', type: '信物', set: 'sea_lighthouse', flavor: '信纸泡烂了，只剩下四个字：已平安到。' },

  // 无音区（5，隐藏套系：集齐后可点亮隐藏边框）
  { id: 'si_01', name: '无音区入口', rarity: 'N', type: '场景', set: 'silent_zone', flavor: '走进去以后，脚步声会被轻轻收走。' },
  { id: 'si_02', name: '静音砂石', rarity: 'R', type: '信物', set: 'silent_zone', flavor: '放在桌角，能压住一整晚翻来覆去的念头。' },
  { id: 'si_03', name: '无声的信使', rarity: 'SR', type: '角色', set: 'silent_zone', flavor: '他从不敲门，只是把信放好，再顺手关灯。' },
  { id: 'si_04', name: '空白的回信', rarity: 'SR', type: '信物', set: 'silent_zone', flavor: '空白不是敷衍，是「我全都听见了」。' },
  { id: 'si_05', name: '潮声之核', rarity: 'SSR', type: '角色', set: 'silent_zone', flavor: '它把整片海的声音收成一句：我在这里。' },

  // 深夜糖果铺（4）
  { id: 'cd_01', name: '会响的软糖', rarity: 'N', type: '信物', set: 'candy_shop', flavor: '咬下去像踩到一片很脆的雪。' },
  { id: 'cd_02', name: '柜台上的糖罐', rarity: 'R', type: '信物', set: 'candy_shop', flavor: '罐子的标签写着：给今天没哭的人。' },
  { id: 'cd_03', name: '老板娘·糖', rarity: 'SR', type: '角色', set: 'candy_shop', flavor: '她记得每位客人的甜度，和每句没说完的话。' },
  { id: 'cd_04', name: '糖纸折的夜空', rarity: 'SSR', type: '场景', set: 'candy_shop', flavor: '攒够一百张糖纸，就能折出一小片星夜。' },

  // 潮汐回声·彩蛋（4）
  { id: 'ee_01', name: '漂泊者的旧耳机', rarity: 'R', type: '彩蛋', set: 'echo_easter', flavor: '彩蛋：潮水涨起来的时候，它总在放同一首歌。' },
  { id: 'ee_02', name: '残象的碎裂晶核', rarity: 'R', type: '彩蛋', set: 'echo_easter', flavor: '彩蛋：晶核里困着一段没播完的号哭。' },
  { id: 'ee_03', name: '今州潮汐信标', rarity: 'SR', type: '彩蛋', set: 'echo_easter', flavor: '彩蛋：灯塔一亮，整座城的潮声都会应一声。' },
  { id: 'ee_04', name: '无音区尽头的回响', rarity: 'SSR', type: '彩蛋', set: 'echo_easter', flavor: '彩蛋：走过去的人，会听见自己也在答应。' },
];

/* ============================== 4. 套系 ============================== */

export const sets = [
  { id: 'post_office', name: '邮局常驻', title: 't_set_po', desc: '邮件从这里出发，也在这里等一个回信的人。' },
  { id: 'star_platform', name: '星愿站台', title: 't_set_sw', frame: 'f_starwish', desc: '愿望排队上车，终点写在你说出口的那句话里。' },
  { id: 'fog_city', name: '雾都夜航', title: 't_set_fg', desc: '雾里点灯的人，比信更早知道你要来。' },
  { id: 'sea_lighthouse', name: '海底灯塔', title: 't_set_lh', desc: '最深的夜里，总有一盏灯替海底的人守着。' },
  { id: 'silent_zone', name: '无音区', title: 't_set_si', frame: 'f_silent', hidden: true, desc: '这里的信没有声音，却一封都不会丢。' },
  { id: 'candy_shop', name: '深夜糖果铺', title: 't_set_cd', desc: '甜是今天最后的邮资。' },
  { id: 'echo_easter', name: '潮汐回声·彩蛋', title: 't_set_ee', easter: true, desc: '藏在邮袋底层的四张卡，来自潮水退去的地方。' },
];

/* ============================== 5. 头衔 ============================== */

export const titles = [
  { id: 't_novice', name: '第一次寄信', source: '获得第一张卡', desc: '每一封信都从这里开始。' },
  { id: 't_set_po', name: '邮局本命', source: '集齐「邮局常驻」', desc: '你认得每一个夜班的脚步声。' },
  { id: 't_set_sw', name: '星愿常客', source: '集齐「星愿站台」', desc: '你的愿望已经排到下一班车。' },
  { id: 't_set_fg', name: '雾都夜航员', source: '集齐「雾都夜航」', desc: '雾里的灯，你看一眼就知道是哪盏。' },
  { id: 't_set_lh', name: '灯塔守夜人', source: '集齐「海底灯塔」', desc: '海底的信，都记得你的名字。' },
  { id: 't_set_si', name: '无音信使', source: '集齐「无音区」', desc: '你不说话，但所有信都送到。' },
  { id: 't_set_cd', name: '深夜糖分', source: '集齐「深夜糖果铺」', desc: '甜一点，回信就短一点。' },
  { id: 't_set_ee', name: '潮汐回声', source: '集齐「潮汐回声·彩蛋」', desc: '你听见了邮袋底层的那点回声。' },
  { id: 't_all_sets', name: '邮局传说', source: '集齐全部七个套系', desc: '整座邮局都认识你了。' },
  { id: 't_all_cards', name: '一封信都不少', source: '收齐全部 50 张卡', desc: '收藏馆里没有空格了。' },
  { id: 't_chain10', name: '连环信使', source: '福袋连锁达到 10 连', desc: '十连之后还有下一封。' },
  { id: 't_chain12', name: '满链福星', source: '福袋连锁拉满 12 连', desc: '福袋在你这儿从来不肯停。' },
  { id: 't_bag_regular', name: '福袋常客', source: '累计拆开 20 个福袋', desc: '袋口一响，你就知道有戏。' },
  { id: 't_lucky', name: '三连同图', source: '刮出三连同图大奖', desc: '手气这种东西，是会回响的。' },
  { id: 't_scratch_regular', name: '刮刮乐常客', source: '累计刮开 20 张星愿彩票', desc: '刮开的每一条线都算数。' },
  { id: 't_rich', name: '星屑富翁', source: '累计获得 1000 星屑', desc: '口袋里的星屑比信还沉。' },
  { id: 't_redeem_regular', name: '兑换派送员', source: '累计兑换 5 次', desc: '你总把星屑花在最想要的那张卡上。' },
  { id: 't_veteran', name: '百抽老手', source: '累计十连抽满 100 抽', desc: '闭着眼也知道下一张是什么手感。' },
  { id: 't_shop', name: '夜班邮差', source: '星屑兑换（300 星屑）', desc: '今夜的信，你亲自送。' },
  { id: 't_starweaver', name: '织星人', source: '星屑兑换（500 星屑）', desc: '把散掉的星光重新织成一封回信。' },
];

/* ============================== 6. 边框 ============================== */

export const frames = [
  { id: 'f_plain', name: '牛皮纸信封', source: '默认拥有', desc: '最普通的那种温柔。' },
  { id: 'f_starwish', name: '星愿箔片', source: '集齐「星愿站台」', desc: '边角会随呼吸闪一下的箔片。' },
  { id: 'f_silent', name: '无音区来信', source: '集齐「无音区」', hidden: true, desc: '看不出颜色，却让人安静下来。' },
  { id: 'f_gold_seal', name: '金奖火漆', source: '拥有全部 8 张金卡', desc: '封蜡上压着一枚小小的金印。' },
  { id: 'f_lace', name: '回响蕾丝', source: '星屑兑换（260 星屑）', desc: '镂空的花纹，凑近看是一串小小声的问候。' },
  { id: 'f_tideglass', name: '潮汐玻璃', source: '星屑兑换（320 星屑）', desc: '像被海水磨圆的一小片窗。' },
];

/* ======================= 7. 索引与派生常量 ======================= */

const CARD_BY_ID = new Map(cards.map(card => [card.id, card]));
const SET_BY_ID = new Map(sets.map(set => [set.id, set]));
const TITLE_BY_ID = new Map(titles.map(title => [title.id, title]));
const FRAME_BY_ID = new Map(frames.map(frame => [frame.id, frame]));
const SET_CARD_INDEX = new Map(sets.map(set => [set.id, []]));
for (const card of cards) {
  if (!SET_CARD_INDEX.has(card.set)) SET_CARD_INDEX.set(card.set, []);
  SET_CARD_INDEX.get(card.set).push(card.id);
}

/** UP 池（金卡）：保底必出这三张之一，普通金卡也有一半概率落在这里。 */
const UP_SSR_IDS = ['sw_08', 'sw_09', 'si_05'];
const upSsrCards = UP_SSR_IDS.map(id => CARD_BY_ID.get(id)).filter(Boolean);
const standardSsrCards = cards.filter(card => card.rarity === 'SSR' && !UP_SSR_IDS.includes(card.id));
const SSR_CARD_IDS = cards.filter(card => card.rarity === 'SSR').map(card => card.id);

/* ========================= 8. 刮刮乐符号 ========================= */

export const scratchSymbols = [
  { id: 'star', name: '星', glyph: '★' },
  { id: 'letter', name: '信', glyph: '✉' },
  { id: 'anchor', name: '锚', glyph: '⚓' },
  { id: 'sail', name: '帆', glyph: '⛵' },
  { id: 'moon', name: '月', glyph: '☾' },
  { id: 'tide', name: '潮', glyph: '≈' },
  { id: 'wish', name: '愿', glyph: '✦' },
];

const LINE_DEFS = [
  { id: 'r0', type: 'row', index: 0, cells: [0, 1, 2] },
  { id: 'r1', type: 'row', index: 1, cells: [3, 4, 5] },
  { id: 'r2', type: 'row', index: 2, cells: [6, 7, 8] },
  { id: 'c0', type: 'col', index: 0, cells: [0, 3, 6] },
  { id: 'c1', type: 'col', index: 1, cells: [1, 4, 7] },
  { id: 'c2', type: 'col', index: 2, cells: [2, 5, 8] },
  { id: 'd0', type: 'diag', index: 0, cells: [0, 4, 8] },
  { id: 'd1', type: 'diag', index: 1, cells: [2, 4, 6] },
];

/** 中奖线数量 → 奖项。3 条及以上为「三连同图·大奖」，额外附赠一张 UP 金卡。 */
function scratchTier(lineCount) {
  if (lineCount >= 3) return { id: 'big', name: '大奖', label: '三连同图·大奖', stardust: 88, bigCard: true };
  if (lineCount === 2) return { id: 'lucky', name: '幸运奖', label: '双线幸运奖', stardust: 25, bigCard: false };
  return { id: 'small', name: '小奖', label: '单线小奖', stardust: 8, bigCard: false };
}

/* ========================= 9. 兑换单 ========================= */

/** 星屑兑换：卡按稀有度定价，另含 2 个头衔与 2 个边框。 */
export const redeemables = [];

function buildRedeemables() {
  for (const card of cards) {
    redeemables.push({
      id: card.id,
      kind: 'card',
      name: card.name,
      rarity: card.rarity,
      set: card.set,
      price: CARD_PRICE[card.rarity] || 20,
      desc: `用星屑直接换到「${card.name}」`,
    });
  }
  for (const item of [
    { id: 't_shop', kind: 'title', price: 300 },
    { id: 't_starweaver', kind: 'title', price: 500 },
    { id: 'f_lace', kind: 'frame', price: 260 },
    { id: 'f_tideglass', kind: 'frame', price: 320 },
  ]) {
    const meta = item.kind === 'title' ? TITLE_BY_ID.get(item.id) : FRAME_BY_ID.get(item.id);
    const name = meta ? meta.name : item.id;
    redeemables.push({ ...item, name, desc: `用星屑换到${item.kind === 'title' ? '头衔' : '边框'}「${name}」` });
  }
}
buildRedeemables();

/* ============================ 10. 小工具 ============================ */

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toCount(value) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  if (number <= 0) return 0;
  if (number >= 1) return 0.999999;
  return number;
}

function toRng(rng) {
  const source = typeof rng === 'function' ? rng : Math.random;
  return function next() {
    return clamp01(source());
  };
}

function pickIndex(length, roll) {
  if (length <= 0) return 0;
  const index = Math.floor(clamp01(roll()) * length);
  return index >= length ? length - 1 : index;
}

function rollRarity(roll) {
  const value = roll();
  let acc = 0;
  for (const row of rarities) {
    acc += row.rate;
    if (value < acc) return row.id;
  }
  return rarities[rarities.length - 1].id;
}

function setIdOf(card) {
  return card && card.set ? card.set : 'post_office';
}

function setNameOf(card) {
  const set = SET_BY_ID.get(setIdOf(card));
  return set ? set.name : setIdOf(card);
}

function rarityOf(id) {
  return RARITY[id] || RARITY.N;
}

function cardIdsOfSet(setId) {
  return (SET_CARD_INDEX.get(setId) || []).slice();
}

function capArray(list, limit) {
  if (Array.isArray(list) && list.length > limit) list.length = limit;
  return list;
}

function uniqueStrings(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item === 'string' && item && !out.includes(item)) out.push(item);
  }
  return out;
}

function pushLog(profile, entry) {
  profile.log.unshift(entry);
  capArray(profile.log, LOG_LIMIT);
}

/** 只接受 yyyy-m-d / yyyy-mm-dd 文本（或 Date），统一成北京时间口径的 yyyy-mm-dd。 */
function normalizeDay(day) {
  if (day instanceof Date && !Number.isNaN(day.getTime())) {
    const month = String(day.getMonth() + 1).padStart(2, '0');
    const date = String(day.getDate()).padStart(2, '0');
    return `${day.getFullYear()}-${month}-${date}`;
  }
  if (typeof day !== 'string') return null;
  const matched = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(day.trim());
  if (!matched) return null;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const date = Number(matched[3]);
  if (year < 1970 || year > 9999 || month < 1 || month > 12) return null;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (date < 1 || date > lastDay) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
}

/* ======================= 11. profile 初始化 ======================= */

/**
 * 原地补齐 profile 的字段并返回同一个对象。
 * 允许传入 {} —— 所有内容都会自动初始化，因此可以从零开始累积。
 */
export function normalizeProfile(profile) {
  const p = isObject(profile) ? profile : {};
  // 兼容：如果调用方给的是「未命名空间的旧扁平状态」，就地承接。
  if (!isObject(p.__rewards)) {
    p.__rewards = { module: MODULE_ID, version: MODULE_VERSION };
  } else if (!p.__rewards.module) {
    p.__rewards.module = MODULE_ID;
  }
  if (typeof p.createdAt !== 'string' || !p.createdAt) p.createdAt = null;
  if (!isObject(p.daily)) p.daily = { day: null, ten: 0, scratch: 0, bag: 0 };
  if (typeof p.daily.day !== 'string') p.daily.day = null;
  for (const key of ['ten', 'scratch', 'bag']) p.daily[key] = toCount(p.daily[key]);

  if (!isObject(p.pity)) p.pity = { counter: 0, gold: 0, forcedGold: 0, bestSpan: 0 };
  for (const key of ['counter', 'gold', 'forcedGold', 'bestSpan']) p.pity[key] = toCount(p.pity[key]);

  if (!isObject(p.draws)) p.draws = { ten: 0, single: 0, total: 0, golds: 0, dupes: 0 };
  for (const key of ['ten', 'single', 'total', 'golds', 'dupes']) p.draws[key] = toCount(p.draws[key]);

  const cleanCards = {};
  if (isObject(p.cards)) {
    for (const [id, qty] of Object.entries(p.cards)) {
      const count = toCount(qty);
      if (count > 0 && CARD_BY_ID.has(id)) cleanCards[id] = count;
    }
  }
  p.cards = cleanCards;

  p.stardust = toCount(p.stardust);
  p.stardustEarned = toCount(p.stardustEarned);

  p.titles = uniqueStrings(p.titles).filter(id => TITLE_BY_ID.has(id));
  p.frames = uniqueStrings(p.frames).filter(id => FRAME_BY_ID.has(id));
  if (!p.frames.includes(DEFAULT_FRAME)) p.frames.unshift(DEFAULT_FRAME);
  if (typeof p.equippedTitle !== 'string' || !p.titles.includes(p.equippedTitle)) p.equippedTitle = null;
  if (typeof p.equippedFrame !== 'string' || !p.frames.includes(p.equippedFrame)) p.equippedFrame = DEFAULT_FRAME;

  if (!isObject(p.scratch)) p.scratch = { plays: 0, big: 0, history: [], pending: null };
  p.scratch.plays = toCount(p.scratch.plays);
  p.scratch.big = toCount(p.scratch.big);
  if (!Array.isArray(p.scratch.history)) p.scratch.history = [];
  if (!isObject(p.scratch.pending)) p.scratch.pending = null;

  if (!isObject(p.bag)) p.bag = { opens: 0, best: 0, lastChain: 0, history: [] };
  for (const key of ['opens', 'best', 'lastChain']) p.bag[key] = toCount(p.bag[key]);
  if (!Array.isArray(p.bag.history)) p.bag.history = [];

  if (!isObject(p.shop)) p.shop = { redeemed: 0, spent: 0, history: [] };
  for (const key of ['redeemed', 'spent']) p.shop[key] = toCount(p.shop[key]);
  if (!Array.isArray(p.shop.history)) p.shop.history = [];

  if (!Array.isArray(p.log)) p.log = [];
  capArray(p.log, LOG_LIMIT);
  return p;
}

/** 跨天时清零当日配额；createdAt 在第一次使用时落定。 */
function ensureDay(profile, day) {
  if (profile.daily.day !== day) {
    profile.daily.day = day;
    profile.daily.ten = 0;
    profile.daily.scratch = 0;
    profile.daily.bag = 0;
  }
  if (!profile.createdAt) profile.createdAt = day;
  profile.updatedAt = day;
  return profile.daily;
}

/**
 * 当日剩余次数（供面板显示）。传入 day 时按「该天」估算：与记录日期不同即视为新的一天，
 * 直接给出满额（纯只读，不会修改 profile；真正的清零发生在下一次玩法调用里）。
 */
export function remainingDaily(profile, day) {
  const p = normalizeProfile(profile);
  const asked = day === undefined || day === null ? null : normalizeDay(day);
  const fresh = !!(asked && asked !== p.daily.day);
  const used = fresh ? { ten: 0, scratch: 0, bag: 0 } : { ten: p.daily.ten, scratch: p.daily.scratch, bag: p.daily.bag };
  return {
    day: asked || p.daily.day,
    fresh,
    used: { ten: used.ten, scratch: used.scratch, bag: used.bag },
    ten: Math.max(0, rewardsConfig.dailyTen - used.ten),
    scratch: Math.max(0, rewardsConfig.dailyScratch - used.scratch),
    bag: Math.max(0, rewardsConfig.dailyBag - used.bag),
    limit: { ten: rewardsConfig.dailyTen, scratch: rewardsConfig.dailyScratch, bag: rewardsConfig.dailyBag },
  };
}

function pityView(profile) {
  const total = rewardsConfig.pity > 0 ? rewardsConfig.pity : 30;
  const counter = Math.min(total, profile.pity.counter);
  return {
    counter,
    total,
    nextIn: Math.max(0, total - counter),
    gold: profile.pity.gold,
    forcedGold: profile.pity.forcedGold,
    bestSpan: profile.pity.bestSpan,
  };
}

/* ========================= 12. 解锁同步 ========================= */

/** 计算「此刻应当拥有」的头衔与边框（纯函数，不改状态）。 */
function computeUnlocks(profile) {
  const owned = id => toCount(profile.cards[id]) > 0;
  const complete = setId => cardIdsOfSet(setId).every(owned);
  const titleIds = [];
  const frameIds = [];

  if (Object.keys(profile.cards).length > 0) titleIds.push('t_novice');
  for (const set of sets) {
    if (!complete(set.id)) continue;
    if (set.title) titleIds.push(set.title);
    if (set.frame) frameIds.push(set.frame);
  }
  if (sets.every(set => complete(set.id))) titleIds.push('t_all_sets');
  if (cards.every(card => owned(card.id))) titleIds.push('t_all_cards');
  if (profile.bag.best >= CHAIN_TITLE_AT) titleIds.push('t_chain10');
  if (profile.bag.best >= MAX_CHAIN) titleIds.push('t_chain12');
  if (profile.bag.opens >= 20) titleIds.push('t_bag_regular');
  if (profile.scratch.big >= 1) titleIds.push('t_lucky');
  if (profile.scratch.plays >= 20) titleIds.push('t_scratch_regular');
  if (profile.stardustEarned >= 1000) titleIds.push('t_rich');
  if (profile.shop.redeemed >= 5) titleIds.push('t_redeem_regular');
  if (profile.draws.total >= 100) titleIds.push('t_veteran');
  if (SSR_CARD_IDS.every(owned)) frameIds.push('f_gold_seal');
  return { titleIds, frameIds };
}

/** 幂等地发放应当获得的头衔/边框，返回本次新解锁的内容。 */
function syncUnlocks(profile) {
  const { titleIds, frameIds } = computeUnlocks(profile);
  const grantedTitles = [];
  const grantedFrames = [];
  for (const id of titleIds) {
    if (profile.titles.includes(id)) continue;
    profile.titles.push(id);
    const meta = TITLE_BY_ID.get(id);
    grantedTitles.push({ id, name: meta ? meta.name : id, source: meta ? meta.source : '' });
  }
  for (const id of frameIds) {
    if (profile.frames.includes(id)) continue;
    profile.frames.push(id);
    const meta = FRAME_BY_ID.get(id);
    grantedFrames.push({ id, name: meta ? meta.name : id, source: meta ? meta.source : '', hidden: !!(meta && meta.hidden) });
  }
  if (grantedTitles.length || grantedFrames.length) {
    const parts = [
      ...grantedTitles.map(item => `解锁头衔「${item.name}」`),
      ...grantedFrames.map(item => `解锁边框「${item.name}」`),
    ];
    pushLog(profile, { type: 'unlock', day: profile.updatedAt || profile.daily.day, text: parts.join('，') });
  }
  return { titles: grantedTitles, frames: grantedFrames };
}

/** 按稀有度换算出 presentation.render 使用的样式名（gold / purple / ''）。 */
function styleOf(rarityId) {
  return rarityOf(rarityId).style;
}

/** 一张卡的「tile」视图，可直接塞进 presentation.render({ tiles }) 。 */
function tileOf(card, extra = {}) {
  const rarity = rarityOf(card.rarity);
  return {
    kind: 'cards',
    id: card.id,
    type: card.type,          // presentation.cardSvg 依此挑选图案（角色/信物/场景/彩蛋）
    set: card.set,
    setName: setNameOf(card),
    name: card.name,
    meta: `${rarity.name} · ${card.type} · ${setNameOf(card)}${extra.meta ? ` · ${extra.meta}` : ''}`,
    rarity: rarity.style,
    symbol: rarity.glyph,
    hidden: false,
    ...extra,
  };
}

/** 一张卡的文字摘要（给纯文本兜底）。 */
export function describeCard(card) {
  if (!card) return '';
  const rarity = rarityOf(card.rarity);
  return `【${rarity.name}】${card.name}（${card.type} · ${setNameOf(card)}）`;
}

/* ========================== 13. 抽卡核心 ========================== */

/** 授予一张卡：重复卡折算星屑；返回本次的拥有信息。 */
function grantCard(profile, card, source) {
  const before = toCount(profile.cards[card.id]);
  profile.cards[card.id] = before + 1;
  const isNew = before === 0;
  const stardust = isNew ? 0 : rarityOf(card.rarity).stardust;
  if (stardust > 0) {
    profile.stardust += stardust;
    profile.stardustEarned += stardust;
  }
  return { card, isNew, stardust, owned: before + 1, source };
}

/** 单抽：先判保底，再掷稀有度；金卡过半概率为 UP；重复卡转星屑。 */
function doPull(profile, roll) {
  const pityTotal = rewardsConfig.pity > 0 ? rewardsConfig.pity : 30;
  profile.draws.total += 1;
  profile.pity.counter += 1;

  const forced = profile.pity.counter >= pityTotal;
  const rarityId = forced ? 'SSR' : rollRarity(roll);
  let pool;
  let isUp = false;
  if (rarityId === 'SSR') {
    const wantUp = forced ? true : roll() < UP_SSR_RATE;
    isUp = wantUp;
    pool = wantUp
      ? (upSsrCards.length ? upSsrCards : standardSsrCards)
      : (standardSsrCards.length ? standardSsrCards : upSsrCards);
  } else {
    pool = cards.filter(card => card.rarity === rarityId);
  }
  if (!pool || pool.length === 0) pool = cards;
  const card = pool[pickIndex(pool.length, roll)] || pool[pool.length - 1];

  const grant = grantCard(profile, card, 'draw');
  if (grant.stardust > 0) profile.draws.dupes += 1;

  if (rarityId === 'SSR') {
    profile.draws.golds += 1;
    profile.pity.gold += 1;
    if (forced) profile.pity.forcedGold += 1;
    profile.pity.bestSpan = Math.max(profile.pity.bestSpan, profile.pity.counter);
    profile.pity.counter = 0; // 出金后保底重新计数
  }

  const rarity = rarityOf(card.rarity);
  return {
    cardId: card.id,
    name: card.name,
    rarity: card.rarity,
    rarityName: rarity.name,
    rarityStyle: rarity.style,
    rarityGlyph: rarity.glyph,
    type: card.type,
    set: card.set,
    setId: card.set,
    setName: setNameOf(card),
    flavor: card.flavor,
    isNew: grant.isNew,
    isUp,
    forced,
    stardust: grant.stardust,
    owned: grant.owned,
    tile: tileOf(card, { meta: grant.isNew ? '新收录' : `重复 → 星屑 +${grant.stardust}` }),
    text: `${rarity.name}「${card.name}」${grant.isNew ? '（新收录）' : `（重复 → 星屑 +${grant.stardust}）`}`,
  };
}

/**
 * 十连补给：每日 rewardsConfig.dailyTen 次，逐抽累计保底，30 抽必金且保底金为 UP。
 * @returns {{profile: object, result?: object, error?: string}}
 */
export function drawTen(profile, day, rng = Math.random) {
  const p = normalizeProfile(profile);
  const today = normalizeDay(day);
  if (!today) return { profile: p, error: '日期无效：day 需要是北京时间 yyyy-mm-dd' };
  ensureDay(p, today);

  if (p.daily.ten >= rewardsConfig.dailyTen) {
    return { profile: p, error: `今日十连补给已用完（每日 ${rewardsConfig.dailyTen} 次，明天再来）` };
  }

  const roll = toRng(rng);
  p.daily.ten += 1;
  p.draws.ten += 1;
  const pityBefore = pityView(p);

  const pulls = [];
  for (let index = 0; index < 10; index += 1) pulls.push(doPull(p, roll));

  const rarityCount = { SSR: 0, SR: 0, R: 0, N: 0 };
  let newCount = 0;
  let dupeCount = 0;
  let stardustGained = 0;
  let upCount = 0;
  let forcedCount = 0;
  for (const pull of pulls) {
    rarityCount[pull.rarity] = (rarityCount[pull.rarity] || 0) + 1;
    if (pull.isNew) newCount += 1;
    else dupeCount += 1;
    stardustGained += pull.stardust;
    if (pull.isUp) upCount += 1;
    if (pull.forced) forcedCount += 1;
  }
  const golds = pulls.filter(pull => pull.rarity === 'SSR');
  const unlocked = syncUnlocks(p);
  const pityAfter = pityView(p);

  pushLog(p, {
    type: 'drawTen',
    day: today,
    text: `十连补给：新卡 ${newCount} / 重复 ${dupeCount} / 星屑 +${stardustGained}`,
  });

  const goldText = golds.length
    ? `金卡 ${golds.length} 张（${golds.map(gold => `${gold.name}${gold.isUp ? '·UP' : ''}`).join('、')}）`
    : '本次没有金卡';
  const text = `十连补给完成：新卡 ${newCount} 张，重复 ${dupeCount} 张化作 ${stardustGained} 星屑；${goldText}。`;

  return {
    profile: p,
    result: {
      kind: 'ten',
      day: today,
      pulls,
      golds,
      summary: {
        newCount,
        dupeCount,
        stardust: stardustGained,
        rarityCount,
        upCount,
        forcedCount,
        ownedCards: Object.keys(p.cards).length,
        catalogSize: cards.length,
      },
      pity: { before: pityBefore, after: pityAfter, forcedInTen: forcedCount },
      daily: remainingDaily(p),
      unlocked,
      stardust: p.stardust,
      text,
      lines: [
        `✉ 十连补给 · ${today} · 今日第 ${p.daily.ten}/${rewardsConfig.dailyTen} 次`,
        `新卡 ${newCount} · 重复 ${dupeCount} · 星屑 +${stardustGained}`,
        `稀有度：SSR×${rarityCount.SSR} / SR×${rarityCount.SR} / R×${rarityCount.R} / N×${rarityCount.N}`,
        golds.length
          ? `金卡：${golds.map(gold => `${gold.name}${gold.isUp ? '（UP）' : ''}`).join('、')}`
          : '本次没有金卡。',
        `保底进度 ${pityAfter.counter}/${pityAfter.total}（再 ${pityAfter.nextIn} 抽必金）`,
      ],
      view: {
        title: '十连补给',
        lead: text,
        tiles: pulls.map(pull => pull.tile),
        mode: 'grid',
        footer: `保底进度 ${pityAfter.counter}/${pityAfter.total} · 星屑 ${p.stardust}`,
        golden: golds.length > 0,
      },
    },
  };
}

/* ========================== 14. 星愿刮刮乐 ========================== */

/** 生成一张 3x3 票面：必有中奖线，且尽量让中奖线数量等于目标值。 */
function buildGrid(roll, target) {
  const major = scratchSymbols[pickIndex(scratchSymbols.length, roll)] || scratchSymbols[0];
  const start = pickIndex(LINE_DEFS.length, roll);
  const chosen = [];
  for (let offset = 0; offset < target; offset += 1) {
    chosen.push(LINE_DEFS[(start + offset) % LINE_DEFS.length]);
  }
  const slot = new Array(REVEAL_TOTAL).fill(null);
  for (const line of chosen) {
    for (const cell of line.cells) slot[cell] = major;
  }
  const others = scratchSymbols.filter(symbol => symbol.id !== major.id);
  for (let index = 0; index < REVEAL_TOTAL; index += 1) {
    if (slot[index]) continue;
    slot[index] = others[pickIndex(others.length, roll)] || others[0] || major;
  }
  return slot;
}

function findWinLines(slot) {
  const result = [];
  for (const line of LINE_DEFS) {
    const a = slot[line.cells[0]];
    const b = slot[line.cells[1]];
    const c = slot[line.cells[2]];
    if (a && b && c && a.id === b.id && b.id === c.id) result.push(line);
  }
  return result;
}

function buildTicket(roll, day, sequence) {
  const targetRoll = roll();
  let target = 1;
  if (targetRoll >= 0.98) target = 4;
  else if (targetRoll >= 0.9) target = 3;
  else if (targetRoll >= 0.66) target = 2;

  let slot = buildGrid(roll, target);
  let lineDefs = findWinLines(slot);
  for (let attempt = 0; attempt < 5 && lineDefs.length !== target; attempt += 1) {
    slot = buildGrid(roll, target);
    lineDefs = findWinLines(slot);
    if (lineDefs.length === target) break;
  }
  // 兜底：构造永远成立（目标线被主符号填满，天然是赢线），因此至少 1 条中奖线。
  if (lineDefs.length === 0) {
    slot = buildGrid(roll, 1);
    lineDefs = findWinLines(slot);
  }

  const tier = scratchTier(lineDefs.length);
  const winCells = new Set();
  for (const line of lineDefs) {
    for (const cell of line.cells) winCells.add(cell);
  }
  const cells = slot.map((symbol, index) => ({
    index,
    row: Math.floor(index / 3),
    col: index % 3,
    symbolId: symbol.id,
    symbolName: symbol.name,
    glyph: symbol.glyph,
    win: winCells.has(index),
    lineIds: lineDefs.filter(line => line.cells.includes(index)).map(line => line.id),
  }));
  const winLines = lineDefs.map(line => ({
    id: line.id,
    type: line.type,
    index: line.index,
    cells: line.cells.slice(),
    symbolId: cells[line.cells[0]].symbolId,
    symbolName: cells[line.cells[0]].symbolName,
    glyph: cells[line.cells[0]].glyph,
  }));

  return {
    id: `echo-ticket-${day}-${sequence}`,
    day,
    target,
    cells,
    winLines,
    tier,
    prize: { stardust: tier.stardust, card: null, dupeStardust: 0, total: tier.stardust },
    reveal: { shown: 0, total: REVEAL_TOTAL, order: defaultRevealOrder(), done: false },
  };
}

function defaultRevealOrder() {
  const order = [];
  for (let index = 0; index < REVEAL_TOTAL; index += 1) order.push(index);
  return order;
}

function revealState(ticket) {
  if (!isObject(ticket)) return { shown: 0, total: REVEAL_TOTAL, order: defaultRevealOrder(), done: false };
  if (!isObject(ticket.reveal)) ticket.reveal = { shown: 0, total: REVEAL_TOTAL, order: defaultRevealOrder(), done: false };
  const reveal = ticket.reveal;
  const order = Array.isArray(reveal.order)
    && reveal.order.length === REVEAL_TOTAL
    && reveal.order.every(index => Number.isInteger(index) && index >= 0 && index < REVEAL_TOTAL)
    ? reveal.order.slice()
    : defaultRevealOrder();
  reveal.order = order;
  reveal.total = REVEAL_TOTAL;
  reveal.shown = Math.min(REVEAL_TOTAL, Math.max(0, toCount(reveal.shown)));
  reveal.done = reveal.shown >= REVEAL_TOTAL;
  return reveal;
}

/** 按当前展示进度生成「已揭开 / 未揭开」的视图（未揭开的格子不含任何答案信息）。 */
function buildScratchView(ticket) {
  const reveal = revealState(ticket);
  const shownSet = new Set(reveal.order.slice(0, reveal.shown));
  const cells = ticket.cells.map(cell => {
    const revealed = shownSet.has(cell.index);
    return {
      index: cell.index,
      row: cell.row,
      col: cell.col,
      revealed,
      symbolId: revealed ? cell.symbolId : null,
      symbolName: revealed ? cell.symbolName : '待刮开',
      glyph: revealed ? cell.glyph : '▨',
      win: revealed && cell.win,
      lineIds: revealed ? cell.lineIds.slice() : [],
      tile: revealed
        ? { kind: 'cells', id: cell.symbolId, name: cell.symbolName, meta: cell.win ? '中奖线' : '未中', rarity: cell.win ? 'gold' : '', symbol: cell.glyph, hidden: false }
        : { kind: 'cells', id: 'covered', name: '待刮开', meta: '刮开看看', rarity: '', symbol: '？', hidden: true },
    };
  });
  const revealedLines = ticket.winLines.filter(line => line.cells.every(cell => shownSet.has(cell)));
  const done = reveal.done;
  const text = done
    ? `${ticket.tier.label}：中奖线 ${ticket.winLines.length} 条，共得 ${ticket.prize.total} 星屑${ticket.prize.card ? `，另附金奖卡「${ticket.prize.card.name}」` : ''}。`
    : `星愿刮刮乐：已揭开 ${reveal.shown}/${reveal.total} 格，继续刮。`;
  return {
    kind: 'scratch',
    ticketId: ticket.id,
    day: ticket.day,
    tier: { id: ticket.tier.id, name: ticket.tier.name, label: ticket.tier.label },
    prize: ticket.prize,
    stardust: ticket.prize.total,
    reveal: { shown: reveal.shown, total: reveal.total, done, order: reveal.order.slice() },
    cells,
    winLines: revealedLines,
    winLineCount: ticket.winLines.length,
    text,
    lines: [
      `✦ 星愿刮刮乐 · ${ticket.day} · ${ticket.id}`,
      done ? `${ticket.tier.label}：中奖线 ${ticket.winLines.length} 条` : `揭晓进度 ${reveal.shown}/${reveal.total}`,
      `星屑 +${ticket.prize.total}${ticket.prize.card ? ` · 金奖卡「${ticket.prize.card.name}」` : ''}`,
    ],
    view: {
      title: '星愿刮刮乐',
      lead: text,
      tiles: cells.map(cell => cell.tile),
      mode: 'scratch',
      footer: `揭晓 ${reveal.shown}/${reveal.total} · 星屑 ${ticket.prize.total}`,
      golden: done && ticket.tier.id === 'big',
    },
  };
}

/**
 * 星愿刮刮乐：每日 rewardsConfig.dailyScratch 张，3x3 必有中奖线，三连同图即大奖。
 * 奖赏当场结算；result.view / result.ticket.reveal 只反映展示进度。
 */
export function scratch(profile, day, rng = Math.random) {
  const p = normalizeProfile(profile);
  const today = normalizeDay(day);
  if (!today) return { profile: p, error: '日期无效：day 需要是北京时间 yyyy-mm-dd' };
  ensureDay(p, today);

  if (p.daily.scratch >= rewardsConfig.dailyScratch) {
    return { profile: p, error: `今日星愿刮刮乐已用完（每日 ${rewardsConfig.dailyScratch} 张，明天再来）` };
  }

  const roll = toRng(rng);
  p.daily.scratch += 1;
  p.scratch.plays += 1;

  const ticket = buildTicket(roll, today, p.scratch.plays);
  const tier = ticket.tier;

  p.stardust += tier.stardust;
  p.stardustEarned += tier.stardust;

  if (tier.bigCard) {
    const pool = upSsrCards.length ? upSsrCards : cards.filter(card => card.rarity === 'SSR');
    const card = pool[pickIndex(pool.length, roll)] || pool[0];
    const grant = grantCard(p, card, 'scratch');
    ticket.prize.dupeStardust = grant.stardust;
    ticket.prize.card = {
      cardId: card.id,
      name: card.name,
      rarity: card.rarity,
      rarityName: rarityOf(card.rarity).name,
      rarityStyle: styleOf(card.rarity),
      type: card.type,
      set: card.set,
      setName: setNameOf(card),
      flavor: card.flavor,
      isNew: grant.isNew,
      stardust: grant.stardust,
      tile: tileOf(card, { meta: grant.isNew ? '大奖附赠' : `大奖重复 → 星屑 +${grant.stardust}` }),
    };
    ticket.prize.total = tier.stardust + grant.stardust;
    if (tier.id === 'big') p.scratch.big += 1;
  }

  p.scratch.pending = ticket;
  p.scratch.history.unshift({
    day: today,
    ticketId: ticket.id,
    tier: tier.id,
    lines: ticket.winLines.length,
    stardust: ticket.prize.total,
    card: ticket.prize.card ? ticket.prize.card.cardId : null,
  });
  capArray(p.scratch.history, HISTORY_LIMIT);

  const unlocked = syncUnlocks(p);
  pushLog(p, {
    type: 'scratch',
    day: today,
    text: `刮刮乐：${tier.label} · 中奖线 ${ticket.winLines.length} 条 · 星屑 +${ticket.prize.total}`,
  });

  const render = buildScratchView(ticket);
  return {
    profile: p,
    result: {
      ...render,                        // tier / prize / reveal / cells / text / lines / view
      kind: 'scratch',
      day: today,
      ticket,
      winLines: ticket.winLines,        // 真相：中奖线（供结算展示）
      revealedLines: render.winLines,   // 按当前展示进度过滤后的中奖线
      daily: remainingDaily(p),
      unlocked,
      stardust: p.stardust,
    }
  };
}

/** 推进「展示进度」（不改变奖赏，不消耗配额）：n 格。 */
export function advanceScratch(profile, steps = 1) {
  const p = normalizeProfile(profile);
  const ticket = p.scratch.pending;
  if (!isObject(ticket)) return { profile: p, error: '当前没有待展示的星愿彩票，请先调用 scratch()' };
  const reveal = revealState(ticket);
  const advance = Number.isFinite(Number(steps)) ? Math.floor(Number(steps)) : 1;
  reveal.shown = Math.min(REVEAL_TOTAL, Math.max(0, reveal.shown + Math.max(0, advance)));
  reveal.done = reveal.shown >= REVEAL_TOTAL;
  return { profile: p, result: buildScratchView(ticket) };
}

/** 只看当前展示进度（不改任何状态）。 */
export function scratchView(profile) {
  const p = normalizeProfile(profile);
  const ticket = p.scratch.pending;
  if (!isObject(ticket)) return { profile: p, error: '当前没有待展示的星愿彩票，请先调用 scratch()' };
  return { profile: p, result: buildScratchView(ticket) };
}

/* =========================== 15. 连锁福袋 =========================== */

/** 第 n 连之后「是否继续」的概率：越往后越难，但始终有戏。 */
function chainChance(chain) {
  return Math.min(0.9, Math.max(0.55, 0.9 - 0.03 * chain));
}

function bagLink(profile, step, roll) {
  const stardust = 2 + 2 * step;
  profile.stardust += stardust;
  profile.stardustEarned += stardust;

  const cardChance = step >= 8 ? 0.35 : step >= 4 ? 0.22 : 0.12;
  let card = null;
  let total = stardust;
  if (roll() < cardChance) {
    const rarityId = rollRarity(roll);
    const pool = cards.filter(item => item.rarity === rarityId);
    const picked = pool[pickIndex(pool.length, roll)] || pool[pool.length - 1] || cards[0];
    const grant = grantCard(profile, picked, 'bag');
    total += grant.stardust;
    card = {
      cardId: picked.id,
      name: picked.name,
      rarity: picked.rarity,
      rarityName: rarityOf(picked.rarity).name,
      rarityStyle: styleOf(picked.rarity),
      type: picked.type,
      set: picked.set,
      setName: setNameOf(picked),
      flavor: picked.flavor,
      isNew: grant.isNew,
      stardust: grant.stardust,
      tile: tileOf(picked, { meta: grant.isNew ? '福袋开出' : `重复 → 星屑 +${grant.stardust}` }),
    };
  }
  return {
    step,
    stardust,
    total,
    card,
    text: `第 ${step} 连：星屑 +${stardust}${card ? ` · ${card.isNew ? '开出新卡' : '重复卡'}「${card.name}」` : ''}`,
  };
}

/**
 * 连锁福袋：每日 rewardsConfig.dailyBag 个；连锁最多 12 连，10 连及以上给头衔。
 */
export function bag(profile, day, rng = Math.random) {
  const p = normalizeProfile(profile);
  const today = normalizeDay(day);
  if (!today) return { profile: p, error: '日期无效：day 需要是北京时间 yyyy-mm-dd' };
  ensureDay(p, today);

  if (p.daily.bag >= rewardsConfig.dailyBag) {
    return { profile: p, error: `今日连锁福袋已用完（每日 ${rewardsConfig.dailyBag} 个，明天再来）` };
  }

  const roll = toRng(rng);
  p.daily.bag += 1;
  p.bag.opens += 1;

  const links = [bagLink(p, 1, roll)];
  let chain = 1;
  while (chain < MAX_CHAIN) {
    if (roll() >= chainChance(chain)) break;
    chain += 1;
    links.push(bagLink(p, chain, roll));
  }

  p.bag.best = Math.max(p.bag.best, chain);
  p.bag.lastChain = chain;
  const stardustGained = links.reduce((sum, link) => sum + link.total, 0);
  const cardsGot = links.filter(link => link.card).map(link => link.card);
  p.bag.history.unshift({ day: today, chain, stardust: stardustGained, cards: cardsGot.map(card => card.cardId) });
  capArray(p.bag.history, HISTORY_LIMIT);

  const unlocked = syncUnlocks(p);
  pushLog(p, { type: 'bag', day: today, text: `福袋 ${chain} 连锁 · 星屑 +${stardustGained}` });

  const chainNote = chain >= CHAIN_TITLE_AT ? `达成 ${chain} 连锁，头衔已到帐。` : '再连上一点就有头衔了。';
  const text = `连锁福袋开出 ${chain} 连：共得 ${stardustGained} 星屑${cardsGot.length ? `，附赠 ${cardsGot.map(card => `「${card.name}」`).join('、')}` : ''}。${chainNote}`;

  return {
    profile: p,
    result: {
      kind: 'bag',
      day: today,
      chain,
      maxChain: MAX_CHAIN,
      links,
      cards: cardsGot,
      summary: {
        stardust: stardustGained,
        cardCount: cardsGot.length,
        newCount: cardsGot.filter(card => card.isNew).length,
        best: p.bag.best,
        titleAt: CHAIN_TITLE_AT,
      },
      daily: remainingDaily(p),
      unlocked,
      stardust: p.stardust,
      text,
      lines: [
        `⌘ 连锁福袋 · ${today} · ${chain} 连（上限 ${MAX_CHAIN}）`,
        ...links.map(link => link.text),
        `合计星屑 +${stardustGained} · 历史最佳 ${p.bag.best} 连`,
      ],
      view: {
        title: `连锁福袋 · ${chain} 连`,
        lead: text,
        tiles: links.filter(link => link.card).map(link => link.card.tile),
        mode: 'row',
        footer: `历史最佳 ${p.bag.best} 连 · 星屑 ${p.stardust}`,
        golden: chain >= CHAIN_TITLE_AT,
      },
    },
  };
}

/* =========================== 16. 收藏馆 =========================== */

/**
 * 收藏馆快照（顺带幂等补齐应得的头衔/边框）。
 * @returns {{sets: object[], cards: object[], titles: object[], frames: object[], equippedTitle: string|null, equippedFrame: string, stardust: number}}
 */
export function collection(profile) {
  const p = normalizeProfile(profile);
  syncUnlocks(p);

  const setViews = sets.map(set => {
    const ids = cardIdsOfSet(set.id);
    const ownedIds = ids.filter(id => toCount(p.cards[id]) > 0);
    const missing = ids.filter(id => !ownedIds.includes(id));
    return {
      id: set.id,
      name: set.name,
      desc: set.desc,
      hidden: !!set.hidden,
      easter: !!set.easter,
      total: ids.length,
      owned: ownedIds.length,
      complete: missing.length === 0,
      cards: ids,
      missing,
      progress: `${ownedIds.length}/${ids.length}`,
      reward: {
        titleId: set.title || null,
        title: set.title && TITLE_BY_ID.has(set.title) ? TITLE_BY_ID.get(set.title).name : null,
        frameId: set.frame || null,
        frame: set.frame && FRAME_BY_ID.has(set.frame) ? FRAME_BY_ID.get(set.frame).name : null,
      },
    };
  });

  const cardViews = cards.map(card => {
    const count = toCount(p.cards[card.id]);
    const owned = count > 0;
    return {
      id: card.id,
      name: card.name,
      rarity: card.rarity,
      rarityName: rarityOf(card.rarity).name,
      rarityStyle: styleOf(card.rarity),
      type: card.type,
      set: card.set,
      setId: card.set,
      setName: setNameOf(card),
      flavor: card.flavor,
      owned,
      count,
      price: CARD_PRICE[card.rarity] || 20,
      tile: tileOf(card, { hidden: !owned, meta: owned ? `已有 ${count} 张` : '等待拆封' }),
    };
  });

  const titleViews = titles.map(title => ({
    id: title.id,
    name: title.name,
    source: title.source,
    desc: title.desc,
    owned: p.titles.includes(title.id),
    equipped: p.equippedTitle === title.id,
    hidden: !!title.hidden,
  }));

  const frameViews = frames.map(frame => {
    const owned = p.frames.includes(frame.id);
    const masked = !!frame.hidden && !owned;
    return {
      id: frame.id,
      name: masked ? '？？？' : frame.name,
      source: masked ? '？？？' : frame.source,
      desc: masked ? '隐藏边框：条件达成后自动显现。' : frame.desc,
      owned,
      equipped: p.equippedFrame === frame.id,
      hidden: !!frame.hidden,
      revealed: !masked,
    };
  });

  return {
    sets: setViews,
    cards: cardViews,
    titles: titleViews,
    frames: frameViews,
    equippedTitle: p.equippedTitle,
    equippedFrame: p.equippedFrame,
    stardust: p.stardust,
  };
}

/* =========================== 17. 佩戴 =========================== */

function normalizeKind(kind) {
  const value = String(kind ?? '').trim().toLowerCase();
  if (['title', 'titles', '头衔', '称号'].includes(value)) return 'title';
  if (['frame', 'frames', '边框', '画框', '相框'].includes(value)) return 'frame';
  return null;
}

/**
 * 佩戴 / 卸下头衔或边框：只能佩戴已经拥有的（id 传 null 表示卸下）。
 * @returns {{profile: object, result?: object, error?: string}}
 */
export function equip(profile, kind, id) {
  const p = normalizeProfile(profile);
  const target = normalizeKind(kind);
  if (!target) return { profile: p, error: 'kind 只能是 "title"（头衔/称号）或 "frame"（边框）' };
  const label = target === 'title' ? '头衔' : '边框';
  const catalog = target === 'title' ? titles : frames;

  if (id === null || id === undefined || id === '') {
    if (target === 'title') p.equippedTitle = null;
    else p.equippedFrame = DEFAULT_FRAME;
    pushLog(p, { type: 'equip', day: p.updatedAt || p.daily.day, text: `卸下${label}` });
    return {
      profile: p,
      result: {
        kind: target,
        id: null,
        action: 'unequip',
        equippedTitle: p.equippedTitle,
        equippedFrame: p.equippedFrame,
        text: `已卸下${label}。`,
      },
    };
  }

  if (typeof id !== 'string') return { profile: p, error: `${label}编号需要是字符串` };
  const item = catalog.find(entry => entry.id === id);
  if (!item) return { profile: p, error: `找不到${label}「${id}」` };
  const ownedList = target === 'title' ? p.titles : p.frames;
  if (!ownedList.includes(id)) return { profile: p, error: `尚未拥有${label}「${item.name}」，无法佩戴` };

  if (target === 'title') p.equippedTitle = id;
  else p.equippedFrame = id;
  pushLog(p, { type: 'equip', day: p.updatedAt || p.daily.day, text: `佩戴${label}「${item.name}」` });

  return {
    profile: p,
    result: {
      kind: target,
      id,
      name: item.name,
      action: 'equip',
      equippedTitle: p.equippedTitle,
      equippedFrame: p.equippedFrame,
      text: `已佩戴${label}「${item.name}」。`,
    },
  };
}

/* =========================== 18. 星屑兑换 =========================== */

/**
 * 星屑兑换指定卡 / 头衔 / 边框；余额不足直接报错，绝不出现负星屑。
 * @returns {{profile: object, result?: object, error?: string}}
 */
export function redeem(profile, id) {
  const p = normalizeProfile(profile);
  if (typeof id !== 'string' || !id) return { profile: p, error: '请提供要兑换的编号（卡 id / 头衔 id / 边框 id）' };

  const item = redeemables.find(entry => entry.id === id);
  if (!item) return { profile: p, error: `兑换单里没有「${id}」` };

  const label = item.kind === 'card' ? '卡' : item.kind === 'title' ? '头衔' : '边框';
  if (item.kind === 'card' && toCount(p.cards[item.id]) > 0) {
    return { profile: p, error: `已拥有「${item.name}」，多余的同名卡在抽取时会自动转成星屑` };
  }
  if (item.kind === 'title' && p.titles.includes(item.id)) return { profile: p, error: `已拥有头衔「${item.name}」` };
  if (item.kind === 'frame' && p.frames.includes(item.id)) return { profile: p, error: `已拥有边框「${item.name}」` };
  if (p.stardust < item.price) {
    return { profile: p, error: `星屑不足：兑换${label}「${item.name}」需要 ${item.price}，当前只有 ${p.stardust}` };
  }

  p.stardust -= item.price; // 已校验 price <= stardust
  p.shop.spent += item.price;
  p.shop.redeemed += 1;
  p.shop.history.unshift({ day: p.updatedAt || p.daily.day, id: item.id, kind: item.kind, price: item.price });
  capArray(p.shop.history, HISTORY_LIMIT);

  let granted;
  if (item.kind === 'card') {
    const card = CARD_BY_ID.get(item.id);
    granted = grantCard(p, card, 'redeem');
  } else if (item.kind === 'title') {
    p.titles.push(item.id);
  } else {
    p.frames.push(item.id);
  }
  const unlocked = syncUnlocks(p);
  pushLog(p, { type: 'redeem', day: p.updatedAt || p.daily.day, text: `兑换${label}「${item.name}」· 星屑 -${item.price}` });

  const text = `已用 ${item.price} 星屑换到${label}「${item.name}」，余额 ${p.stardust}。`;
  return {
    profile: p,
    result: {
      kind: item.kind,
      id: item.id,
      name: item.name,
      price: item.price,
      rarity: item.rarity || null,
      isNew: granted ? granted.isNew : true,
      stardust: p.stardust,
      stardustSpent: item.price,
      equippedTitle: p.equippedTitle,
      equippedFrame: p.equippedFrame,
      unlocked,
      text,
      lines: [
        `✧ 星屑兑换 · ${label}「${item.name}」`,
        `花费 ${item.price} · 余额 ${p.stardust}`,
        item.kind === 'card' ? `卡已入册：${describeCard(CARD_BY_ID.get(item.id))}` : '可直接用 equip() 佩戴。',
      ],
    },
  };
}

/* ====================== 19. 可复现随机源（可选） ====================== */

/** mulberry32：给测试与复盘用的小型可复现随机源。 */
export function createRng(seed = 1) {
  let state = (Number(seed) >>> 0) || 1;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export default {
  rewardsConfig,
  cards,
  sets,
  titles,
  frames,
  rarities,
  scratchSymbols,
  redeemables,
  drawTen,
  scratch,
  bag,
  collection,
  equip,
  redeem,
  advanceScratch,
  scratchView,
  remainingDaily,
  normalizeProfile,
  describeCard,
  createRng,
};
