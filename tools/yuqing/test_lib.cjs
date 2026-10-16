'use strict';
/**
 * test_lib.cjs —— 纯逻辑层单元测试（不联网）
 * 用法：node tools\yuqing\test_lib.cjs
 *
 * 为什么要有这个：判定规则是这套东西的核心资产，规则错了后面全错。
 * 这里把"数字解析／时间戳六型／时间窗口分级／闸门合成／闸门1-②"逐条钉死。
 */

const lib = require('./lib.cjs');

let pass = 0, fail = 0;
const failures = [];

function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; failures.push(`${label}\n     实际 ${a}\n     期望 ${e}`); }
}
function ok(cond, label) { eq(!!cond, true, label); }

// ───────── 1. 数字解析 ─────────
eq(lib.parseNum('6546'), 6546, '整数');
eq(lib.parseNum('2518.2万'), 25182000, '万');
eq(lib.parseNum('1.2亿'), 120000000, '亿');
eq(lib.parseNum('830'), 830, '三位数');
eq(lib.parseNum(''), null, '空串→null');
eq(lib.parseNum('暂无数据'), null, '非数字→null');
eq(lib.parseNum(null), null, 'null→null');
eq(lib.parseNum('1,344'), 1344, '带千分位');
eq(lib.fmtNum(25182000), '2518.2万', '格式化万');
eq(lib.fmtNum(6546), '6546', '格式化整数');
eq(lib.fmtNum(null), '—', '格式化空');

// ───────── 2. 取数正则（两个入口格式不同，不可混用） ─────────
// 入口甲：讨论在前
eq(lib.extractTopicLib('首页 6546讨论 2518.2万阅读 详情'), { discuss: 6546, read: 25182000, raw: '6546讨论 2518.2万阅读' }, '入口甲：讨论在前');
// 入口甲的正则不能误吃入口乙的格式
eq(lib.extractTopicLib('阅读量1405.1万 讨论量830'), null, '入口甲正则不吃入口乙格式');
// 入口乙：阅读在前且带"量"字
eq(lib.extractSearchPage('阅读量1405.1万 讨论量830'), { read: 14051000, discuss: 830, raw: '阅读量1405.1万 讨论量830' }, '入口乙：阅读在前');
// ★v2 的坑★：字段错位——用入口乙正则读入口甲文本应当失败，反之亦然
eq(lib.extractSearchPage('6546讨论 2518.2万阅读'), null, '入口乙正则不吃入口甲格式（字段错位防线）');
ok(lib.isTopicLibMiss('抱歉，未找到"xxx"相关结果'), '话题库未找到识别');
eq(lib.isTopicLibMiss('6546讨论 2518.2万阅读'), false, '有数据时不算未找到');

// ───────── 3. 时间戳六型 ─────────
// ★冻结时钟（2026-10-14 加规矩）★
//   本文件里所有涉"当前时刻"的断言一律用这个常量，不许再写 Date.now()。
//   事故：gate2 没有收 now 的口子，用例只能把日历日期写死；写就那天 `2026-10-12` ＝1天前（新），
//   隔夜变成 2.04 天（边缘），7 条断言集体翻红——**测试自带保质期**。
//   规矩：函数收 now、测试冻结 now（见 7之二 的回归）。
const NOW = new Date('2026-10-13T15:30:00+08:00').getTime();
const D = 86400000;
eq(lib.parseStamp('46秒前', NOW), NOW - 46000, '秒前');
eq(lib.parseStamp('2分钟前', NOW), NOW - 120000, '分钟前');
eq(new Date(lib.parseStamp('今天11:15', NOW)).getHours(), 11, '今天HH:MM 小时');
eq(new Date(lib.parseStamp('昨天16:00', NOW)).getDate(), 12, '昨天HH:MM 日期');
eq(new Date(lib.parseStamp('3天前', NOW)).getDate(), 10, 'N天前');
eq(new Date(lib.parseStamp('10月12日 10:00', NOW)).getDate(), 12, 'MM月DD日 HH:MM');
// ★跨年修正★：10 月读到"01月21日"，须判为上一年
eq(new Date(lib.parseStamp('01月21日 09:00', NOW)).getFullYear(), 2026, '跨年修正：01月21日→当年（1月21日早于10月，属同年）');
eq(new Date(lib.parseStamp('12月25日 09:00', NOW)).getFullYear(), 2025, '跨年修正：12月25日晚于当下→上一年');
eq(new Date(lib.parseStamp('2026年11月1日', NOW)).getFullYear(), 2026, 'YYYY年MM月DD日');
eq(lib.parseStamp('乱码不是时间', NOW), null, '无法解析→null');

