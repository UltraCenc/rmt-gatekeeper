'use strict';
/**
 * lib.cjs —— 纯逻辑层（无网络、无 IO、可单独测试）
 *
 * 职责：
 *   1. 数字解析（讨论量/阅读量/热度值）
 *   2. 时间戳六型解析（含跨年回退）
 *   3. 时间窗口分级（≤2天 新｜3–14天 边缘｜>14天 旧）
 *   4. 闸门 2 / 3 / 1 的判定规则合成
 *   5. 闸门 1-②：从成稿的"来源与核验"表里检"有没有网民个人账号原创帖"
 *
 * 规则来源：docs/01-判据-选题判定标准.md、docs/03-开发记录-v4.md
 * 设计原则：判定结论必须能溯源——每个结论都带 gate / 依据 / 数据出处
 */

// ────────────────────────────── 常量（改这里就能改阈值） ──────────────────────────────

const THRESHOLD = {
  DISCUSS_DEAD: 10,          // 讨论量 < 10 → 个位数，写出来即失真
  DISCUSS_THIN: 1000,        // 10–999 → 偏薄；≥1000 → 够量
  NEW_DAYS: 2,               // 事情/议论 ≤2 天 → 新
  EDGE_DAYS: 14,             // 3–14 天 → 边缘；>14 天 → 旧（旧闻新炒 / 时效否决）
  HOT_VALUE: 1_000_000,      // 榜单词条型：热度值 ≥100万
  HOT_RANK: 10,              // 榜单词条型：位次前 10
  FRESH_RATIO: 0.3,          // 榜单词条型：24h 内新帖占比 ≥30%
  FRESH_SAMPLE: 15,          // 帖子密度抽样条数
  ORDINARY_RATIO: 0.3,       // ★闸门 3-②★：24h 新帖里普通用户（含月费会员）占比须 ≥30%
  ORG_DOMINANCE: 0.5         // ★闸门 3-② 第二条线★：达人/机构（蓝V＋黄V）占比 ≥50% 即算主导
};

const DAY = 86400000;

/**
 * ★发文时间戳两档★（踩过：正则越宽，误抓越多）
 *   A 档 发文格式（必须带时刻）：30秒前／5分钟前／2小时前／今天14:06／昨天16:00／3天前／10月12日 10:00
 *   B 档 兜底（裸月日／年月日）：仅当 A 档一条都没有时才用
 * 为什么必须分档：搜索页正文里会出现"**2026年11月1日**施行"这类**法规施行日**，
 * 它不是发帖时间。曾把它抓成"最新帖"，算出 **-18.9 天前**（负数）还被当成"新"放行。
 * 带时刻的才是发文格式，裸日期一律降级兜底。
 */
const RE_STAMP_MAIN = /(\d+秒前|\d+分钟前|\d+小时前|今天\s*\d{1,2}:\d{2}|昨天\s*\d{1,2}:\d{2}|\d+天前|\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2})/g;
const RE_STAMP_FALLBACK = /(\d{4}年\d{1,2}月\d{1,2}日|\d{1,2}月\d{1,2}日)/g;

// ────────────────────────────── 1. 数字解析 ──────────────────────────────

/**
 * "2518.3万" → 25183000 ｜ "6546" → 6546 ｜ "1.2亿" → 120000000
 * 解析不出来返回 null（★绝不猜：宁可留空也不填 0★）
 */
function parseNum(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim().replace(/,/g, '');
  if (!s) return null;
  const m = s.match(/^([\d.]+)\s*(万|亿)?$/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (!isFinite(v)) return null;
  const mult = m[2] === '亿' ? 1e8 : m[2] === '万' ? 1e4 : 1;
  return Math.round(v * mult);
}

/** 千分位／中文可读：6546 → "6546"；25183000 → "2518.3万" */
function fmtNum(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1e8) return (n / 1e8).toFixed(2).replace(/\.?0+$/, '') + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
  return String(n);
}

// ────────────────────────────── 2. 取数正则（★两个入口格式不同，不可混用★） ──────────────────────────────

/** 入口甲（话题库 s.weibo.com/topic?q=）：「6546讨论 2518.3万阅读」——讨论在前 */
const RE_TOPIC_LIB = /([\d.]+万?)\s*讨论\s*([\d.]+万?)\s*阅读/;
/** 入口乙（搜索页）：「阅读量1405.1万 讨论量830」——阅读在前，且带"量"字 */
const RE_SEARCH = /阅读量\s*([\d.]+万?)\s*讨论量\s*([\d.]+万?)/;

/** 从话题库文本里取 { discuss, read }；取不到返回 null */
function extractTopicLib(text) {
  const m = String(text).match(RE_TOPIC_LIB);
  if (!m) return null;
  return { discuss: parseNum(m[1]), read: parseNum(m[2]), raw: m[0] };
}

/** 从搜索页文本里取 { discuss, read }；取不到返回 null */
function extractSearchPage(text) {
  const m = String(text).match(RE_SEARCH);
  if (!m) return null;
  return { read: parseNum(m[1]), discuss: parseNum(m[2]), raw: m[0] };
}

/** 话题库返回"未找到" */
function isTopicLibMiss(text) {
  return /未找到|没有找到|暂无|无相关结果/.test(String(text).slice(0, 1500));
}

/**
 * 从任意文本里捞出全部时间戳
 * 分两档并去重：A 档（发文格式）有货就只用 A 档；一条都没有才退回 B 档（裸日期）。
 * 返回 { stamps, tier: 'main'|'fallback'|'none' }
 */
