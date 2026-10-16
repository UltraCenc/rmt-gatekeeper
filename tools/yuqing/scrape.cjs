'use strict';
/**
 * scrape.cjs —— 取数层入口
 *
 * ★两种用法（当前环境只能用第一种）★
 *
 *   ① 生成模式（默认）——推荐，沙箱下唯一可行：
 *        node tools\yuqing\scrape.cjs <候选清单.json>
 *      生成 tools\yuqing\eval\_run_scrape.mjs，然后用 ego_script 执行它：
 *        ego_script({ script: <该文件内容> })
 *      把返回里的 ===SCRAPE=== 之后的 JSON 存成 _judge_data.json，再跑 judge.cjs。
 *
 *      ★为什么不能一步到位★：DSH 沙箱禁止为子进程新建句柄——
 *        spawnSync 捕获输出走管道 → EPERM；cmd.exe 重定向 stdin → Access is denied；
 *        只有"不捕获输出"时子进程才能跑。所以子进程必须由 Harness 的 ego runtime 托管。
 *
 *   ② 管道模式（--pipe）——在无沙箱限制的普通终端里可用：
 *        node tools\yuqing\scrape.cjs <候选清单.json> <输出.json> --pipe
 *
 * 候选清单格式（JSON 数组）：
 *   [{ "name": "词条名", "link": "榜单原链", "matterDate": "2026-10-12",
 *      "hotValue": 2290000, "rank": 1, "note": "备注" }]
 *   name 必填；其余选填。matterDate 是"事情时效"的人工输入（权威源原始发布日）。
 */

const fs = require('fs');
const path = require('path');
const { buildScript } = require('./page_scrape.gen.cjs');
const lib = require('./lib.cjs');

const OUT_SCRIPT = path.resolve(__dirname, 'eval/_run_scrape.mjs');
const OUT_PREFILTERED = path.resolve(__dirname, 'eval/candidates_prefiltered.json');

function loadCandidates(inFile) {
  const abs = path.resolve(inFile);
  if (!fs.existsSync(abs)) { console.error('清单文件不存在: ' + abs); process.exit(2); }
  let candidates;
  try { candidates = JSON.parse(fs.readFileSync(abs, 'utf8')); }
  catch (e) { console.error('清单 JSON 解析失败: ' + e.message); process.exit(2); }
  if (!Array.isArray(candidates) || !candidates.length) { console.error('清单必须是非空 JSON 数组'); process.exit(2); }
  const bad = candidates.filter(c => !c || !c.name);
  if (bad.length) { console.error(`有 ${bad.length} 条缺 name 字段，已中止（不猜）`); process.exit(2); }
  return { candidates, abs };
}

function emit(candidates, absIn, pfInfo) {
  fs.mkdirSync(path.dirname(OUT_SCRIPT), { recursive: true });
  fs.writeFileSync(OUT_SCRIPT, buildScript(candidates), 'utf8');

  console.log(`候选 ${candidates.length} 条 → 已生成抓取脚本`);
  candidates.forEach((c, i) => {
    const marks = [];
    if (typeof c.rank === 'number') marks.push(`第${c.rank}位`);
    if (c.hotValue !== undefined) marks.push(`热度${lib.fmtNum(c.hotValue)}`);
    if (!c.link) marks.push('无链接');
    if (!c.matterDate) marks.push('未给权威源日期');
    console.log(`  ${String(i + 1).padStart(2)}. ${c.name}${marks.length ? '  [' + marks.join('｜') + ']' : ''}`);
  });

  console.log('\n生成: ' + path.relative(process.cwd(), OUT_SCRIPT));
  if (pfInfo) {
    console.log(`\n被粗筛掉的 ${pfInfo.dropped.length} 条（不取数；要跑就手工加回清单）:`);
    pfInfo.dropped.forEach(d =>
      console.log(`  · 第${d.item.rank ?? '?'}位 ${d.item.name}  ← ${d.reason}`));
  }
  console.log('\n下一步（当前环境必须走这步）:');
  console.log('  1) node --check ' + path.relative(process.cwd(), OUT_SCRIPT) + '   ← 先验语法，别省');
  console.log('  2) cmd /c "node \\"<ego-browser.mjs 全路径>\\" < ' + path.relative(process.cwd(), OUT_SCRIPT) + ' > out.txt 2> err.txt"');
  console.log('     ★不要用 PowerShell 管道喂脚本（会截断）；超过 ~10 条必须分批（ego_script 单次 120 秒硬上限）★');
  console.log('  3) 把 out.txt 里 ===SCRAPE=== 之后的 JSON 存为 _judge_data.json');
  console.log('  4) node tools\\yuqing\\judge.cjs ' + path.relative(process.cwd(), absIn) + ' _judge_data.json');
}

/**
 * 定位 ego-browser 运行时。★不写死路径★——写死了别人克隆下来跑不了，
 * 而且会泄露本机目录结构。
 * 查找顺序：① 环境变量 EGO_BROWSER ② 常见安装位置（逐个试，取存在的第一个）。
 */
