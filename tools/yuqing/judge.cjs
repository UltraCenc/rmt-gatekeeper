'use strict';
/**
 * judge.cjs —— 判定层（纯本地计算，不联网）
 *
 * 用法：
 *   node tools\yuqing\judge.cjs <候选清单.json> <抓取数据.json> [报告.md]
 *   node tools\yuqing\judge.cjs --audit-sources           # 闸门 1-② 全量读稿（不联网）
 *
 * 输出：控制台结论表 ＋ JSON（给 eval 用）＋ 可读 Markdown 报告
 *
 * 判定依据：docs/01-判据-选题判定标准.md（七道闸门）、docs/03-开发记录-v4.md（v4 规则）
 * ★只出"初筛结果"，判定/否决/拍板永远指人★
 */

const fs = require('fs');
const path = require('path');
const lib = require('./lib.cjs');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m'
};
const COLOR = {
  write: C.green, write_thin: C.green, watch: C.yellow,
  pass: C.red, need_data: C.cyan, need_alt: C.cyan, unknown_topic: C.yellow
};

// ────────────────────────────── 闸门 1-②：全量读稿 ──────────────────────────────

function auditSources(dir = '.') {
  const files = fs.readdirSync(dir).filter(f => /^舆情信息_.*\.md$/.test(f)).sort();
  const rows = files.map(f => {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const a = lib.auditSourceTable(raw, f);
    return { ...a, short: f.replace(/^舆情信息_|\.md$/g, '') };
  });

  const failed = rows.filter(r => r.verdict !== 'pass');
  console.log(`${C.bold}闸门 1-② 全量读稿（来源列里有没有"网民个人账号"）${C.reset}`);
  console.log(`${C.dim}判据：来源列须至少一条网民个人账号（显式标签或 @账号名），且未被作者标为"须核/见下"${C.reset}`);
  console.log(`共 ${rows.length} 篇｜过 ${rows.length - failed.length} 篇｜✗ 不合格 ${failed.length} 篇\n`);
  console.log('文件'.padEnd(34) + '来源行  待核行  结论 / 引用到的个人账号');
  console.log('─'.repeat(96));
  for (const r of rows) {
    const verdict = r.verdict === 'pass' ? `${C.green}✓ 过${C.reset}` : `${C.red}✗ 不合格${C.reset}`;
    const who = r.hasPerson ? '  ' + C.dim + r.personExamples.join('、').slice(0, 34) + C.reset : '';
    console.log(
      r.short.slice(0, 32).padEnd(34) +
      String(r.rowCount).padEnd(8) +
      String(r.flaggedCount).padEnd(8) +
      verdict + who
    );
  }
  if (failed.length) {
    console.log(`\n${C.red}✗ 来源列内无网民个人账号（${failed.length} 篇）：${C.reset}`);
    failed.forEach(r => console.log('  · ' + r.short));
  }
  return rows;
}