function extractStamps(text) {
  const s = String(text);
  const grab = (re) => {
    const found = s.match(re) || [];
    const seen = new Set();
    const out = [];
    for (const x of found) {
      const key = x.replace(/\s+/g, '');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(x.trim());
    }
    return out;
  };
  const main = grab(RE_STAMP_MAIN);
  if (main.length) return { stamps: main, tier: 'main' };
  const fb = grab(RE_STAMP_FALLBACK);
  return { stamps: fb, tier: fb.length ? 'fallback' : 'none' };
}

// ────────────────────────────── 3. 时间戳解析 ──────────────────────────────

/**
 * 六型时间戳 → 毫秒时间戳；解析不出返回 null（★记入 parseFail，不静默丢弃★）
 * 跨年修正：「01月21日」在 10 月读到 → 判为上一年
 */
function parseStamp(stamp, now = Date.now()) {
  const t = String(stamp).trim().replace(/\s+/g, ' ');
  let m;
  if ((m = t.match(/^(\d+)秒前$/))) return now - +m[1] * 1000;
  if ((m = t.match(/^(\d+)分钟前$/))) return now - +m[1] * 60000;
  if ((m = t.match(/^(\d+)小时前$/))) return now - +m[1] * 3600000;
  if ((m = t.match(/^今天\s*(\d{1,2}):(\d{2})$/))) {
    const d = new Date(now); d.setHours(+m[1], +m[2], 0, 0); return d.getTime();
  }
  if ((m = t.match(/^昨天\s*(\d{1,2}):(\d{2})$/))) {
    const d = new Date(now); d.setHours(+m[1], +m[2], 0, 0); return d.getTime() - DAY;
  }
  if ((m = t.match(/^(\d+)天前$/))) return now - +m[1] * DAY;
  if ((m = t.match(/^(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})$/))) {
    const d = new Date(now);
    d.setMonth(+m[1] - 1, +m[2]);
    d.setHours(+m[3], +m[4], 0, 0);
    // 跨年：解析结果比现在晚 1 天以上 → 必是上一年
    if (d.getTime() > now + DAY) d.setFullYear(d.getFullYear() - 1);
    return d.getTime();
  }
  if ((m = t.match(/^(\d{1,2})月(\d{1,2})日$/))) {
    const d = new Date(now);
    d.setMonth(+m[1] - 1, +m[2]);
    d.setHours(12, 0, 0, 0);
    if (d.getTime() > now + DAY) d.setFullYear(d.getFullYear() - 1);
    return d.getTime();
  }
  if ((m = t.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/))) {
    const d = new Date(now);
    d.setFullYear(+m[1], +m[2] - 1, +m[3]);
    d.setHours(12, 0, 0, 0);
    return d.getTime();
  }
  return null;
}

/**
 * 这批时间戳里最新的一条 → { latest, failed, count }
 * ★未来日期一律判无效★：发帖时间不可能在未来。解析出未来时间的，
 * 要么是正文里的法规施行日，要么是跨年回退没兜住——都不能当"最新帖"。
 */
function latestStamp(stamps, now = Date.now()) {
  let best = null;
  const failed = [];
  const future = [];
  for (const s of stamps) {
    const ms = parseStamp(s, now);
    if (ms === null) { failed.push(s); continue; }
    if (ms > now + 60000) { future.push(s); continue; }   // 容 1 分钟时钟偏差
    if (!best || ms > best.ms) best = { ms, stamp: s };
  }
  if (!best) return { latest: null, failed, future, count: stamps.length };
  best.ageDays = (now - best.ms) / DAY;
  return { latest: best, failed, future, count: stamps.length };
}

// ────────────────────────────── 4. 时间窗口分级 ──────────────────────────────

/** ≤2天 → new ｜3–14天 → edge ｜>14天 → old */
function gradeAge(ageDays) {
  if (ageDays === null || ageDays === undefined || !isFinite(ageDays)) return 'unknown';
  if (ageDays <= THRESHOLD.NEW_DAYS) return 'new';
  if (ageDays <= THRESHOLD.EDGE_DAYS) return 'edge';
  return 'old';
}

const AGE_LABEL = { new: '新', edge: '边缘', old: '旧', unknown: '未知' };

// ────────────────────────────── 5. 闸门判定 ──────────────────────────────

/** 闸门 3：议论量三级（来自话题库的讨论量） */
function gate3(discuss) {
  if (discuss === null || discuss === undefined) {
    return { gate: 3, level: 'nodata', ok: null, note: '无讨论量可读（榜单词条型／伪词条型）' };
  }
  if (discuss < THRESHOLD.DISCUSS_DEAD) {
    return { gate: 3, level: 'dead', ok: false, note: `讨论量 ${discuss} 为个位数，写出来即失真` };
  }
  if (discuss < THRESHOLD.DISCUSS_THIN) {
    return { gate: 3, level: 'thin', ok: true, note: `讨论量 ${discuss} 偏薄，可写但报告须注明` };
  }
  return { gate: 3, level: 'enough', ok: true, note: `讨论量 ${discuss} 够量` };
}