// ───────── 4. 取最新一条（不是平均值） ─────────
const ls = lib.latestStamp(['3天前', '44分钟前', '10月12日 10:00'], NOW);
eq(ls.latest.stamp, '44分钟前', '取最新一条时间戳');
eq(ls.failed, [], '全部解析成功');
const ls2 = lib.latestStamp(['3天前', '看不懂'], NOW);
eq(ls2.latest.stamp, '3天前', '跳过无法解析的');
eq(ls2.failed, ['看不懂'], '失败项被记录（不静默丢弃）');
eq(lib.latestStamp([], NOW).latest, null, '空数组→null');

// ───────── 4之二. ★未来日期护栏★（踩过：法规施行日被当成发帖时间，算出 -18.9 天前） ─────────
const fut = lib.latestStamp(['今天13:45', '2026年11月1日', '1小时前'], NOW);
eq(fut.latest.stamp, '1小时前', '未来日期被排除，取真正最新的发帖');
eq(fut.future, ['2026年11月1日'], '未来日期被单独记录（可追溯）');
ok(fut.latest.ageDays >= 0, '时效天数不为负（曾经是 -18.9）');
eq(lib.latestStamp(['2026年11月1日'], NOW).latest, null, '全是未来日期→无有效时间戳');

// ───────── 4之三. ★时间戳两档★（带时刻＝发文格式；裸日期只兜底） ─────────
const mixed = lib.extractStamps('某法规2026年11月1日施行 网友今天14:06发帖 另有人10月12日 10:00评论');
eq(mixed.tier, 'main', '有发文格式时用 A 档');
ok(!mixed.stamps.includes('2026年11月1日'), 'A 档不含法规施行日');
ok(mixed.stamps.includes('今天14:06'), 'A 档含带时刻的发文格式');
const onlyBare = lib.extractStamps('本页仅有 10月12日 和 2026年10月5日 两个日期');
eq(onlyBare.tier, 'fallback', '无发文格式时退回 B 档');
eq(onlyBare.stamps.length, 2, 'B 档兜底仍能取到裸日期');
eq(lib.extractStamps('本文没有任何日期').tier, 'none', '无日期→none');

// ───────── 5. 时间窗口分级 ─────────
eq(lib.gradeAge(0.5), 'new', '半天→新');
eq(lib.gradeAge(2), 'new', '2天→新');
eq(lib.gradeAge(2.1), 'edge', '2.1天→边缘');
eq(lib.gradeAge(14), 'edge', '14天→边缘');
eq(lib.gradeAge(14.1), 'old', '14.1天→旧');
eq(lib.gradeAge(null), 'unknown', 'null→未知');

// ───────── 6. 闸门 3 ─────────
eq(lib.gate3(4).level, 'dead', '讨论量4→个位数');
eq(lib.gate3(4).ok, false, '个位数→不可写');
eq(lib.gate3(9).level, 'dead', '讨论量9→个位数');
eq(lib.gate3(10).level, 'thin', '讨论量10→偏薄（边界）');
eq(lib.gate3(999).level, 'thin', '讨论量999→偏薄');
eq(lib.gate3(1000).level, 'enough', '讨论量1000→够量（边界）');
eq(lib.gate3(6546).level, 'enough', '讨论量6546→够量');
eq(lib.gate3(null).level, 'nodata', '无讨论量→nodata');

// ───────── 7. 闸门 2 × 3 合成（四种时效组合） ─────────
const g2 = (matter, talk) => lib.gate2({ matterDate: matter, discussAgeDays: talk }, NOW);
// 旧＋旧 → 旧闻新炒 pass
eq(lib.combine(g2('2026-04-22', 22), lib.gate3(658)).result, 'pass', '旧闻新炒→pass');
// 新＋旧 → 网民没反应 pass
eq(lib.combine(g2('2026-10-13', 33), lib.gate3(696)).result, 'pass', '网民没反应→pass');
// 旧＋新 → 旧案翻红 可写
eq(lib.combine(g2('2026-04-22', 0.5), lib.gate3(6516)).result, 'write', '旧案翻红→可写（勿误杀）');
// 新＋新 → 看议论量
eq(lib.combine(g2('2026-10-12', 0.2), lib.gate3(6516)).result, 'write', '新＋新＋够量→可写');
eq(lib.combine(g2('2026-10-12', 0.2), lib.gate3(219)).result, 'write_thin', '新＋新＋偏薄→可写报薄');
eq(lib.combine(g2('2026-10-12', 0.2), lib.gate3(4)).result, 'pass', '个位数→pass');
// 议论旧一律否决
eq(lib.combine(g2('2026-10-12', 20), lib.gate3(9999)).result, 'pass', '议论旧→否决（即使讨论量够）');

