'use strict';
/**
 * page_scrape.gen.cjs —— 浏览器侧代码生成器（★代码生成器，不是 runner★）
 *
 * 为什么长这样：DSH 沙箱下 **Node 不能捕获子进程输出**（stdio 走管道会 EPERM），
 * 所以 scrape.cjs 不能自己调 ego-browser 拿结果。改为：
 *   1. 这里生成一份"能在 ego-browser 里直接跑"的脚本文件；
 *   2. 由 ego_script 执行该文件（Harness 托管的 runtime），结果落在工具返回里。
 * 这样取数逻辑仍然是独立文件、可复用、可测试，不依赖会话记忆。
 *
 * 取数策略（2026-10-13 实测校准）：
 *   入口甲 话题库 s.weibo.com/topic?q=  → 讨论量／阅读量（唯一的"量"来源）
 *   入口乙 搜索页 s.weibo.com/weibo?q=  → 帖子时间戳（唯一的时效来源）
 *   ★入口乙不产出「阅读量X 讨论量Y」格式化数据——实测无此格式，勿照文档假设★
 *   ★page.url() 返回 Promise，必须 await——否则拿到 "[object Promise]"★
 *   ★入口乙必须用 `#词条名#` 精确检索★：裸词条名是模糊全文搜索，会把同族话题的帖子
 *     混进来，**系统性高估时效**。实测踩过（见下文 scrapeOne 内注释）。
 *
 * ★★必须串行，不能并发★★（踩过）：
 *   worker 之间共享同一个 page 对象，并发 goto 会互相踩——A 的 goto 之后 B 又跳走，
 *   A 再取 url/文本就是 B 的页面。曾出现 4 条候选里 3 条数据全部串成同一条。
 *   本可给每个 worker 开独立标签页，但 browser.openOrReuseTab 要写
 *   %LOCALAPPDATA%\\ego-lite-linux\\task-spaces.json（工作区外），被沙箱 EPERM 挡住。
 *   → 结论：老老实实串行。单条约 5.2 秒，16 条约 1.5 分钟，可接受。
 */

const WAIT_MS = 2600;     // 每次 goto 后等待渲染