/**
 * 闸门 2：时效拆两条
 * 事情时效（权威源原始发布日）＋ 议论时效（话题页最新帖）
 *
 * ★now 必须可注入（2026-10-14 事故后加）★
 *   原来这里直接写 Date.now()，后果有两个：
 *   ① 单元测试没法冻结时钟，只能把日历日期写死 → 隔夜从"新"变"边缘"，
 *      test_lib 里 7 条断言集体翻红（测试自带保质期）；
 *   ② judgeItem 收了 now 却传不下来 → 用旧取数文件判题时，"事情时效"
 *      会偷偷按"此刻"算，而不是按取数那一刻算。
 *   规矩：凡涉"当前时刻"的函数一律收 now 参数（latestStamp／judgeItem 早就有，这里补上）。
 *
 * @param {number} now 判定基准时刻（默认实时；★测试与历史复核一律显式传入★）
 */
function gate2({ matterDate, discussAgeDays }, now = Date.now()) {
  const matter = matterDate ? gradeAge((now - new Date(matterDate).getTime()) / DAY) : 'unknown';
  const talk = gradeAge(discussAgeDays);
  return {
    gate: 2,
    matter, talk,
    matterAgeDays: matterDate ? (now - new Date(matterDate).getTime()) / DAY : null,
    talkAgeDays: discussAgeDays,
    note: `事情${AGE_LABEL[matter]} × 议论${AGE_LABEL[talk]}`
  };
}

/** 闸门 2 × 3 合成结论 */
function combine(g2, g3, g1) {
  // 闸门 1 硬否优先（不可能引到真人原话 → 主体不合格）
  if (g1 && g1.ok === false && g1.level === 'no_person') {
    return { result: 'pass', reason: '闸门1-②：成稿引不到真人原话（来源表无网民个人账号原创帖），主体不合格' };
  }
  if (g2.talk === 'old') {
    return { result: 'pass', reason: `闸门2：议论时效否决——最新帖 ${g2.talkAgeDays === null ? '?' : g2.talkAgeDays.toFixed(1)} 天前（>14天）` };
  }
  if (g2.matter === 'old' && g2.talk === 'old') {
    return { result: 'pass', reason: '闸门2：旧闻新炒（事情旧＋议论旧）' };
  }
  if (g2.matter === 'new' && g2.talk === 'old') {
    return { result: 'pass', reason: '闸门2：网民没反应（事情新＋议论旧）' };
  }
  if (g3.level === 'dead') {
    return { result: 'pass', reason: `闸门3：${g3.note}` };
  }
  // 榜单词条型（无讨论量）→ 走替代判据，由调用方传入 alt
  if (g3.level === 'nodata') {
    return { result: 'need_alt', reason: '无讨论量：须用榜单词条型替代判据（热度值／位次／帖子密度）' };
  }
  if (g2.talk === 'unknown' && g2.matter === 'unknown') {
    return { result: 'need_data', reason: '时效两项都取不到，不能下结论' };
  }
  // 旧案翻红：事情旧＋议论新 → 可写
  if (g2.matter === 'old' && g2.talk === 'new') {
    return { result: 'write', reason: '闸门2：旧案翻红（事情旧＋议论新），可写' };
  }
  if (g3.level === 'thin') {
    return { result: 'write_thin', reason: `闸门3：${g3.note}` };
  }
  if (g2.talk === 'edge' || g2.matter === 'edge') {
    return { result: 'watch', reason: `闸门2：时效${AGE_LABEL[g2.talk]}，列候补并写明盯什么信号` };
  }
  return { result: 'write', reason: '闸门2、3 均通过' };
}

/**
 * 榜单词条型替代判据（热度值≥100万／位次前10／帖子密度≥30%）
 * 规则：≥2 项命中 且 密度通过 → 议论充分；≥2 项命中但密度不通过 → 偏薄；其余 → 不足
 */
function altCriteria({ hotValue, rank, freshRatio }) {
  const hits = [];
  if (hotValue !== null && hotValue !== undefined && hotValue >= THRESHOLD.HOT_VALUE) hits.push(`热度值 ${fmtNum(hotValue)}≥100万`);
  if (rank !== null && rank !== undefined && rank <= THRESHOLD.HOT_RANK) hits.push(`位次第 ${rank}≤前10`);
  const densityOk = freshRatio !== null && freshRatio !== undefined && freshRatio >= THRESHOLD.FRESH_RATIO;
  if (densityOk) hits.push(`帖子密度 ${(freshRatio * 100).toFixed(0)}%≥30%`);

  if (hits.length >= 2 && densityOk) {
    return { level: 'enough', hits, note: `替代判据命中 ${hits.length} 项且密度通过 → 议论充分（稿中用"热度值"标注、不写讨论量）` };
  }
  if (hits.length >= 2) {
    return { level: 'thin', hits, note: `替代判据命中 ${hits.length} 项但帖子密度未通过 → 议论偏薄` };
  }
  return { level: 'insufficient', hits, note: `替代判据仅命中 ${hits.length} 项 → 议论不足` };
}

// ────────────────────────────── 6. 闸门 1-②（纯读稿，不联网） ──────────────────────────────

/** 机构号／官媒特征 */
const RE_ORG = /央视|新华社|人民日报|央广|中新|澎湃|新华网|市监总局|市监局|总局官网|官方微博|政务|发布厅|公安|警方|通报|人民法院|法院|检察院|日报|晚报|电视台|融媒体|客户端|公众号|新闻网|新闻中心|官方/;

/**
 * 个人账号特征，★三种写法都要认★：
 *   ① 显式标签：「网民个人账号」「个人账号原创（帖）」
 *   ② 本人发帖：「涉事网民本人公开发帖」
 *   ③ 直接列举：「微博网民 某微博账号」「网民"某微博账号"」「某微博账号」「某微博账号」
 * ③ 必须排除"网民转述/描述/指出"这类动作词——那是笼统说法，不是账号。
 */