// ───────── 7之二. ★时钟必须可注入（2026-10-14 腐坏事故的回归）★ ─────────
//   事故：gate2 内部直接取 Date.now()，judgeItem 收了 now 却没往下传。
//   于是用例里写死的 matterDate 会随日历变老：'2026-10-12' 在写就那天＝1天前（新），
//   隔夜＝2.04 天（边缘）， 7 条断言集体翻红。**不是规则错，是时钟没冻住。**
//   下面这几条就是守门人：谁把 now 这根线再剪断，这里立刻红。
const LATER = NOW + 5 * D;   // 同一份数据，晚 5 天再判
const clockC = { name: '时钟回归', matterDate: '2026-10-12', link: 'https://s.weibo.com/weibo?q=%23x%23' };
const clockD = { topicLib: { discuss: 6516, read: 24984000 }, libMiss: false, stamps: ['1小时前'] };
eq(lib.gate2({ matterDate: '2026-10-12', discussAgeDays: 0.2 }, NOW).matter, 'new', 'gate2 收 now：按快照时刻算→新');
eq(lib.gate2({ matterDate: '2026-10-12', discussAgeDays: 0.2 }, LATER).matter, 'edge', 'gate2 收 now：晚 5 天算→边缘（同数据，结论随时钟走）');
eq(lib.judgeItem(clockC, clockD, NOW).result, 'write', '★judgeItem 把 now 传给 gate2（剪断这根线此条即红）★');
eq(lib.judgeItem(clockC, clockD, LATER).result, 'watch', '★同一份数据晚 5 天判→待观察（时钟确实生效）★');
eq(Math.round(lib.gate2({ matterDate: '2026-10-12', discussAgeDays: 0.2 }, LATER).matterAgeDays), 6, 'matterAgeDays 也按传入时钟算');

// ───────── 8. 榜单词条型替代判据 ─────────
eq(lib.altCriteria({ hotValue: 2290000, rank: 1, freshRatio: 0.93 }).level, 'enough', '人社部：3项命中→充分');
eq(lib.altCriteria({ hotValue: 565000, rank: 9, freshRatio: 0.93 }).level, 'enough', '某茶饮品牌促销成本争议：热度不够但位次+密度→充分');
eq(lib.altCriteria({ hotValue: null, rank: null, freshRatio: 0.36 }).level, 'insufficient', '某养老陪伴服务议题：不在榜→不足');
// ★开发记录第六之二节的原判定是"议论不足"，此处钉住这个期望★
eq(lib.altCriteria({ hotValue: 412000, rank: 12, freshRatio: 1.0 }).level, 'insufficient', '税务处罚：仅密度命中→议论不足（另按"博主解读"否决）');

// ───────── 9. 闸门 1-②：来源表审计 ─────────
const goodDoc = [
  '## 来源与核验',
  '| 平台 | 内容 | 来源 |',
  '|---|---|---|',
  '| 微博 | "以后都是外包" | s.weibo.com 网民个人账号原创帖 @Yournewlife |',
  '| 央视 | 10-12 报道 | 央视新闻 |'
].join('\n');
const badDoc = [
  '## 来源与核验',
  '| 平台 | 内容 | 来源 |',
  '|---|---|---|',
  '| 微博 | 话题页讨论 | s.weibo.com/topic 实测 |',
  '| 央视 | 10-12 报道 | 央视新闻 |'
].join('\n');
eq(lib.auditSourceTable(goodDoc).verdict, 'pass', '来源表有网民个人账号→过');
eq(lib.auditSourceTable(badDoc).verdict, 'fail_1_2', '来源表只有官媒/话题页→不合格');
eq(lib.auditSourceTable(badDoc).hasOrg, true, '识别到官媒');
eq(lib.auditSourceTable('').rowCount, 0, '空文档→0行');
eq(lib.auditSourceTable(goodDoc).rowCount, 2, '表头与分隔行被排除');

// ───────── 9之二. 个人账号识别的三种写法 + 必须排除的笼统说法（★全是真实稿件里的原文★） ─────────
const src = (cell, level = '已核') => ['| 稿中表述 | 来源 | 等级 |', '|---|---|---|', `| 某事 | ${cell} | ${level} |`].join('\n');
const passOf = (cell, level) => lib.auditSourceTable(src(cell, level)).verdict === 'pass';