// ────────────────────────────── 主判定 ──────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--audit-sources')) {
    const dir = args.find(a => !a.startsWith('--')) || '.';
    const rows = auditSources(dir);
    const outFile = path.resolve('./_audit_sources.json');
    fs.writeFileSync(outFile, JSON.stringify(rows, null, 2), 'utf8');
    console.log('\n已写出: ' + outFile);
    return;
  }

  const files = args.filter(a => !a.startsWith('--'));
  if (files.length < 2) {
    console.error('用法: node tools\\yuqing\\judge.cjs <候选清单.json> <抓取数据.json> [报告.md]');
    console.error('      node tools\\yuqing\\judge.cjs --audit-sources [稿件目录]');
    process.exit(2);
  }

  const cands = JSON.parse(fs.readFileSync(path.resolve(files[0]), 'utf8'));
  const scraped = JSON.parse(fs.readFileSync(path.resolve(files[1]), 'utf8'));
  const now = scraped.at ? new Date(scraped.at).getTime() : Date.now();

  const byName = new Map(scraped.results.map(r => [r.name, r]));
  const items = [];
  const missing = [];

  for (const c of cands) {
    const d = byName.get(c.name);
    if (!d) { missing.push(c.name); continue; }
    items.push(lib.judgeItem(c, d, now));
  }

  // ── 控制台结论表 ──
  console.log(`${C.bold}选题判定（初筛）　取数时间 ${new Date(now).toLocaleString('zh-CN')}${C.reset}`);
  console.log(`${C.dim}闸门 2（时效拆两条）＋闸门 3（议论够量）＋闸门 1-②（可引真人原话）${C.reset}\n`);

  const counts = {};
  for (const it of items) {
    counts[it.result] = (counts[it.result] || 0) + 1;
    const col = COLOR[it.result] || C.reset;
    console.log(`${col}${lib.RESULT_LABEL[it.result] || it.result}${C.reset}  ${C.bold}${it.name}${C.reset}  ${C.dim}[${it.kind}]${C.reset}`);
    console.log(`      事情 ${lib.AGE_LABEL[it.matterGrade]}${it.matterDate ? `（${it.matterDate}）` : '（未提供权威源日期）'} ｜ 议论 ${lib.AGE_LABEL[it.talkGrade]}${it.talkAgeDays === null ? '（无时间戳）' : `（最新帖 ${it.talkAgeDays.toFixed(1)} 天前：${it.latestStamp}）`}`);
    if (it.discuss !== null) {
      console.log(`      议论量 ${it.discussFmt} 讨论／${it.readFmt} 阅读　${C.dim}${it.g3.note}${C.reset}`);
    } else {
      console.log(`      议论量 ${C.yellow}无（榜单词条型）${C.reset}　热度值 ${lib.fmtNum(it.hotValue)}｜位次 ${it.rank ?? '—'}｜24h新帖 ${it.freshRatio === null ? '—' : (it.freshRatio * 100).toFixed(0) + '%'}`);
      if (it.alt) console.log(`      ${C.dim}${it.alt.note}${C.reset}`);
    }
    // 闸门 3-②：发帖人构成（有抽样就显示，含"24h 零新帖"这种强信号）
    if (it.g3b && it.g3b.level !== 'nodata') {
      const col2 = it.g3b.ok === false ? C.red : C.dim;
      console.log(`      ${col2}发帖人构成：${it.g3b.note}${C.reset}`);
      if (it.talkerMix) console.log(`      ${C.dim}全部样本分布：${Object.entries(it.talkerMix).map(([k, v]) => k + ' ' + v).join('｜')}${C.reset}`);
    }
    console.log(`      ${C.bold}→ ${it.reason}${C.reset}`);
    if (it.parseFail.length) console.log(`      ${C.yellow}⚠ 时间戳解析失败 ${it.parseFail.length} 条: ${it.parseFail.slice(0, 5).join(' / ')}${C.reset}`);
    if (it.errors.length) it.errors.forEach(e => console.log(`      ${C.yellow}⚠ ${e}${C.reset}`));
    console.log('');
  }

  if (missing.length) {
    console.log(`${C.yellow}⚠ 有 ${missing.length} 条候选在抓取数据里找不到，未判定：${missing.join('、')}${C.reset}\n`);
  }

  const parts = Object.entries(counts).map(([k, v]) => `${lib.RESULT_LABEL[k] || k} ${v}`);
  console.log(`${C.bold}合计 ${items.length} 条：${parts.join('｜')}${C.reset}`);

  // ── JSON（给 eval 用） ──
  const outJson = path.resolve('./tools/yuqing/eval/last_run.json');
  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  fs.writeFileSync(outJson, JSON.stringify({ at: new Date(now).toISOString(), items }, null, 2), 'utf8');

  // ── Markdown 报告 ──
  const mdFile = path.resolve(files[2] || `./判定报告_${new Date(now).toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(mdFile, renderMarkdown(items, now, counts), 'utf8');

  console.log(`\nJSON: ${path.relative(process.cwd(), outJson)}`);
  console.log(`报告: ${path.relative(process.cwd(), mdFile)}`);
}

function renderMarkdown(items, now, counts) {
  const L = [];
  L.push('# 选题判定报告（初筛）');
  L.push('');
  L.push(`> 取数时间：${new Date(now).toLocaleString('zh-CN')}`);
  L.push('> 判定依据：《docs/01-判据-选题判定标准.md》闸门 2／3／1-②；《docs/03-开发记录-v4.md》v4 规则');
  L.push('> **本报告只出初筛结果。判定／否决／拍板永远指人。**');
  L.push('');
  L.push('## 一、结论一览');
  L.push('');
  L.push('| 词条 | 型 | 事情时效 | 议论时效 | 议论量 | 结论 | 依据 |');
  L.push('|---|---|---|---|---|---|---|');
  for (const it of items) {
    const disc = it.discuss !== null
      ? `${it.discussFmt}／${it.readFmt}`
      : `热度值${lib.fmtNum(it.hotValue)}·第${it.rank ?? '?'}位·24h${it.freshRatio === null ? '—' : (it.freshRatio * 100).toFixed(0) + '%'}`;
    L.push(`| ${it.name} | ${it.kind} | ${lib.AGE_LABEL[it.matterGrade]}${it.matterDate ? `（${it.matterDate}）` : ''} | ${lib.AGE_LABEL[it.talkGrade]}${it.talkAgeDays !== null ? `（${it.talkAgeDays.toFixed(1)}天）` : ''} | ${disc} | **${lib.RESULT_LABEL[it.result]}** | ${it.reason} |`);
  }
  L.push('');
  L.push('合计 ' + items.length + ' 条：' + Object.entries(counts).map(([k, v]) => `${lib.RESULT_LABEL[k] || k} ${v}`).join('｜'));
  L.push('');
  L.push('## 二、逐条明细');
  L.push('');
  for (const it of items) {
    L.push(`### ${it.name}`);
    L.push('');
    L.push(`- 结论：**${lib.RESULT_LABEL[it.result]}** —— ${it.reason}`);
    L.push(`- 型别：${it.kind}${it.link ? `（${it.link}）` : ''}`);
    L.push(`- 闸门 2（时效）：事情 ${lib.AGE_LABEL[it.matterGrade]}${it.matterDate ? `（权威源原始发布日 ${it.matterDate}）` : '（未提供权威源日期）'}；议论 ${lib.AGE_LABEL[it.talkGrade]}${it.talkAgeDays !== null ? `（最新帖 ${it.talkAgeDays.toFixed(1)} 天前，样本时间戳 ${it.stampCount} 条，取最新一条：${it.latestStamp}）` : '（未取到时间戳）'}`);
    if (it.discuss !== null) {
      L.push(`- 闸门 3（议论量）：${it.g3.note}（数据出处：入口甲 话题库 s.weibo.com/topic）`);
    } else {
      L.push(`- 闸门 3（替代判据）：${it.alt ? it.alt.note : '不可用'}`);
      L.push(`  - 榜单热度值 ${lib.fmtNum(it.hotValue)}｜在榜位次 ${it.rank ?? '—'}｜24h 内新帖占比 ${it.freshRatio === null ? '—' : (it.freshRatio * 100).toFixed(0) + '%'}`);
      if (it.alt && it.alt.hits.length) L.push(`  - 命中项：${it.alt.hits.join('；')}`);
    }
    if (it.parseFail.length) L.push(`- ⚠ 时间戳解析失败 ${it.parseFail.length} 条：${it.parseFail.slice(0, 8).join(' / ')}`);
    if (it.g3b && it.g3b.level !== 'nodata') {
      L.push(`- 闸门 3-②（发帖人构成）：${it.g3b.note}`);
      if (it.talkerMix) L.push(`  - 全部样本分布：${Object.entries(it.talkerMix).map(([k, v]) => `${k} ${v} 条`).join('｜')}`);
      L.push('  - 判据：24h 新帖中普通用户（含月费会员）占比 ≥30%；新帖 <5 条时不下结论');
    }
    if (it.errors.length) it.errors.forEach(e => L.push(`- ⚠ ${e}`));
    if (it.srcNote) L.push(`- 备注：${it.srcNote}`);
    L.push('');
  }
  L.push('## 三、没被判的闸门（本报告不管，须人判）');
  L.push('');
  L.push('| 闸门 | 为什么机器不管 |');
  L.push('|---|---|');
  L.push('| 1-① 议题真实（真人构成主体） | "是不是博主解读"需人判 |');
  L.push('| 4 性质匹配 | 体裁定性需人判（企业／宏观／司法／中央指示） |');
  L.push('| 5 事实有源 | "够不够权威"需人判 |');
  L.push('| 6 落点有接口 | 问的是"领导能下令干什么"，是政治判断 |');
  L.push('| 7 特别处置 | 问的是"要不要报"，**必须领导定** |');
  L.push('');
  return L.join('\n');
}

main();