const PERSON_EXCLUDE = '转述|描述|指出|反映|说法|认为|议论|观点|意见|评论|爆料|吐槽|投诉|声音|呼吁|建议|质疑|证实|称|说|回应|澄清|预测|分析|解读';
const RE_PERSON_LABEL = /网民个人账号|个人账号原创|个人账号|普通用户|个人用户|本人公开发帖|涉事网民本人/;
/**
 * ★两个坑★：
 *  1. 「网民」后面若写 `\s*`，零宽匹配会让正则退而匹配「民转述与媒体报道」这类正文，
 *     绕过排除表 → 必须用 lookahead 锚定紧跟的账号名，且排除动作词开头。
 *  2. 纯中文账号名列表（「某微博账号、某微博账号等账号转述」）没有「网民」前缀
 *     → 用「账号/博主/用户」尾缀兜底。
 */
const RE_PERSON_HANDLE = new RegExp(
  '网民\\s*["“「]?((?!(?:' + PERSON_EXCLUDE + '))[A-Za-z0-9_\\-\\u4e00-\\u9fa5]{2,20})["”」]?' +
  '|微博\\s*["“「]([A-Za-z0-9_\\-\\u4e00-\\u9fa5]{2,20})["”」]' +
  '|([A-Za-z0-9_\\-\\u4e00-\\u9fa5]{2,20})\\s*(?:等)?\\s*(?:账号|博主|用户)(?:转述|发布|发文|投稿|公开|披露)'
);

/** 从来源单元格里找"个人账号"证据；找不到返回 null */
function findPersonAccount(text) {
  const s = String(text);
  if (RE_PERSON_LABEL.test(s)) {
    const h = s.match(/@[A-Za-z0-9_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5\-]{1,29}/);
    return { via: 'label', handle: h ? h[0] : null };
  }
  const m = s.match(RE_PERSON_HANDLE);
  if (m) {
    // 尾部可能粘上"等/账号"之类（贪婪匹配），清掉再判
    const name = (m[1] || m[2] || m[3] || '').replace(/等$|账号$|博主$|用户$/, '');
    if (name && !new RegExp('^(' + PERSON_EXCLUDE + ')$').test(name)) {
      return { via: 'handle', handle: name };
    }
  }
  const at = s.match(/@[A-Za-z0-9_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5\-]{1,29}/);
  if (at) return { via: 'at', handle: at[0] };
  return null;
}

/** 表头词表：用来定位"来源列"。★各稿小节名不统一（逐句来源／做法部分的来源／时间线／核验状态），
 *  所以不能硬编码小节名，必须通读全文档所有表格、按表头定位。★ */
const HEADER_WORDS = ['来源', '出处', '信源', '渠道'];
const LEVEL_WORDS = ['等级', '可信度', '核验状态'];

/** 表格行 → 单元格数组；不是表格行返回 null */
function tableCells(line) {
  const l = String(line).trim();
  if (!l.startsWith('|')) return null;
  const cells = l.split('|').map(c => c.trim());
  if (cells.length && cells[0] === '') cells.shift();
  if (cells.length && cells[cells.length - 1] === '') cells.pop();
  if (cells.length < 2) return null;
  if (cells.every(c => /^[-: ]*$/.test(c))) return null;   // 分隔行
  return cells;
}

/**
 * 通读一篇稿子的所有表格，判定闸门 1-②
 *
 * ★实现要点（两次踩坑都在这）★：
 *  1. 不要用"猜哪些行算来源行"的准入正则——会把 `| 央视 | … | 央视新闻 |`
 *     （无平台名、恰是最该看的官媒行）整行丢掉。→ 按表头定位"来源列"。
 *  2. 不要硬编码小节名（"来源与核验"）——各稿叫法有五种，
 *     漏掉小节＝整篇一行都读不到。→ 通读全文档所有表格。
 *  3. 判定用"来源列"，不取备注列——备注列里的 @账号名（多为账户识别提示）
 *     不是引用来源，会造出假阳性。
 */