// ① 显式标签
ok(passOf('微博个人账号原创帖，2026-10-12 抓取'), '① 显式标签"个人账号原创帖"');
ok(passOf('微博话题页个人账号原创，过滤机构号后抓取'), '① "个人账号原创"（无"帖"字，曾错杀某生活方式提法争议）');
ok(passOf('微博个人账号，2026-09-29 抓取'), '① "微博个人账号"（某婴幼儿食品疑云写法）');
// ② 本人发帖
ok(passOf('涉事网民本人公开发帖', '单一来源，稿中以"有网民公开投诉"限定'), '② "涉事网民本人公开发帖"（某商超打包费争议写法，曾错杀）');
// ③ 直接列举账号名
ok(passOf('微博网民 某微博账号 2026-09-16（3转10评87赞）'), '③ "微博网民 某微博账号"（某市地铁写法，曾错杀）');
ok(passOf('第一帮帮团2026-09-17；网民“某微博账号”2026-09-21'), '③ "网民“某微博账号”"（全角引号账号名）');
ok(passOf('微博网民 @某微博账号，2026-10-12 抓取'), '③ "网民 @某微博账号"（有偿搭子写法，曾错杀）');
ok(passOf('某微博账号、某微博账号等账号转述'), '③ 账号名列举（某未成年人失学事件写法，曾错杀）');
// ★必须排除：笼统说法不是账号★
eq(passOf('网民转述与媒体报道，多家一致'), false, '✗ "网民转述与媒体报道"→笼统，不算个人账号');
eq(passOf('网民转述家属说法（"上半年体检一切正常"）', '⚠️ 须与报道原文对一次，见下'), false, '✗ "网民转述家属说法"→不算个人账号');
eq(passOf('**网民描述**，非本案当事人作息', '⚠️ 已作为网民说法写入，不当作事实，见下'), false, '✗ "网民描述"→不算个人账号');
eq(passOf('网民转述律师观点', '⚠️ 未见署名，见下'), false, '✗ "网民转述律师观点"→不算个人账号');
// 官媒/机构来源不算个人账号
eq(passOf('大河报 2026-10-10 13:17 报道（话题#单亲妈妈仅退款被刑拘#）'), false, '✗ 大河报报道→不算');
eq(passOf('某上市公司食品安全处罚发展 2026-10-09 晚公告；澎湃新闻、新浪财经等多家一致'), false, '✗ 上市公司公告→不算');
eq(passOf('成都市公安局警情通报；央视新闻、中国日报等转述'), false, '✗ 警方通报→不算');
// 作者自己标了"须核"的不算合格来源
eq(passOf('微博个人账号原创，2026-10-12 抓取', '⚠️ **须核，见下**'), false, '✗ 已标"须核"→不算合格来源');

// ───────── 10. judgeItem 端到端（用已知答案的历史选题） ─────────
const mk = (name, extra = {}) => ({ name, ...extra });
const j = (c, d) => lib.judgeItem(c, d, NOW);

// 某连锁药店旧闻新炒：事情旧4月、议论22天前、658/325.4万 → pass
eq(j(mk('某连锁药店旧闻新炒', { matterDate: '2026-04-22', link: 'https://s.weibo.com/weibo?q=%23x%23' }),
  { topicLib: { discuss: 658, read: 3254000 }, libMiss: false, stamps: ['22天前'] }).result, 'pass', '某连锁药店旧闻新炒→pass');
// 某养老陪伴服务议题：事情新、议论33天前 → pass
eq(j(mk('某养老陪伴服务议题', { matterDate: '2026-10-13', link: 'https://s.weibo.com/weibo?q=%23x%23' }),
  { topicLib: { discuss: 696, read: 3277000 }, libMiss: false, stamps: ['33天前'] }).result, 'pass', '某养老陪伴服务议题→pass');
// 单位欠缴社保：事情新、议论新、6516 → 可写
eq(j(mk('单位欠缴社保', { matterDate: '2026-10-12', link: 'https://s.weibo.com/weibo?q=%23x%23' }),
  { topicLib: { discuss: 6516, read: 24984000 }, libMiss: false, stamps: ['46秒前', '今天11:15'] }).result, 'write', '单位欠缴社保→可写');
// 北京警方通报：219 偏薄 → 可写报薄
eq(j(mk('北京警方通报', { matterDate: '2026-10-12', link: 'https://s.weibo.com/weibo?q=%23x%23' }),
  { topicLib: { discuss: 219, read: 9850000 }, libMiss: false, stamps: ['今天09:22'] }).result, 'write_thin', '北京警方通报→可写报薄');
// 榜单词条型：人社部（话题库未找到、热度229万、第1、密度93%）→ 可写
eq(j(mk('某部委参保扩面动作', { matterDate: '2026-10-13', hotValue: 2290000, rank: 1, link: 'https://s.weibo.com/weibo?q=x&t=769' }),
  { topicLib: null, libMiss: true, stamps: ['今天12:12', '今天11:56'], freshRatio: 0.93 }).result, 'write', '人社部（榜单型）→可写');
// 榜单词条型但议论旧 → pass
eq(j(mk('某旧词条', { matterDate: '2026-10-13', hotValue: 2290000, rank: 1, link: 'https://s.weibo.com/weibo?q=x&t=769' }),
  { topicLib: null, libMiss: true, stamps: ['30天前'], freshRatio: 0 }).result, 'pass', '榜单型但议论旧→pass');
// 什么都没取到 → need_data（不猜）
eq(j(mk('谜之词条', { link: 'https://s.weibo.com/weibo?q=x' }),
  { topicLib: null, libMiss: true, stamps: [], freshRatio: null, errors: ['入口甲异常'] }).result, 'need_data', '全无数据→need_data（不猜）');

