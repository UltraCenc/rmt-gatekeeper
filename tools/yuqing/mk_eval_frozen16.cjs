'use strict';
/**
 * mk_eval_frozen16.cjs —— 交接文件 4.2-D：16 个历史问题的全量验证
 *
 * 用法：node tools\yuqing\mk_eval_frozen16.cjs
 *
 * ★为什么用"冻结数据"而不是现抓★
 *   历史条目的判决发生在过去，而话题数据会被时间冲掉。现抓只能证明
 *   "这条今天该不该写"（另一件事），证明不了"当时该不该写"。
 *   所以复核一律用文献里记下的**当时值**（手册／开发记录／稿件正文里都是写死的）。
 *
 * ★判定时刻同样要冻结★：JUDGE_NOW 写死在 2026-10-13（数据快照那天）。
 *   冻结数据必须配冻结时钟——否则同一份历史数据会随日历漂移："事情时效"按今天算，
 *   几天后就从"新"变"边缘"。gate2 的 now 口子是 2026-10-14 补的，这里同步用上。
 *
 * 数据来源：tools/yuqing/eval/candidates_frozen16.json（每条带 source 与 note 可溯源）
 *
 * ★这个评测台的边界（必须说清，否则数字会被误读）★
 *   判定器只管闸门 2（时效）、闸门 3（议论量）、闸门 1-②（来源表有无网民账号）。
 *   闸门 4／5／6／7 是"可自动化 vs 必须人判"里明确划归**人判**的，判定器**按设计不判**。
 *   所以本评测台只对"管辖内"的条目算通过率，管辖外的逐条列出、归于对应闸门。
 */

const fs = require('fs');
const path = require('path');
const lib = require('./lib.cjs');

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' };

const casesFile = path.join(__dirname, 'eval/candidates_frozen16.json');
if (!fs.existsSync(casesFile)) {
  console.error('找不到冻结数据：' + path.relative(process.cwd(), casesFile));
  console.error('');
  console.error('这个文件是"16 个历史问题"的评测输入（真话题名 + 当时的数据值），');
  console.error('属于工作数据，不随工具包发布。要跑历史复核，需要自己准备一份同格式的清单：');
  console.error('  [{ "name": "词条名", "gate": "2", "expect": "pass",');
  console.error('     "discuss": 658, "read": 3254000, "discussAgeDays": 21,');
  console.error('     "source": "数据出处", "note": "备注" }, ...]');
  console.error('');
  console.error('不准备也能跑其余自检（都不联网）：');
  console.error('  node tools/yuqing/test_lib.cjs         # 单元测试');
  console.error('  node tools/yuqing/check_generated.cjs  # 静态自检');
  process.exit(2);
}
const cases = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
const now = Date.now();
// ★判定基准时刻＝数据快照日，不许用实时★（冻结数据配冻结时钟，见文件头说明）
const JUDGE_NOW = new Date('2026-10-13T12:00:00+08:00').getTime();

// 判断判定器对这条"有没有管辖权"
function jurisdictionOf(c) {
  const g = c.gate || '';
  if (g === '2' || g === '3') return 'in';          // 直接管辖
  if (g === '1-②') return 'gate_1_2';               // 由 --audit-sources 管（纯读稿，不联网）
  if (g === '5+1-②') return 'mixed';                // 一半在管辖内
  return 'outside';                                  // 4/5/6/7 或 1-① → 人判
}

const rows = [];
for (const c of cases) {
  const jt = jurisdictionOf(c);
  const row = { ...c, jt, actual: null, reason: null, pass: null };

  if (jt === 'outside' || jt === 'mixed') {
    row.actual = '（不在判定器管辖）';
    row.reason = c.note;
    row.pass = null;                                  // 不计入通过率
  } else if (jt === 'gate_1_2') {
    // 1-② 由 --audit-sources 判定；结果引自该次全量读稿
    row.actual = '闸门1-② 判不合格';
    row.reason = '来源表内无网民个人账号原创帖（见 --audit-sources 全量读稿）';
    row.pass = c.expect === 'gate_1_2';
  } else {
    const data = {
      topicLib: (c.discuss !== null || c.read !== null) ? { discuss: c.discuss, read: c.read } : null,
      libMiss: false,
      stamps: [],
      discussAgeDays: typeof c.discussAgeDays === 'number' ? c.discussAgeDays : undefined,
      discussStampNote: c.discussStampNote,
      freshRatio: null,
      errors: []
    };
    // 非微博源（如本地留言板）→ 判定器拿不到话题级数据，须显式标出
    if (data.topicLib === null && data.discussAgeDays === undefined) {
      row.actual = '（无话题级数据，判定器不可判）';
      row.reason = c.note;
      row.pass = null;
    } else {
      const it = lib.judgeItem({ name: c.name, matterDate: c.matterDate }, data, JUDGE_NOW);
      row.actual = lib.RESULT_LABEL[it.result] || it.result;
      row.reason = it.reason;
      row.pass = c.expect === 'pass' ? it.result === 'pass' : it.result !== 'pass';
    }
  }
  rows.push(row);
}