function auditSourceTable(raw, fileName = '') {
  const lines = String(raw).split(/\r?\n/);
  const rows = [];
  let srcCol = -1, lvlCol = -1, tableTarget = -1;

  for (const line of lines) {
    const cells = tableCells(line);
    if (!cells) { if (!String(line).trim().startsWith('|')) { srcCol = -1; lvlCol = -1; tableTarget = -1; } continue; }

    const hasSrcHdr = cells.findIndex(c => HEADER_WORDS.includes(c));
    const looksHeader = hasSrcHdr >= 0 && !/^https?:|^s\.weibo|^\d{4}-/.test(cells.join(''));
    if (looksHeader) {
      srcCol = hasSrcHdr;
      lvlCol = cells.findIndex(c => LEVEL_WORDS.includes(c));
      tableTarget = cells.length;
      continue;
    }
    if (srcCol < 0 || cells.length !== tableTarget) continue;

    const srcCell = (cells[srcCol] || '').trim();
    const judge = cells.join(' ');
    const person = findPersonAccount(srcCell);
    const lvlCell = lvlCol >= 0 ? (cells[lvlCol] || '') : '';
    // 作者自己标了"未落实"的，不算合格来源。
    // ★注意不能把"单一来源"当标志★——「单一来源，稿中以"有网民公开投诉"限定」
    //   是作者主动披露并已在稿中限定，属于合规写法，不是未落实。
    const flagged = /须核|见下|未落实|未见署名|待核|存疑|待查|未获证实/.test(lvlCell);

    rows.push({
      raw: line.trim().slice(0, 120),
      srcCell: srcCell.slice(0, 80),
      lvlCell: lvlCell.slice(0, 40),
      handle: person ? person.handle : null,
      personVia: person ? person.via : null,
      flagged,
      isOrg: RE_ORG.test(judge),
      isPerson: !!person
    });
  }

  // ★只有"来源列自己写了个人账号"且未被作者标为待核的，才算过闸门 1-②★
  const personRows = rows.filter(r => r.isPerson && !r.flagged);
  const hasPerson = personRows.length > 0;
  const hasOrg = rows.some(r => r.isOrg);
  return {
    fileName,
    rowCount: rows.length,
    hasPerson,
    hasOrg,
    personExamples: personRows.slice(0, 3).map(r => r.handle || r.srcCell.slice(0, 26)),
    flaggedCount: rows.filter(r => r.flagged).length,
    rows,
    // ★闸门 1-② 硬性★：至少一条"网民个人账号原创帖"
    verdict: hasPerson ? 'pass' : 'fail_1_2',
    note: hasPerson
      ? `闸门1-②：来源列含网民个人账号（${personRows.slice(0, 3).map(r => r.handle || '个人账号').join('、')}）`
      : '闸门1-②：来源列内无网民个人账号标注 → 主体不合格（论据可能全来自媒体转述）'
  };
}

// ────────────────────────────── 6. 闸门 3-②：发帖人构成 ──────────────────────────────

/**
 * ★闸门 3-②：帖子密度只看时间、不看是谁发的★
 *
 * 为什么必须有这一档（史实）："某社保税务处罚口径"新鲜帖占比 100%，**但发帖主体是财经博主解读**——
 * 密度判据放它过关。新鲜度只回答"最近有人说话吗"，不回答"是谁在说"。
 *
 * 判据：**24 小时内新帖中，普通用户占比 ≥30%**。
 * 低于此线 → 议论由达人号／机构号主导，**不算"网民议论形成"**。
 *
 * 页面标识（2026-10-13 实测）：
 *   头像旁的 img src 含 svvip_N.png / vip_N.png / svip_N.png → 会员（普通用户最常见的形态）
 *   svg class 含 woo-icon--vblue  → 蓝V（机构／媒体／企业）
 *   svg class 含 woo-icon--vyellow → 黄V（个人认证）
 *   都没有 → 普通用户
 */
const PERSON_TYPE = {
  ORG: '机构蓝V',
  YELLOW: '个人黄V',
  MEMBER: '月费会员',
  PLAIN: '普通用户'
};

/** 从一条帖子的页面标识判定发帖人类型 */
function classifyAuthor({ vipIcon = '', svgClasses = [] } = {}) {
  const svg = (svgClasses || []).join(' ');
  if (/vblue/.test(svg)) return PERSON_TYPE.ORG;
  if (/vyellow/.test(svg)) return PERSON_TYPE.YELLOW;
  if (/vip/i.test(vipIcon)) return PERSON_TYPE.MEMBER;   // svvip_N / svip_N / vip_N
  return PERSON_TYPE.PLAIN;
}

/**
 * 统计发帖人构成
 * @param {Array<{type:string, ageHours:number|null}>} posts
 * @returns {{total, byType, freshCount, freshByType, ordinaryRatioInFresh, verdict, note}}
 */
function authorMix(posts = []) {
  const byType = {}, freshByType = {};
  let freshCount = 0;
  for (const p of posts) {
    const t = p.type || PERSON_TYPE.PLAIN;
    byType[t] = (byType[t] || 0) + 1;
    const isFresh = typeof p.ageHours === 'number' && p.ageHours <= 24;
    if (isFresh) {
      freshCount++;
      freshByType[t] = (freshByType[t] || 0) + 1;
    }
  }
  const ordinaryInFresh = (freshByType[PERSON_TYPE.PLAIN] || 0) + (freshByType[PERSON_TYPE.MEMBER] || 0);
  const ratio = freshCount ? ordinaryInFresh / freshCount : null;
  const gate3b = gate3bAuthors({ ratio, freshCount, freshByType, total: posts.length });
  return { total: posts.length, byType, freshCount, freshByType, ordinaryRatioInFresh: ratio, ...gate3b };
}