// ───────── 10之二. ★"查不到"的三种情况必须分清★（各有各的坑） ─────────
const link = 'https://s.weibo.com/weibo?q=x&t=769';
// ① 真·词条名对不上（页面明确"未找到"）
eq(j(mk('某养老陪伴服务议题养老陪伴服务', { matterDate: '2026-10-13', link }),
  { topicLib: null, libMiss: true, nameNotFound: true, stamps: [], freshRatio: null }).result,
  'unknown_topic', '① 页面说"未找到"→unknown_topic（不报成"议论不足"）');
// ② 取数异常（无"未找到"字样、无时间戳）→ 不敢判
eq(j(mk('某条取数异常', { matterDate: '2026-10-09', link }),
  { topicLib: null, libMiss: true, topicLibMissExplicit: true, stamps: [], freshRatio: null }).result,
  'need_data', '② 无"未找到"字样且无时间戳→need_data（疑限流，不当成已判定）');
// ③ ★回归：替代判据已算出结论时，"词条名对不上"不得覆盖它★
//    实测踩过：'女方回应被男方要求返还2万彩礼' 算出"议论偏薄"后被覆盖成"未判定"
const overwrite = j(mk('女方回应被男方要求返还2万彩礼', { matterDate: '2026-10-13', hotValue: 1300000, rank: 3, link }),
  { topicLib: null, libMiss: true, nameNotFound: true, stamps: [], freshRatio: null });
eq(overwrite.result, 'write_thin', '③ 替代判据结论不被 unknown_topic 覆盖（曾丢失已算出的结论）');
// ④ 有话题库数据时，nameNotFound 标记不该影响判定（真实误抓也要防）
eq(j(mk('有数据的条', { matterDate: '2026-10-12', link }),
  { topicLib: { discuss: 6516, read: 24984000 }, libMiss: false, nameNotFound: true, stamps: ['今天11:15'], freshRatio: 1 }).result,
  'write', '④ 有数据时不受 nameNotFound 影响');

// ───────── 11. ★闸门 3-②：发帖人构成（2026-10-13 新增）★ ─────────
// 判据来源："某社保税务处罚口径"新鲜帖 100%，但发帖主体是财经博主解读——密度判据放它过关。
const T = lib.PERSON_TYPE;
// 页面标识 → 类型（三种标识的真实取值都来自实测 DOM）
eq(lib.classifyAuthor({ svgClasses: ['woo-icon-main', 'woo-icon--vblue', 'woo-icon-skin'] }), T.ORG, '蓝V→机构（某微博账号那种）');
eq(lib.classifyAuthor({ svgClasses: ['woo-icon-main', 'woo-icon--vyellow', 'woo-icon-skin'] }), T.YELLOW, '黄V→个人认证');
eq(lib.classifyAuthor({ vipIcon: 'https://h5.sinaimg.cn/upload/108/1866/2022/11/02/svvip_4.png' }), T.MEMBER, 'svvip_4→会员');
eq(lib.classifyAuthor({ vipIcon: 'https://h5.sinaimg.cn/upload/108/1866/2022/11/02/vip_7.png' }), T.MEMBER, 'vip_7→会员');
eq(lib.classifyAuthor({ vipIcon: 'https://h5.sinaimg.cn/upload/108/1866/2022/11/02/svip_1.png' }), T.MEMBER, 'svip_1→会员');
eq(lib.classifyAuthor({}), T.PLAIN, '什么都没有→普通用户');
// 蓝V优先于会员图标（有人两个都有）
eq(lib.classifyAuthor({ vipIcon: 'svvip_4.png', svgClasses: ['woo-icon--vblue'] }), T.ORG, '蓝V优先于会员标识');