function resolveEgoRuntime() {
  if (process.env.EGO_BROWSER && fs.existsSync(process.env.EGO_BROWSER)) return process.env.EGO_BROWSER;

  const rel = ['runtime', 'ego-linux', 'bin', 'ego-browser.mjs'];
  const roots = [
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-ego-browser'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar', 'dsh', 'node_modules', 'dsh-ego-browser'),
    path.join(process.cwd(), 'node_modules', 'dsh-ego-browser')
  ].filter(Boolean);

  for (const r of roots) {
    const p = path.join(r, ...rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function pipe(candidates, absIn, outFile) {
  const os = require('os');
  const { spawnSync } = require('child_process');
  const EGO = resolveEgoRuntime();
  if (!EGO) {
    console.error('找不到 ego-browser 运行时。请设环境变量 EGO_BROWSER 指向 ego-browser.mjs，例如：');
    console.error('  $env:EGO_BROWSER = "<...>\\dsh-ego-browser\\runtime\\ego-linux\\bin\\ego-browser.mjs"');
    console.error('（通常不必用 --pipe：当前沙箱下应走「生成模式 + 由 Harness 代跑」，见 docs/06-全流程操作手册.md）');
    process.exit(3);
  }

  const script = buildScript(candidates);
  const tag = `${process.pid}_${Date.now()}`;
  const tmpScript = path.join(os.tmpdir(), `yuqing_script_${tag}.mjs`);
  const tmpOut = path.join(os.tmpdir(), `yuqing_out_${tag}.log`);
  const tmpErr = path.join(os.tmpdir(), `yuqing_err_${tag}.log`);
  fs.writeFileSync(tmpScript, script, 'utf8');

  const quoted = [EGO].map(a => (/[\s&()]/.test(a) ? '"' + a + '"' : a)).join(' ');
  const cmd = `"${process.execPath}" ${quoted} < "${tmpScript}"`;

  const fdOut = fs.openSync(tmpOut, 'w');
  const fdErr = fs.openSync(tmpErr, 'w');
  let res;
  try {
    // stdout/stderr 绑文件描述符（不是管道——管道在本沙箱会 EPERM）
    res = spawnSync('cmd.exe', ['/d', '/s', '/c', cmd], {
      stdio: ['ignore', fdOut, fdErr],
      timeout: 20 * 60 * 1000
    });
  } finally {
    fs.closeSync(fdOut); fs.closeSync(fdErr);
  }

  const stdout = fs.existsSync(tmpOut) ? fs.readFileSync(tmpOut, 'utf8') : '';
  const stderr = fs.existsSync(tmpErr) ? fs.readFileSync(tmpErr, 'utf8') : '';
  for (const f of [tmpScript, tmpOut, tmpErr]) { try { fs.unlinkSync(f); } catch { /* 忽略 */ } }

  const marker = stdout.indexOf('===SCRAPE===');
  if (marker < 0) {
    console.error('未取到抓取结果。ego-browser 退出码: ' + res.status +
      (res.error ? '（' + res.error.code + '）' : ''));
    if (stderr.trim()) console.error('stderr:\n' + stderr.trim().slice(0, 2000));
    console.error('\n★这就是沙箱限制：Node 无法捕获子进程输出。请改用生成模式（去掉 --pipe）。');
    process.exit(1);
  }
  const payload = JSON.parse(stdout.slice(marker + '===SCRAPE==='.length).split('\n')[0]);
  const out = path.resolve(outFile || './_judge_data.json');
  fs.writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8');
  console.log('已写出: ' + out);
}

function main() {
  const args = process.argv.slice(2);
  const positional = args.filter(a => !a.startsWith('--'));
  if (!positional.length) {
    console.error('用法: node tools\\yuqing\\scrape.cjs <候选清单.json> [输出.json] [选项]');
    console.error('选项:');
    console.error('  --prefilter        榜面粗筛后再取数（位次前 N 直通；其余按议题族去重，每族留热度最高那条）');
    console.error('  --keep <N>         粗筛直通位次，默认 20（配合 --prefilter）');
    console.error('  --pipe             一步跑完（仅限无沙箱限制的普通终端）');
    process.exit(2);
  }
  let { candidates, abs } = loadCandidates(positional[0]);

  // ★榜面粗筛★：先砍再取数，别为注定要否的条目付取数的钱
  let pfInfo = null;
  if (args.includes('--prefilter')) {
    const ki = args.indexOf('--keep');
    const keepRank = ki >= 0 ? Number(args[ki + 1]) : 20;
    if (!Number.isFinite(keepRank) || keepRank < 1) { console.error('--keep 需要一个 ≥1 的数字'); process.exit(2); }
    const before = candidates.length;
    const r = lib.prefilter(candidates, { keepRank });
    pfInfo = r;
    candidates = r.kept;
    console.log(`${'═'.repeat(64)}`);
    console.log(`榜面粗筛：${before} 条 → ${candidates.length} 条（直通位次 ≤${keepRank}；其余按议题族去重）`);
    console.log(`${'═'.repeat(64)}`);
    if (r.families.length) {
      console.log(`识别出 ${r.families.length} 个"20 位以后的议题族"：`);
      r.families.forEach(f => console.log(
        `  · 「${f.seed.name}」共 ${f.members.length} 条 → 留「${f.kept.name}」（热度 ${lib.fmtNum(f.kept.hotValue)}）`));
    }
    console.log('');
    // 落盘，便于 judge 直接用同一份清单
    fs.writeFileSync(OUT_PREFILTERED, JSON.stringify(candidates, null, 2), 'utf8');
    console.log('粗筛后清单: ' + path.relative(process.cwd(), OUT_PREFILTERED));
    console.log('（judge.cjs 也请用这份清单，保证报告与取数一一对应）\n');
  }

  if (args.includes('--pipe')) pipe(candidates, abs, positional[1]);
  else emit(candidates, abs, pfInfo);
}

main();