/** 闸门 3-② 判定：24h 新帖里普通用户（含月费会员）占比 */
function gate3bAuthors({ ratio, freshCount, freshByType = {}, total = 0 }) {
  // ★"24h 内一条新帖都没有"≠"取不到数据"★：前者是强信号（压根没人说话），
  //   后者才是真的没抽到样本。混为一谈会把有力证据藏起来。
  if (total > 0 && freshCount === 0 && (ratio === null || ratio === undefined)) {
    return { gate: '3-②', level: 'no_fresh', ok: false, note: `抽样 ${total} 条帖子里，24h 内一条新帖都没有 → 近期没有议论` };
  }
  if (ratio === null || ratio === undefined) {
    return { gate: '3-②', level: 'nodata', ok: null, note: '未取到发帖人构成（未抽样）' };
  }
  if (total > 0 && freshCount === 0) {
    return { gate: '3-②', level: 'no_fresh', ok: false, note: `抽样 ${total} 条帖子里，24h 内一条新帖都没有 → 近期没有议论` };
  }
  if (freshCount < 5) {
    return { gate: '3-②', level: 'thin_sample', ok: null, note: `24h 新帖仅 ${freshCount} 条，样本太小，作者构成不作为判据` };
  }
  const orgs = (freshByType[PERSON_TYPE.ORG] || 0) + (freshByType[PERSON_TYPE.YELLOW] || 0);
  const ordinary = (freshByType[PERSON_TYPE.PLAIN] || 0) + (freshByType[PERSON_TYPE.MEMBER] || 0);
  const pct = (ratio * 100).toFixed(0);
  const detail = `24h 新帖 ${freshCount} 条中普通用户 ${ordinary} 条（${pct}%）`;
  if (ratio >= THRESHOLD.ORDINARY_RATIO && (orgs / freshCount) < THRESHOLD.ORG_DOMINANCE) {
    return { gate: '3-②', level: 'pass', ok: true, note: `${detail} ≥30%、达人机构占 ${((orgs / freshCount) * 100).toFixed(0)}% <50% → 议论以普通用户为主` };
  }
  // ★两条线任一不过就降级★
  //   单看"普通用户 ≥30%"不够：实测"某婚宴纠纷"里蓝V 7 条、普通用户 0 条，
  //   但"会员"被算成普通用户，占比硬撑到 46%——**机构已在主导，却过线了**。
  const why = ratio < THRESHOLD.ORDINARY_RATIO
    ? `${detail} <30%`
    : `${detail} 虽 ≥30%，但达人/机构占 ${((orgs / freshCount) * 100).toFixed(0)}% ≥50%`;
  return {
    gate: '3-②', level: 'dominated', ok: false,
    note: `${why}（蓝V ${freshByType[PERSON_TYPE.ORG] || 0}／黄V ${freshByType[PERSON_TYPE.YELLOW] || 0}／会员 ${freshByType[PERSON_TYPE.MEMBER] || 0}／普通 ${freshByType[PERSON_TYPE.PLAIN] || 0}）→ 议论由达人号／机构号主导，不算"网民议论形成"`
  };
}

// ────────────────────────────── 8. 榜面粗筛（取数之前跑，省取数的钱） ──────────────────────────────

/**
 * ★榜面粗筛（2026-10-13 用户定）★
 *
 * 为什么要它：原流程是"先花取数的钱，再判该不该写"——50 条候选每条要开两个页面各等 2.6 秒，
 * 换来的大半是注定要否掉的条目。用户原话："效率比之前单纯用 skill 慢很多"。
 *
 * ★关键是选对尺子★。实测 50 条社会榜：
 *   · 热度值**当不了尺子**——该写的条目里 4/5 热度不到 100 万
 *     （教师耻辱合影第 15 位 28.9 万、24岁吃播第 19 位 21.4 万、
 *       京东助浴师第 29 位 14.3 万、70斤吃播父亲发声第 40 位 7.5 万）；
 *   · **位次才是尺子**；且同一事件在榜上常有 2—8 条（"某吃播博主健康事件"6 条、"某车型制动争议"8 条），
 *     **同族只需判一次**。
 *
 * 规则：
 *   1. 位次 ≤ keepRank（默认 20）→ **直通**
 *   2. 位次 > keepRank → 按议题族分组，**每族只留热度最高的那条**
 *   3. 无位次的条目 → 直通（不知道该放哪，不擅自砍）
 *   4. 无热度值的存量条目 → 直通（否则没法在同族里比大小）
 *
 * ★这是"要不要花取数的钱"的取舍，不是判定标准的改动★——被砍的条目照样可以手工加回来。
 */

/** 中文两字集合 */
function cjkBigrams(s) {
  const t = String(s).replace(/[^\u4e00-\u9fa5]/g, '');
  const out = new Set();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 1 + 1));
  return out;
}

/**
 * ★型号／专名 token★：含数字或 ≥3 位字母的拉丁串（如 `V800`、`AI`、`GB17761`）。
 * ★为什么需要它★：这些串在中文分词里会被整段滤掉，导致**同属一个事件的词条被判成不同族**。
 * 实测某车型制动争议族：`某车型制动争议` 与 `某车型制动争议`
 * 只共享「某车型制动争议」一处两字重叠（因为 V800 被滤掉了）→ 按"≥2 处重叠"的门槛会拆族。
 * 而 `V800` 本身是**比任何中文词都强的同族信号**。
 */
function modelTokens(s) {
  const out = new Set();
  for (const m of String(s).match(/[A-Za-z0-9]{2,}/g) || []) {
    if (/[0-9]/.test(m) || m.length >= 3) out.add(m.toUpperCase());
  }
  return out;
}

/**
 * 同族判定：**命中型号 token** 或 **≥minShared 处中文两字重叠**。
 *
 * ★两个门槛的由来（都踩过）★
 *   · 只看"1 处中文重叠" → 巧合误合：「魏家**男子**犯罪集团」被判成与「咖啡店…**男子**」同族。
 *   · 只看"≥2 处中文重叠" → 真族被拆：某车型制动争议族因 V800 被滤掉，多数成员只共享「某车型制动争议」一处。
 *   → 所以拆成"强信号（型号 token）＋ 弱信号（两处中文重叠）"两条，任一命中即同族。
 */
function sameTopicFamily(a, b, minShared = 2) {
  const Ta = modelTokens(a), Tb = modelTokens(b);
  for (const t of Ta) if (Tb.has(t)) return true;
  const A = cjkBigrams(a), B = cjkBigrams(b);
  if (!A.size || !B.size) return false;
  let shared = 0;
  for (const g of A) if (B.has(g)) { shared++; if (shared >= minShared) return true; }
  return false;
}