// 构成统计：24h 新帖里普通用户占比
const posts = (spec) => spec.map(([type, ageHours]) => ({ type, ageHours }));
const mixEnough = lib.authorMix(posts([[T.PLAIN, 1], [T.PLAIN, 2], [T.MEMBER, 3], [T.ORG, 4], [T.PLAIN, 5], [T.YELLOW, 6]]));
eq(mixEnough.freshCount, 6, '24h 新帖计数');
eq(mixEnough.level, 'pass', '普通用户 4/6=67% ≥30% → 过');
const mixDominated = lib.authorMix(posts([[T.YELLOW, 1], [T.YELLOW, 2], [T.ORG, 3], [T.MEMBER, 4], [T.YELLOW, 5], [T.ORG, 6]]));
eq(mixDominated.level, 'dominated', '普通用户 1/6=17% <30% → 达人/机构主导');
eq(mixDominated.ok, false, '主导→不可写');
// 旧帖不计入新帖样本
const mixOld = lib.authorMix(posts([[T.ORG, 30], [T.ORG, 40], [T.PLAIN, 1], [T.PLAIN, 2], [T.PLAIN, 3], [T.PLAIN, 4]]));
eq(mixOld.freshCount, 4, '>24h 的帖不计入新帖');
// 样本太小不下结论（宁可不说，也不乱说）
const mixTiny = lib.authorMix(posts([[T.YELLOW, 1], [T.YELLOW, 2], [T.YELLOW, 3]]));
eq(mixTiny.level, 'thin_sample', '新帖<5 条→样本太小，不作为判据');
eq(mixTiny.ok, null, '样本太小→ok 为 null（不下结论）');
eq(lib.authorMix([]).level, 'nodata', '空样本→nodata');
// ★"24h 内一条新帖都没有" ≠ "取不到数据"★（前者是强信号，必须显式报出来）
const mixStale = lib.authorMix(posts([[T.ORG, 30], [T.ORG, 40], [T.ORG, 50], [T.MEMBER, 60], [T.ORG, 70], [T.PLAIN, 80]]));
eq(mixStale.level, 'no_fresh', '有样本但 24h 内零新帖→no_fresh（不是 nodata）');
eq(mixStale.ok, false, '24h 零新帖→不可写');
ok(/一条新帖都没有/.test(mixStale.note), 'no_fresh 的说明写明"一条新帖都没有"');
// 对照：真的没抽样（total=0）才是 nodata
eq(lib.authorMix([]).level, 'nodata', '对照：无样本→nodata');

// ★收口：判到"可写"但主体是达人号 → 降级为 pass★（这就是 B 要堵的漏）
const dominated = j(mk('某社保税务处罚口径', { matterDate: '2026-10-12', link: 'https://s.weibo.com/weibo?q=%23x%23' }),
  { topicLib: { discuss: 5000, read: 30000000 }, libMiss: false, stamps: ['1小时前', '今天11:15'], freshRatio: 1, posts: posts([[T.YELLOW, 1], [T.YELLOW, 2], [T.ORG, 3], [T.YELLOW, 4], [T.MEMBER, 5], [T.YELLOW, 6]]) });
eq(dominated.result, 'pass', '★量足时效新但主体是财经博主→否决（B 的核心用例）★');
ok(/发帖人构成/.test(dominated.reason), '理由里写明是发帖人构成卡的');
// 对照：24h 零新帖也应降级，且理由措辞不能是"主体不是普通用户"
const noFresh = j(mk('存量媒体帖', { matterDate: '2026-10-07', link: 'https://s.weibo.com/weibo?q=%23x%23' }),
  { topicLib: { discuss: 708, read: 1588000 }, libMiss: false, stamps: ['10月08日 14:00'], freshRatio: 0, posts: posts([[T.ORG, 30], [T.ORG, 40], [T.ORG, 50], [T.MEMBER, 60], [T.ORG, 70], [T.ORG, 80]]) });
eq(noFresh.result, 'pass', '24h 零新帖→也降级');
ok(/近期没有网民议论/.test(noFresh.reason), '零新帖的措辞是"近期没有网民议论"（不是"主体不是普通用户"）');
// 对照：同样数据但主体是普通用户 → 可写
const ordinary = j(mk('某社保税务处罚口径', { matterDate: '2026-10-12', link: 'https://s.weibo.com/weibo?q=%23x%23' }),
  { topicLib: { discuss: 5000, read: 30000000 }, libMiss: false, stamps: ['1小时前', '今天11:15'], freshRatio: 1, posts: posts([[T.PLAIN, 1], [T.MEMBER, 2], [T.PLAIN, 3], [T.ORG, 4], [T.PLAIN, 5], [T.PLAIN, 6]]) });
eq(ordinary.result, 'write', '对照：主体是普通用户→可写');
// 没有 posts 数据（旧数据）不应影响原有判定
eq(j(mk('缺抽样数据', { matterDate: '2026-10-12', link: 'https://s.weibo.com/weibo?q=%23x%23' }),
  { topicLib: { discuss: 6516, read: 24984000 }, libMiss: false, stamps: ['今天11:15'] }).result, 'write', '无 posts 数据时闸门3-②不介入（向后兼容）');

// ───────── 12. ★冻结数据通道（历史复核用）★ ─────────
// 历史复核时"当时的时效"来自文献记录，不是今天能抓的。用 d.discussAgeDays 直接给天数。
// ★个位数讨论量必须最先判掉★（某商超打包费争议 讨论量4 就是这么判的）
eq(j(mk('某商超打包费争议', { matterDate: '2026-09-10', link }),
  { topicLib: { discuss: 4, read: 4332 }, libMiss: false, discussAgeDays: 999, frozen: true }).result,
  'pass', '★冻结：讨论量4→pass（个位数，不论时效）★');
ok(/个位数/.test(j(mk('某商超打包费争议', { matterDate: '2026-09-10', link }),
  { topicLib: { discuss: 4, read: 4332 }, libMiss: false, discussAgeDays: 999 }).reason), '理由写明"个位数"');