/** 生成可执行脚本正文 */
function buildScript(candidates) {
  return `// 自动生成，勿手工编辑。生成自 tools/yuqing/page_scrape.gen.cjs
const candidates = ${JSON.stringify(candidates, null, 2)};

// ★护栏：词条名必须与微博上的词条逐字一致（含「养老陪伴服务」这类后缀），
//   否则话题库会莫名返回"未找到"，被误判成榜单词条型。
//   曾用简称"某养老陪伴服务议题养老陪伴服务"去查，实际话题名是"某养老陪伴服务议题"，直接查不到。

const __lib = (() => {
  // ★发文时间戳两档★：带时刻的才是发文格式；裸日期只作兜底。
  //   踩过：搜索页正文里的"2026年11月1日施行"被当成发帖时间，算出 -18.9 天前。
  const STAMP_MAIN = /(\\d+秒前|\\d+分钟前|\\d+小时前|今天\\s*\\d{1,2}:\\d{2}|昨天\\s*\\d{1,2}:\\d{2}|\\d+天前|\\d{1,2}月\\d{1,2}日\\s*\\d{1,2}:\\d{2})/g;
  const STAMP_FALLBACK = /(\\d{4}年\\d{1,2}月\\d{1,2}日|\\d{1,2}月\\d{1,2}日)/g;
  const DAY = 86400000;
  function parseStamp(t, now) {
    t = String(t).trim().replace(/\\s+/g, ' '); let m;
    if ((m = t.match(/^(\\d+)秒前$/))) return now - +m[1]*1000;
    if ((m = t.match(/^(\\d+)分钟前$/))) return now - +m[1]*60000;
    if ((m = t.match(/^(\\d+)小时前$/))) return now - +m[1]*3600000;
    if ((m = t.match(/^今天\\s*(\\d{1,2}):(\\d{2})$/))) { const d=new Date(now); d.setHours(+m[1],+m[2],0,0); return d.getTime(); }
    if ((m = t.match(/^昨天\\s*(\\d{1,2}):(\\d{2})$/))) { const d=new Date(now); d.setHours(+m[1],+m[2],0,0); return d.getTime()-DAY; }
    if ((m = t.match(/^(\\d+)天前$/))) return now - +m[1]*DAY;
    if ((m = t.match(/^(\\d{1,2})月(\\d{1,2})日\\s*(\\d{1,2}):(\\d{2})$/))) { const d=new Date(now); d.setMonth(+m[1]-1,+m[2]); d.setHours(+m[3],+m[4],0,0); if (d.getTime()>now+DAY) d.setFullYear(d.getFullYear()-1); return d.getTime(); }
    if ((m = t.match(/^(\\d{1,2})月(\\d{1,2})日$/))) { const d=new Date(now); d.setMonth(+m[1]-1,+m[2]); d.setHours(12,0,0,0); if (d.getTime()>now+DAY) d.setFullYear(d.getFullYear()-1); return d.getTime(); }
    if ((m = t.match(/^(\\d{4})年(\\d{1,2})月(\\d{1,2})日$/))) { const d=new Date(now); d.setFullYear(+m[1],+m[2]-1,+m[3]); d.setHours(12,0,0,0); return d.getTime(); }
    return null;
  }
  function parseNum(raw) {
    if (raw === undefined || raw === null) return null;
    const s = String(raw).trim().replace(/,/g, ''); if (!s) return null;
    const m = s.match(/^([\\d.]+)\\s*(万|亿)?$/); if (!m) return null;
    const v = parseFloat(m[1]); if (!isFinite(v)) return null;
    return Math.round(v * (m[2]==='亿'?1e8:m[2]==='万'?1e4:1));
  }
  function extractStamps(text) {
    const grab = (re) => {
      const found = String(text).match(re) || [];
      const seen = new Set(); const out = [];
      for (const x of found) { const k = x.replace(/\\s+/g, ''); if (!seen.has(k)) { seen.add(k); out.push(x.trim()); } }
      return out;
    };
    let stamps = grab(STAMP_MAIN);
    if (stamps.length) return { stamps, tier: 'main' };
    stamps = grab(STAMP_FALLBACK);
    return { stamps, tier: stamps.length ? 'fallback' : 'none' };
  }
  /** 发帖人类型判定（与 lib.cjs 的 classifyAuthor 同规则，须保持一致） */
  function classifyAuthor(o) {
    const vipIcon = (o && o.vipIcon) || '';
    const svg = ((o && o.svgClasses) || []).join(' ');
    if (/vblue/.test(svg)) return '机构蓝V';
    if (/vyellow/.test(svg)) return '个人黄V';
    if (/vip/i.test(vipIcon)) return '月费会员';   // svvip_N / svip_N / vip_N
    return '普通用户';
  }
  return { STAMP_MAIN, STAMP_FALLBACK, extractStamps, parseStamp, parseNum, classifyAuthor, DAY };
})();

const RE_TOPIC_LIB = /([\\d.]+万?)\\s*讨论\\s*([\\d.]+万?)\\s*阅读/;
const RE_SEARCH = /阅读量\\s*([\\d.]+万?)\\s*讨论量\\s*([\\d.]+万?)/;
const RE_MISS = /未找到|没有找到|暂无|无相关结果/;

async function scrapeOne(c) {
  const out = { name: c.name, topicLib: null, libMiss: false, stamps: [], stampTier: 'none', pageStamps: [], posts: [], freshRatio: null, sampleN: 0, errors: [], urls: {} };
  const now = Date.now();

  // ── 入口甲：话题库（量） ──
  try {
    await page.goto('https://s.weibo.com/topic?q=' + encodeURIComponent(c.name), { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(${WAIT_MS});
    const t = await page.evaluate(() => document.body.innerText);
    out.urls.topicLib = await page.url();
    const hit = t.match(RE_TOPIC_LIB);
    if (hit) {
      out.topicLib = { raw: hit[0], discuss: __lib.parseNum(hit[1]), read: __lib.parseNum(hit[2]) };
    } else if (RE_MISS.test(t.slice(0, 1500))) {
      out.libMiss = true;
      out.nameNotFound = true;   // 页面明确说"未找到" → 词条名与微博不一致
    } else {
      out.libMiss = true;
      // ★对不上 ≠ 页面异常★：有明确"未找到"字样才算词条名对不上；
      //   没有该字样、页面又很短，是取数异常（可能被限流／改版），不能当成"已判定"。
      out.topicLibMissExplicit = true;
      out.errors.push('入口甲无数据格式且无"未找到"字样（页面 ' + t.length + ' 字），按榜单词条型处理');
    }
  } catch (e) { out.errors.push('入口甲异常: ' + String(e).slice(0, 160)); }

  // ── 入口乙：搜索页（时间戳） ──
  try {
    // ★必须用「#词条名#」精确检索，不能用裸词条名★
    //   裸词条名是**模糊全文搜索**，会把同族话题的帖子混进来，系统性高估时效。
    //   实测「某养老陪伴服务议题」：裸名搜索捞回 #北京街头出现某养老陪伴服务议题#／#年轻人自愿成为某养老陪伴服务议题#／
    //   #宁波某养老陪伴服务议题为失独老人筹备新年团圆宴#／#大s遗产母亲和儿女共享系谣言# 等一堆今天的新帖；
    //   而真话题 #某养老陪伴服务议题# 话题页里帖子只有 5 条、最新一条 9月11日。
    //   ★曾据此误判"某养老陪伴服务议题议论是新的"，与用户手工深翻的结论（8—9月）相反。★
    const q = '#' + c.name + '#';
    await page.goto('https://s.weibo.com/weibo?q=' + encodeURIComponent(q) + '&t=769&Refer=top', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(${WAIT_MS});
    const t = await page.evaluate(() => document.body.innerText);
    out.urls.search = await page.url();

    // ★★议论时效的唯一可信来源：逐卡片抽出来的帖子时间戳★★
    //   不能用整页 innerText 抽（out.stamps）——那会捞到侧栏／相关推荐里的时间，
    //   实测「某养老陪伴服务议题」整页正则给出"8分钟前"，而 DOM 里只有 5 个帖子卡、
    //   最新是 09月11日 12:57（orphanTimeEls 为空，页面上根本没有"8分钟前"）。
    //   整页值仍保留在 out.pageStamps 里仅供排查，判定只用 out.stamps。

    // ★闸门 3-②：逐条抽"发帖人类型 + 该帖时间"，两者必须一一对应★
    //   只把时间戳混成一堆是不够的——要回答"最近说话的是谁"。
    //   ★关键限制：page.evaluate(fn) 是把 fn 序列化后送进页面执行的，
    //     它**看不到本脚本作用域里的 __lib**（实测报 ReferenceError: __lib is not defined）。
    //     所以页面只负责取原始 DOM 标识，解析与分类一律回 Node 侧做。★
    try {
      const rawPosts = await page.evaluate(() => {
        const rows = [];
        for (const card of document.querySelectorAll('div.card-wrap')) {
          const nameEl = card.querySelector('a.name');
          if (!nameEl) continue;
          const vipImg = card.querySelector('.user_vip_icon_container img, [class*="vip_icon"] img');
          const timeEl = [...card.querySelectorAll('a')].find(a => /前$|今天|昨天|[0-9]{2}月[0-9]{2}日|[0-9]{4}年/.test((a.textContent || '').trim()));
          rows.push({
            name: nameEl.textContent.trim().slice(0, 40),
            vipIcon: vipImg ? (vipImg.getAttribute('src') || '') : '',
            svgClasses: [...card.querySelectorAll('svg')].map(s => (s.getAttribute('class') || '')),
            stamp: timeEl ? timeEl.textContent.trim() : null
          });
        }
        return rows;
      });
      out.posts = rawPosts.map(p => {
        const ms = p.stamp ? __lib.parseStamp(p.stamp, now) : null;
        const valid = ms !== null && ms <= now + 60000;   // 未来日期不算发帖
        return {
          name: p.name,
          type: __lib.classifyAuthor({ vipIcon: p.vipIcon, svgClasses: p.svgClasses }),
          stamp: p.stamp,
          valid,
          ageHours: valid ? (now - ms) / 3600000 : null
        };
      });
    } catch (e) { out.errors.push('发帖人抽样异常: ' + String(e).slice(0, 140)); }
    // 整页正则值：仅存 out.pageStamps 供排查，★绝不用于判定★
    const ex = __lib.extractStamps(t);
    out.pageStamps = ex.stamps.slice(0, 30);
    out.pageStampTier = ex.tier;

    const hitB = t.match(RE_SEARCH);
    if (hitB) out.topicLib_fromSearch = { raw: hitB[0], read: __lib.parseNum(hitB[1]), discuss: __lib.parseNum(hitB[2]) };

    // ★由逐卡帖子结果派生 stamps / freshRatio★（不再用整页正则）
    const validPosts = (out.posts || []).filter(p => p.valid);
    out.stamps = validPosts.map(p => p.stamp);
    out.stampTier = validPosts.length ? 'posts' : 'none';
    out.sampleN = validPosts.length;
    out.freshRatio = validPosts.length
      ? validPosts.filter(p => p.ageHours <= 24).length / validPosts.length
      : null;
    out.posts = out.posts || [];
    // 明说一句：判定依据是逐卡帖子，不是整页文本
    if (!validPosts.length && out.pageStamps && out.pageStamps.length) {
      out.errors.push('逐卡未抽到有效帖子时间戳（整页正则给出 ' + out.pageStamps.length + ' 条，已丢弃不用）');
    }
  } catch (e) { out.errors.push('入口乙异常: ' + String(e).slice(0, 160)); }

  return out;
}

// ★串行★——共用 page 对象，并发会互相踩（见文件头说明）
const results = [];
for (const c of candidates) {
  try { results.push(await scrapeOne(c)); }
  catch (e) {
    results.push({ name: c.name, errors: ['scrapeOne 抛出: ' + String(e).slice(0, 160)], topicLib: null, libMiss: true, stamps: [], freshRatio: null, sampleN: 0 });
  }
}

console.log('===SCRAPE===' + JSON.stringify({ at: new Date().toISOString(), results }));
`;
}

module.exports = { buildScript, WAIT_MS, CONCURRENCY: 1 };