/**
 * @param {Array} candidates 候选清单
 * @param {object} opts { keepRank: 20, minShared: 2 }
 * @returns {{kept: Array, dropped: Array<{item, reason, family?}>, families: Array}}
 *
 * ★算法顺序（踩过）★：必须**先给全部条目分组、再套"位次≤N 保留"**。
 *   反过来（先直通前 N、只把剩下的拿去分组）会有两个毛病：
 *   ① 同族被拆开——「某车型制动争议」第 4/16/20 位直通了，第 31 位那条于是一个"族人"都找不到，
 *      被当成独立议题留下，去重白做；
 *   ② 族内最优判断失真——比较时看不到前 N 位那些成员。
 */
function prefilter(candidates = [], opts = {}) {
  const keepRank = opts.keepRank ?? 20;
  const minShared = opts.minShared ?? 2;

  // 无位次或无热度值的条目：不知道该放哪，一律直通（不擅自砍）
  const untouched = candidates.filter(c => typeof c.rank !== 'number' || typeof c.hotValue !== 'number');
  const rankable = candidates.filter(c => typeof c.rank === 'number' && typeof c.hotValue === 'number');

  // ① 全部条目按榜上位次顺序分组
  const families = [];
  for (const c of [...rankable].sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))) {
    const fam = families.find(f => sameTopicFamily(f.seed.name, c.name, minShared));
    if (fam) fam.members.push(c);
    else families.push({ seed: c, members: [c], kept: [], best: null });
  }

  // ② 每族：位次 ≤N 的全部保留；其余只留热度最高的一条；再排一次取热度最高的作为"代表"
  const kept = [...untouched];
  const dropped = [];
  for (const f of families) {
    const inTop = f.members.filter(m => m.rank <= keepRank);
    const outTop = f.members.filter(m => m.rank > keepRank);
    let best = null;
    for (const m of outTop) {
      if (!best || (m.hotValue ?? -1) > (best.hotValue ?? -1) ||
        ((m.hotValue ?? -1) === (best.hotValue ?? -1) && m.rank < best.rank)) best = m;
    }
    f.kept = best ? [...inTop, best] : [...inTop];
    f.best = best;
    kept.push(...f.kept);
    for (const m of outTop) {
      if (m !== best) {
        dropped.push({
          item: m,
          reason: `与「${f.seed.name}」同族（该族共 ${f.members.length} 条，位次 ${f.members.map(x => x.rank).join('/')}），`
            + (best ? `本族 20 位以外只留热度最高的「${best.name}」` : '该族 20 位以外无条目'),
          family: f.members.map(x => x.name)
        });
      }
    }
  }

  kept.sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999));
  return { kept, dropped, families };
}

// ────────────────────────────── 9. 汇总一条 ──────────────────────────────

/**
 * 对一条候选做完整判定（纯函数，数据由外部抓好传进来）
 * @param {object} c  候选：{ name, matterDate, hotValue, rank }
 * @param {object} d  抓取数据：{ topicLib: {discuss, read}|null, libMiss, stamps:[], freshRatio, errors:[] }
 * @param {number} now 判定基准时刻（默认实时；★必须一路传给 gate2，见 2026-10-14 事故★）
 */