// 个位数 + 时效新 → 仍然 pass（顺序正确性）
eq(j(mk('个位数但新', { matterDate: '2026-10-12', link }),
  { topicLib: { discuss: 4, read: 5000 }, libMiss: false, discussAgeDays: 0 }).result,
  'pass', '★个位数即使时效新也 pass（规则顺序）★');
// 冻结：某连锁药店旧闻新炒——讨论量 658（偏薄）但议论 22 天前 → 时效否决
const laobaixing = j(mk('某连锁药店旧闻新炒', { matterDate: '2026-04-22', link }),
  { topicLib: { discuss: 658, read: 3254000 }, libMiss: false, discussAgeDays: 21, discussStampNote: '11条帖子10条是4月22—24日、1条9月22日、今天0条' });
eq(laobaixing.result, 'pass', '★冻结：某连锁药店旧闻新炒→pass（时效）★');
ok(/议论时效否决/.test(laobaixing.reason), '理由是议论时效否决');
eq(laobaixing.frozen, true, '标记为冻结数据');
ok(/今天0条/.test(laobaixing.latestStamp), '冻结备注被保留（可溯源）');
// 冻结：某养老陪伴服务议题真名——讨论量 696 偏薄、议论 32 天前 → 时效否决
eq(j(mk('某养老陪伴服务议题', { matterDate: '2026-10-13', link }),
  { topicLib: { discuss: 696, read: 3277000 }, libMiss: false, discussAgeDays: 32.1 }).result,
  'pass', '★冻结：某养老陪伴服务议题→pass（议论 32.1 天前）★');
// 冻结：官媒主导型（某跨境电诈议题）——量够、时效成立，但闸门 1-① 管辖，判定器**不该拦**
// 注：事情日 10-05 距今天 8 天 → 边缘 → watch（正确）。若按"当时视角"（10-08 写稿日）则是新。
// 这正是冻结复核的固有难点：事情时效永远是相对"今天"算的，历史条目天然偏旧。
ok(['watch', 'write', 'write_thin'].includes(j(mk('某跨境电诈议题', { matterDate: '2026-10-05', link }),
  { topicLib: { discuss: 5733, read: 15204000 }, libMiss: false, discussAgeDays: 0.5 }).result),
  '★某跨境电诈议题：闸门2/3 不否决它（其问题属闸门1-①，不在判定器管辖）★');

// ★第二条线：普通用户 ≥30% 但达人/机构 ≥50% → 仍算主导★
//   实测来源："某婚宴纠纷"——24h 新帖 13 条里蓝V 7 条、普通用户 0 条，
//   但"月费会员"被计入普通用户后占比硬撑到 46%，单看一条线会放过它。
const mixedLead = lib.authorMix(posts([
  [T.ORG, 1], [T.ORG, 2], [T.ORG, 3], [T.ORG, 4],
  [T.MEMBER, 5], [T.MEMBER, 6], [T.MEMBER, 7], [T.MEMBER, 8], [T.MEMBER, 9], [T.MEMBER, 10]
]));
eq(mixedLead.ordinaryRatioInFresh, 0.6, '普通+会员占比 60%（过第一条线）');
eq(mixedLead.level, 'pass', '对照：达人/机构仅 40% <50% → 不算主导，pass');
// 校准：真正的"机构主导"样本
const orgLead = lib.authorMix(posts([
  [T.ORG, 1], [T.ORG, 2], [T.ORG, 3], [T.ORG, 4], [T.ORG, 5], [T.ORG, 6], [T.ORG, 7],
  [T.MEMBER, 8], [T.MEMBER, 9], [T.MEMBER, 10], [T.MEMBER, 11], [T.MEMBER, 12], [T.MEMBER, 13]
]));
eq(Math.round(orgLead.ordinaryRatioInFresh * 100) / 100, 0.46, '普通+会员 46%（≥30%，过第一条线）');
eq(orgLead.level, 'dominated', '★但蓝V 7/13=54% ≥50% → 判主导（第二条线拦住）★');
ok(/达人\/机构占/.test(orgLead.note), '理由里写明"达人/机构占"');
// 对照：机构占比不高、普通用户足够 → pass
const healthyMix = lib.authorMix(posts([
  [T.PLAIN, 1], [T.PLAIN, 2], [T.PLAIN, 3], [T.PLAIN, 4], [T.PLAIN, 5],
  [T.MEMBER, 6], [T.MEMBER, 7], [T.ORG, 8], [T.ORG, 9], [T.YELLOW, 10]
]));
eq(healthyMix.level, 'pass', '普通 70%、机构 30% → pass');