// ───────── 控制台报告 ─────────
console.log(`${C.bold}交接文件 4.2-D：16 个历史问题的全量验证${C.reset}`);
console.log(`${C.dim}数据源：文献里记下的"当时值"（手册／开发记录／稿件正文）；时间 ${new Date(now).toLocaleString('zh-CN')}${C.reset}`);
console.log(`${C.dim}判定器管辖范围：闸门 2（时效）／闸门 3（议论量）／闸门 1-②（来源表有无网民账号）${C.reset}\n`);

console.log('历史问题'.padEnd(30) + '归属   冻结数据'.padEnd(26) + '判定器结果');
console.log('─'.repeat(112));
for (const r of rows) {
  const data = r.discuss !== null
    ? `${lib.fmtNum(r.discuss)}讨论/${lib.fmtNum(r.read)}`
    : (r.read !== null ? `阅读${lib.fmtNum(r.read)}` : '—');
  const mark = r.pass === true ? `${C.green}✓${C.reset}` : r.pass === false ? `${C.red}✗${C.reset}` : `${C.dim}·${C.reset}`;
  console.log(
    r.name.slice(0, 28).padEnd(30) +
    (r.gate || '?').padEnd(7) +
    data.padEnd(24) +
    mark + ' ' + r.actual
  );
}

// ───────── 统计 ─────────
const inScope = rows.filter(r => r.jt === 'in' && r.pass !== null);
const g12 = rows.filter(r => r.jt === 'gate_1_2');
const outside = rows.filter(r => r.jt === 'outside' || r.jt === 'mixed' || r.pass === null && r.jt === 'in');
const hit = inScope.filter(r => r.pass).length;

console.log(`\n${C.bold}═══ 结果 ═══${C.reset}`);
console.log(`闸门 2/3 管辖内（判定器直接判）：${C.bold}${hit}/${inScope.length}${C.reset}`);
inScope.forEach(r => console.log(`   ${r.pass ? C.green + '✓' + C.reset : C.red + '✗' + C.reset} ${r.name}  →  ${r.actual}`));

console.log(`\n闸门 1-② 管辖内（--audit-sources 判，53 篇全量读稿）：${C.bold}${g12.filter(r => r.pass).length}/${g12.length}${C.reset}`);
g12.forEach(r => console.log(`   ${r.pass ? C.green + '✓' + C.reset : C.red + '✗' + C.reset} ${r.name}  →  ${r.actual}`));

const human = rows.filter(r => r.jt === 'outside' || r.jt === 'mixed');
console.log(`\n不在管辖、必须人判：${C.bold}${human.length} 条${C.reset}（判定器按设计不判——这就是"为什么不能全自动"）`);
const byGate = {};
for (const r of human) { const g = (r.gate || '?').split('+')[0]; byGate[g] = (byGate[g] || 0) + 1; }
console.log('   按闸门分布：' + Object.entries(byGate).map(([k, v]) => `闸门${k} ${v}条`).join('｜'));
human.forEach(r => console.log(`   ${C.dim}·${C.reset} ${r.name}  [闸门${r.gate}]  ${r.reason.slice(0, 60)}`));

const inScopeCount = inScope.length + g12.length;
const totalHit = hit + g12.filter(r => r.pass).length;
console.log(`\n${C.bold}★可自动判定的 ${inScopeCount} 条里，判定器命中 ${totalHit}/${inScopeCount}${C.reset}`);
console.log(`${C.dim}其余 ${human.length} 条属闸门 4/5/6/7 与 1-①，判定器按设计不介入。${C.reset}`);

// ───────── 写出 JSON（给 README／简历用） ─────────
const out = {
  at: new Date(now).toISOString(),
  scope: { gate23: inScope.length, gate12: g12.length, humanOnly: human.length },
  hit: { gate23: hit, gate12: g12.filter(r => r.pass).length, total: totalHit, totalInScope: inScopeCount },
  rows: rows.map(r => ({ name: r.name, gate: r.gate, expect: r.expect, actual: r.actual, pass: r.pass, jt: r.jt, source: r.source, note: r.note }))
};
const outFile = path.join(__dirname, 'eval/frozen16_result.json');
fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');
console.log(`\nJSON: ${path.relative(process.cwd(), outFile)}`);

// ───────── 管辖内若有漏判，非零退出（供 CI／自检） ─────────
if (hit !== inScope.length || g12.some(r => !r.pass)) process.exit(1);