function judgeItem(c, d, now = Date.now()) {
  const topicLib = d.topicLib || null;
  const disc = topicLib ? topicLib.discuss : null;
  const read = topicLib ? topicLib.read : null;

  const ls = latestStamp(d.stamps || [], now);
  // ★冻结数据通道★：历史复核时，"当时的议论时效"来自文献记录（如"今天0条帖子"），
  //   不是今天能抓到的。这时用 d.discussAgeDays 直接给天数，跳过时间戳解析。
  //   判据出处：手册记"某连锁药店旧闻新炒…11条帖子10条是4月22—24日、1条9月22日、今天0条"。
  const isFrozen = typeof d.discussAgeDays === 'number';
  const talkAgeDays = isFrozen ? d.discussAgeDays : (ls.latest ? ls.latest.ageDays : null);

  const g3 = gate3(disc);
  // ★now 一路传下去★：闸门2 的事情时效要按"判定基准时刻"算，不能各自去取 Date.now()
  const g2 = gate2({ matterDate: c.matterDate, discussAgeDays: talkAgeDays }, now);
  const g1 = { gate: 1, level: d.libMiss ? 'list_only' : 'ok', ok: true, note: '' };
  // ★闸门 3-②：议论的主体是不是普通用户★（密度只看时间，这一档看是谁发的）
  const g3b = (d.posts && d.posts.length) ? authorMix(d.posts) : { gate: '3-②', level: 'nodata', ok: null, note: '未取到发帖人构成（旧数据或未开抽样）' };

  let combo;
  let alt = null;

  // 型别：带 # 的榜单链接＝话题型；不带 # 或话题库未找到＝榜单词条型
  const linkHasHash = /%23|#/.test(c.link || '');
  let kind = linkHasHash ? '话题型' : '榜单词条型';

  // ★★规则顺序（决定判对判错，别乱动）★★
  //   1. 闸门 3 的 dead（个位数）最先——讨论量 4 这种，时效再新也不该写。
  //      冻结数据"某商超打包费争议 讨论量4"就是这么判掉的。
  //   2. 榜单词条型走替代判据。
  //   3. 其余走闸门 2 × 3 合成。
  //   4. 最后用闸门 3-②（发帖人构成）把"可写"降级。
  if (g3.level === 'dead') {
    combo = { result: 'pass', reason: `闸门3：${g3.note}（量级不够，不论时效）` };
  } else if (d.libMiss) {
    kind = '榜单词条型';
    alt = altCriteria({ hotValue: c.hotValue, rank: c.rank, freshRatio: d.freshRatio });
    if (alt.level === 'enough') {
      combo = { result: 'write', reason: `闸门3（替代判据）：${alt.note}` };
    } else if (alt.level === 'thin') {
      combo = { result: 'write_thin', reason: `闸门3（替代判据）：${alt.note}` };
    } else {
      combo = { result: 'pass', reason: `闸门3（替代判据）：${alt.note}` };
    }
    // 时效仍要否决（议论旧则无救）
    if (g2.talk === 'old') {
      combo = { result: 'pass', reason: `闸门2：议论时效否决（最新帖 ${talkAgeDays === null ? '?' : talkAgeDays.toFixed(1)} 天前）` };
    }
    if (talkAgeDays === null && c.matterDate === undefined) {
      combo = { result: 'need_data', reason: '榜单词条型且取不到帖子时间戳与权威源日期，不能下结论' };
    }
    // ★"查不到"的护栏：前提必须是"替代判据本来就不够格"★
    //   若替代判据已经算出 enough/thin，那就是一条合法结论，不许被覆盖。
    //   实测踩过：'女方回应被男方要求返还2万彩礼' 算出"议论偏薄"后被覆盖成"未判定"。
    const altUsable = alt && (alt.level === 'enough' || alt.level === 'thin');
    if (!altUsable && !ls.count && !topicLib && !isFrozen) {
      if (d.nameNotFound) {
        combo = { result: 'unknown_topic', reason: '页面明确提示"未找到"，两个入口都无数据 → 词条名与微博不一致（非"议论不足"），须用榜单原词条名重查' };
      } else if (d.topicLibMissExplicit) {
        combo = { result: 'need_data', reason: '入口甲无数据格式且无"未找到"字样、入口乙也无帖子时间戳 → 疑取数异常（限流／改版），不能当成已判定' };
      }
    }
  } else if (!topicLib) {
    kind = '待定';
    combo = { result: 'need_data', reason: '话题库与搜索页都没取到数据，不能下结论' };
  } else {
    combo = combine(g2, g3, g1);
  }

  // ★闸门 3-② 收口：判到"可写"但"网民议论"不成立 → 降级★
  //   两种情形分开说，别混：
  //   ① 24h 零新帖（level=no_fresh）→ 近期压根没人说话
  //   ② 有 24h 新帖但普通用户占比 <30%（level=dominated）→ 说话的以达人号／机构号为主
  //   判据出处：本文件第六节。史实："某社保税务处罚口径"新鲜帖 100%，但主体是财经博主解读。
  if ((combo.result === 'write' || combo.result === 'write_thin') && g3b.ok === false) {
    const why = g3b.level === 'no_fresh'
      ? `抽样帖子里 24h 内一条新帖都没有——**近期没有网民议论**（页面存量帖是媒体旧帖）`
      : `议论的主体不是普通用户——**引用它做"网民议论"会失真**`;
    combo = { result: 'pass', reason: `闸门3-②（发帖人构成）：${g3b.note}。时效与量都成立，但${why}` };
  }

  return {
    name: c.name,
    kind,
    discuss: disc, read,
    discussFmt: fmtNum(disc),
    readFmt: fmtNum(read),
    matterDate: c.matterDate || null,
    matterGrade: g2.matter,
    talkGrade: g2.talk,
    talkAgeDays,
    latestStamp: isFrozen ? (d.discussStampNote || '（冻结数据）') : (ls.latest ? ls.latest.stamp : null),
    stampCount: ls.count,
    frozen: isFrozen,
    parseFail: ls.failed,
    g2note: g2.note,
    g3,
    g3b,
    alt,
    result: combo.result,
    reason: combo.reason,
    talkerMix: d.posts && d.posts.length ? authorMix(d.posts).byType : null,
    hotValue: c.hotValue ?? null,
    rank: c.rank ?? null,
    freshRatio: d.freshRatio ?? null,
    link: c.link || null,
    errors: d.errors || [],
    srcNote: c.note || null
  };
}

const RESULT_LABEL = {
  write: '✓ 可写',
  write_thin: '✓ 可写（须报薄）',
  watch: '⚠ 待观察',
  pass: '✗ 否决',
  need_alt: '? 须替代判据',
  unknown_topic: '? 词条名对不上（未判定）',
  need_data: '? 数据不足（未判定）'
};

module.exports = {
  THRESHOLD, DAY,
  parseNum, fmtNum,
  extractTopicLib, extractSearchPage, isTopicLibMiss, extractStamps,
  parseStamp, latestStamp, gradeAge, AGE_LABEL,
  gate2, gate3, combine, altCriteria,
  PERSON_TYPE, classifyAuthor, authorMix, gate3bAuthors,
  prefilter, sameTopicFamily, cjkBigrams, modelTokens,
  auditSourceTable, findPersonAccount, tableCells,
  judgeItem, RESULT_LABEL,
  RE_TOPIC_LIB, RE_SEARCH, RE_ORG, RE_PERSON_LABEL, RE_PERSON_HANDLE, PERSON_EXCLUDE
};