// ───────── 13. ★榜面粗筛（取数之前跑）★ ─────────
const mk2 = (name, rank, hot) => ({ name, rank, hotValue: hot });
// 位次前 20 直通
const pf1 = lib.prefilter([mk2('甲事件', 3, 100000), mk2('乙事件', 25, 90000)], { keepRank: 20 });
eq(pf1.kept.map(x => x.name), ['甲事件', '乙事件'], '20 位以内直通；25 位那条自成一族→保留');
// 同族去重：20 位外只留热度最高
// 注：1/18/19 都在 20 位内 → 全留；第 40 位是 20 位外唯一一条 → 也留，故 4 条全保留
const pf2 = lib.prefilter([
  mk2('某吃播博主健康事件', 1, 1353539),
  mk2('某吃播博主健康事件', 18, 225696),
  mk2('某吃播博主健康事件', 19, 213702),
  mk2('某吃播博主健康事件', 40, 74937)
], { keepRank: 20 });
eq(pf2.kept.length, 4, '吃播族：20 位内 3 条全留 + 20 位外唯一 1 条 → 4 条（去重无从下手）');
// ★真正验证"20 位外只留一条"：让同族有 3 条都在 20 位外★
const pfDedup = lib.prefilter([
  mk2('某吃播博主健康事件', 25, 225696),
  mk2('某吃播博主健康事件', 30, 213702),
  mk2('某吃播博主健康事件', 40, 74937)
], { keepRank: 20 });
eq(pfDedup.kept.length, 1, '★同族 3 条全在 20 位外 → 只留 1 条★');
eq(pfDedup.kept[0].rank, 25, '留的是热度最高的第 25 位');
eq(pfDedup.dropped.length, 2, '另外两条被砍');
ok(pfDedup.dropped.every(d => /同族/.test(d.reason)), '被砍的都写明"同族"');
// ★回归：同族不能被"前 N 位直通"拆开★
//   踩过：先直通前 N、只把剩下的拿去分组 → 某车型制动争议族被拆成两族，第 31 位独自留下、去重白做
const pfSplit = lib.prefilter([
  mk2('某车型制动争议', 16, 259990),
  mk2('某车型制动争议', 31, 123565),
  mk2('某车型制动争议', 34, 97749)
], { keepRank: 20 });
eq(pfSplit.kept.length, 2, '★同族：16 位保留 + 20 位外留热度最高 1 条 = 2（曾被拆成 3）★');
ok(pfSplit.dropped.length === 1 && pfSplit.dropped[0].item.rank === 34,
  '同族里 20 位以外热度较低的（第 34 位）被砍，留第 31 位');
// ★型号 token 是强信号★：型号含数字，纯中文分词会滤掉它，导致同族被拆
// ★样本一律用中性字符串，不用真实选题名★
//   踩过：样本写了真实词条名，脱敏时整条被替换成代号、型号 token 一起消失，
//   于是"期望抠出 V800"落空——**测试在公开包里挂掉**。规则测试不该依赖会被脱敏的素材。
ok(lib.sameTopicFamily('某型号X200的检测结果', '某型号X200的质疑报道'), '同族：共享型号 token X200');
eq([...lib.modelTokens('某型号X200的检测结果')], ['X200'], 'modelTokens 抠出型号 token');
eq([...lib.modelTokens('某AI视频话题')], [], '★「AI」太泛，不算型号 token（要求含数字或 ≥3 字母）★');
eq([...lib.modelTokens('某事件持续10天终被处置')], ['10'], 'modelTokens 抠出数字串（≥2 位）');
eq([...lib.modelTokens('GB17761电动自行车')], ['GB17761'], 'modelTokens 抠出含数字长串');
// ★回归：巧合重叠不能算同族★
//   踩过：只要求 1 个两字重叠时，两个碰巧都含「男子」的无关议题会被并成一族
eq(lib.sameTopicFamily('某犯罪集团案一审宣判', '某店铺消费规则调整'), false, '无关议题 → 不算同族');
ok(lib.sameTopicFamily('某型号X200的踏板检测结果', '某型号X200的媒体质疑'), '真同族 → 算族');
ok(lib.sameTopicFamily('某博主健康事件后续通报', '某博主健康事件家属发声'), '真同族：共享多处中文重叠');
// 无位次/无热度值 → 不砍
const pf3 = lib.prefilter([mk2('无位次条目', undefined, 50000), { name: '无热度条目', rank: 45 }], { keepRank: 20 });
eq(pf3.kept.length, 2, '无位次／无热度值一律直通，不擅自砍');
// 位次越界但自成一族 → 保留（宁多留不误砍）
const pf4 = lib.prefilter([mk2('某个独立冷话题', 45, 67771)], { keepRank: 20 });
eq(pf4.kept.map(x => x.name), ['某个独立冷话题'], '冷门但无同族→保留');
eq(lib.sameTopicFamily('', '随便什么'), false, '空串不同族');
eq(pf2.kept[0].name, '某吃播博主健康事件', '保留项按位次排序');

// ───────── 汇总 ─────────
console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败明细：');
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('全部通过。');
