'use strict';
/**
 * check_generated.cjs —— 静态自检（不联网、不开浏览器）
 * 用法：node tools\yuqing\check_generated.cjs
 *
 * 查两件事：
 *   1. 生成脚本的语法／转义——生成器是"代码生成器"，生成坏了只会在浏览器里炸，
 *      报错还隔着沙箱，很难定位。这里先编译验掉。
 *   2. ★生成器里那份 classifyAuthor 与 lib.cjs 的是否一致★
 *
 * 为什么要有第 2 项：page_scrape.gen.cjs 里的页面代码是**字符串形式**，没法 require，
 * 所以发帖人分类规则**必然有两份**（一份 Node 侧、一份页面侧）。
 * 改一处漏一处就会出现"抓取说 A、判定说 B"的鬼故事，而且极难发现。
 * 这里把两边源码抽出来，用同一样本表逐条比对。
 *
 * ★vm.Script 只编译不执行★（脚本里有顶层 await 和 page.goto，不能真跑）。
 */

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { buildScript } = require('./page_scrape.gen.cjs');

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); console.log('  ✓ ' + label); pass++; }
  catch (e) { console.log('  ✗ ' + label + '\n      ' + e.message); fail++; }
}

const SAMPLES = [
  { label: '空清单', candidates: [] },
  { label: '单条', candidates: [{ name: '测试词条', link: 'https://s.weibo.com/weibo?q=x&t=769', matterDate: '2026-10-13' }] },
  {
    label: '多条含特殊字符',
    candidates: [
      { name: '带"引号"与\\反斜杠的词条', link: 'https://s.weibo.com/weibo?q=%23x%23', hotValue: 2290000, rank: 1 },
      { name: '换行\n词条', note: '注：含 `反引号` 与 ${模板} 字样' },
      { name: '中文、英文 mixed 词条 #标签#', matterDate: '2026-10-12' }
    ]
  }
];

console.log('生成脚本语法自检（vm.Script 编译，不执行）\n');
for (const s of SAMPLES) {
  check(s.label, () => {
    const code = buildScript(s.candidates);
    // 编译即验语法；顶层 await 需要 SourceTextModule 语义，这里用包装函数验
    new vm.Script('(async () => {\n' + code + '\n})()', { filename: 'generated.mjs' });
  });
}

// 生成结果里必须真的带上了候选数据
check('生成结果包含全部候选', () => {
  const cs = [{ name: '甲' }, { name: '乙' }];
  const code = buildScript(cs);
  for (const c of cs) if (!code.includes(`"${c.name}"`)) throw new Error('缺少候选: ' + c.name);
});

// ★反引号 / ${ 泄漏检查★
//   模板字符串内部的注释或字符串里写反引号，会把模板提前闭合，导致生成器本身语法错误。
//   这个坑已踩两次（page_scrape.gen.cjs 的注释里写 `#词条名#`、写 `pageStamps`）。
//   生成结果里出现反引号，几乎一定是泄漏；${ 同理（会被当插值）。
check('生成结果无多余反引号', () => {
  const code = buildScript([{ name: '甲' }]);
  const n = (code.match(/`/g) || []).length;
  if (n > 0) throw new Error(`生成结果含 ${n} 个反引号（模板字符串可能被提前闭合）`);
});
check('生成结果无未预期插值', () => {
  const code = buildScript([{ name: '甲' }]);
  if (code.includes('${')) throw new Error('生成结果含 ${ ——疑模板插值泄漏');
});

// ══════════════════════════════════════════════════════════════
// ★两份 classifyAuthor 的一致性对账★
//   规则必然有两份：lib.cjs（Node 侧）＋ page_scrape.gen.cjs 的字符串里（页面侧）。
//   这里把两边源码抽出来，用同一样本表比对。
// ══════════════════════════════════════════════════════════════

/**
 * 从源码里抠出 `function name(...) { ... }`
 * ★必须跳过参数表再找函数体★——两边都是**解构参数**（`({ vipIcon, svgClasses })`），
 * 参数里就先出现 `{` 了；只按"第一个 {"截取会把函数体截断（踩过）。
 */
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('未找到函数 ' + name);

  // ① 跳过参数表：从函数名的 '(' 起做括号配对
  const parenAt = src.indexOf('(', start);
  let pd = 0, afterParams = -1;
  for (let i = parenAt; i < src.length; i++) {
    if (src[i] === '(') pd++;
    else if (src[i] === ')') {
      pd--;
      if (pd === 0) { afterParams = i; break; }
    }
  }
  if (afterParams < 0) throw new Error(name + ' 的参数表括号不配对');

  // ② 从参数表之后再找函数体的 '{'，做大括号配对
  const braceAt = src.indexOf('{', afterParams);
  if (braceAt < 0) throw new Error(name + ' 没有函数体');
  let depth = 0;
  for (let i = braceAt; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(name + ' 的函数体大括号不配对');
}

// ① 页面侧那份：直接从生成结果里抠（保证抠的是"真正会跑的那份"）
const generated = buildScript([{ name: '占位' }]);
const pageFnSrc = extractFn(generated, 'classifyAuthor');

// ② Node 侧那份：从 lib.cjs 源码里抠
const libSrc = fs.readFileSync(path.join(__dirname, 'lib.cjs'), 'utf8');
const nodeFnSrc = extractFn(libSrc, 'classifyAuthor');

/** 在 vm 里把源码求值成函数（不执行任何 IO） */
function makeFn(src, label) {
  const sandbox = { PERSON_TYPE: require('./lib.cjs').PERSON_TYPE };
  const fn = vm.runInNewContext('(' + src + ')', vm.createContext(sandbox), { filename: label });
  if (typeof fn !== 'function') throw new Error(label + ' 求值结果不是函数');
  return fn;
}
const pageFn = makeFn(pageFnSrc, 'page_classifyAuthor');
const nodeFn = makeFn(nodeFnSrc, 'lib_classifyAuthor');

// 样本表：覆盖实测 DOM 里出现过的全部标识形态
const CASES = [
  ['蓝V（机构）', { svgClasses: ['woo-icon-main', 'woo-icon--vblue', 'woo-icon-skin'] }],
  ['黄V（个人认证）', { svgClasses: ['woo-icon-main', 'woo-icon--vyellow', 'woo-icon-skin'] }],
  ['svvip_4', { vipIcon: 'https://h5.sinaimg.cn/upload/108/1866/2022/11/02/svvip_4.png' }],
  ['svip_1', { vipIcon: 'https://h5.sinaimg.cn/upload/108/1866/2022/11/02/svip_1.png' }],
  ['vip_7', { vipIcon: 'https://h5.sinaimg.cn/upload/108/1866/2022/11/02/vip_7.png' }],
  ['无任何标识', {}],
  ['蓝V＋会员（蓝V优先）', { vipIcon: 'svvip_4.png', svgClasses: ['woo-icon--vblue'] }],
  ['黄V＋会员（黄V优先）', { vipIcon: 'vip_7.png', svgClasses: ['woo-icon--vyellow'] }],
  ['空 svgClasses 数组', { svgClasses: [] }],
  ['undefined 入参', undefined],
  ['空对象', {}],
  ['vipIcon 有但非 vip 字样', { vipIcon: 'https://x.sinaimg.cn/avatar/abc.png' }],
  ['混入其它 svg class', { svgClasses: ['woo-icon-in', 'woo-like-icon', ''] }]
];

const mismatches = [];
for (const [label, input] of CASES) {
  let a, b, ea = null, eb = null;
  try { a = nodeFn(input); } catch (e) { ea = e.message; }
  try { b = pageFn(input); } catch (e) { eb = e.message; }
  if (ea || eb) { mismatches.push(`${label}: 抛错 node=${ea} page=${eb}`); continue; }
  if (a !== b) mismatches.push(`${label}: lib.cjs 判「${a}」而生成脚本判「${b}」`);
}
check(`两份 classifyAuthor 一致（比对 ${CASES.length} 个样本）`, () => {
  if (mismatches.length) throw new Error('规则不一致：\n        ' + mismatches.join('\n        '));
});

// 内容变化提醒：规则块被改过就提示同步检查（不做强制，只给信号）
// 注：lib.cjs 用常量 PERSON_TYPE.ORG/…，生成脚本用中文字面量，所以两边关键字不同，须分别校验。
check('分类规则非空且分支完整', () => {
  const spec = [
    ['lib.cjs', nodeFnSrc, ['PERSON_TYPE.ORG', 'PERSON_TYPE.YELLOW', 'PERSON_TYPE.MEMBER', 'PERSON_TYPE.PLAIN']],
    ['生成脚本', pageFnSrc, ['vblue', 'vyellow', 'vip', '普通用户']]
  ];
  for (const [label, src, kws] of spec) {
    for (const kw of kws) {
      if (!src.includes(kw)) throw new Error(`${label} 的 classifyAuthor 缺少分支关键字 "${kw}"`);
    }
  }
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
