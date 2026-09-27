'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, TYPE } = require('@formatjs/icu-messageformat-parser');
const {
  pseudolocalize,
  pseudolocalizeMessage,
  graphemesOf,
  OPEN_MARK,
  CLOSE_MARK,
  EXPANSION_RATIO,
} = require('../lib/pseudoloc');
const { audit } = require('../lib/audit');

const PARSE_OPTS = { requiresOtherClause: false, shouldParseSkeletons: false };

/** 去掉 AST 中的字面元素与位置信息，只保留结构（参数、选项、#、标签等） */
function stripLiterals(elements) {
  const out = [];
  for (const el of elements) {
    switch (el.type) {
      case TYPE.literal:
        break; // 字面文本不参与结构比较
      case TYPE.select:
        out.push({
          type: 'select',
          value: el.value,
          options: Object.fromEntries(
            Object.entries(el.options).map(([k, o]) => [k, stripLiterals(o.value)]),
          ),
        });
        break;
      case TYPE.plural:
        out.push({
          type: el.pluralType === 'ordinal' ? 'selectordinal' : 'plural',
          value: el.value,
          offset: el.offset || 0,
          options: Object.fromEntries(
            Object.entries(el.options).map(([k, o]) => [k, stripLiterals(o.value)]),
          ),
        });
        break;
      case TYPE.pound:
        out.push({ type: 'pound' });
        break;
      case TYPE.tag:
        out.push({ type: 'tag', value: el.value, children: stripLiterals(el.children) });
        break;
      default:
        out.push({ type: el.type, value: el.value, style: el.style == null ? el.style : String(el.style) });
    }
  }
  return out;
}

/** 去掉字面文本后，生成消息的结构应与原消息一致 */
function assertSameStructure(original, generated) {
  const strip = (msg) => stripLiterals(parse(msg, { ...PARSE_OPTS, captureLocation: false }));
  assert.deepEqual(strip(generated), strip(original));
}

/** 提取生成消息中首个 ⟦ ⟧ 包裹段的内部文本 */
function innerOf(generated) {
  const m = generated.match(/⟦(.*?)⟧/u);
  assert.ok(m, `应包含 ⟦ ⟧ 包裹段：${generated}`);
  return m[1];
}

test('字面文本膨胀到至少 1.5 倍并加 ⟦⟧，参数原样保留', () => {
  const generated = pseudolocalizeMessage('你好 {name}');
  assert.ok(generated.startsWith(OPEN_MARK));
  const inner = innerOf(generated);
  // 原段「你好 」3 个字素 → 至少 ceil(3 × 1.5) = 5 个字素
  assert.ok(graphemesOf(inner).length >= Math.ceil(3 * EXPANSION_RATIO));
  assert.ok(generated.endsWith('⟧{name}'), generated);
  assertSameStructure('你好 {name}', generated);
});

test('追加字素取自原段非空白字素，依原顺序循环', () => {
  // 「你好」2 个字素 → 目标 3 → 追加 1 个：非空白字素序列的第一个「你」
  assert.equal(pseudolocalizeMessage('你好'), '⟦你好你⟧');
  // 「ab cd」5 个字素 → 目标 8 → 追加 3 个：a、b、c（空白不参与追加）
  assert.equal(pseudolocalizeMessage('ab cd'), '⟦ab cdabc⟧');
  // 单字「，」→ 目标 2 → 追加自身
  assert.equal(pseudolocalizeMessage('，'), '⟦，，⟧');
});

test('emoji 与组合字符按字素计算长度', () => {
  const generated = pseudolocalizeMessage('👨‍👩‍👧‍👦 好');
  const inner = innerOf(generated);
  // 原段 3 个字素（emoji 序列算 1 个）→ 目标 5 → 依序追加 emoji、好
  assert.equal(inner, '👨‍👩‍👧‍👦 好👨‍👩‍👧‍👦好');
  assert.ok(graphemesOf(inner).length >= 5);
});

test('纯空白段原样保留，不加 ⟦⟧', () => {
  assert.equal(pseudolocalizeMessage('{a} {b}'), '{a} {b}');
  assert.equal(pseudolocalizeMessage('{a}   \n\t {b}'), '{a}   \n\t {b}');
  // 含非空白字素的段正常膨胀，其中的空白保留在原位
  const generated = pseudolocalizeMessage('{a} 你好 {b}');
  assert.ok(generated.startsWith('{a}⟦'), generated);
  assert.ok(generated.endsWith('⟧{b}'), generated);
});

test('参数名与格式、number skeleton、date/time 样式均保留', () => {
  const msg = '{n, number, ::currency/USD} {d, date, medium} {t, time, short} {x}';
  const generated = pseudolocalizeMessage(msg);
  assert.equal(generated, msg); // 没有字面文本，原样返回
  const msg2 = `共 {n, number, ::percent}，截止 {d, date, medium}`;
  const g2 = pseudolocalizeMessage(msg2);
  assert.ok(g2.includes('{n, number, ::percent}'), g2);
  assert.ok(g2.includes('{d, date, medium}'), g2);
  assertSameStructure(msg2, g2);
});

test('select / plural / selectordinal：选项名、offset、=n、复数 # 均保留', () => {
  const msg =
    '{g, select, female{她} male{他} other{TA}} ' +
    '{n, plural, offset:1 =0{没有} one{# 条} other{# 条}} ' +
    '{r, selectordinal, =1{第一} other{第 #}}';
  const generated = pseudolocalizeMessage(msg);
  // 参数间的纯空白段原样保留；复数 # 保持为 pound；字面文本逐段膨胀
  assert.equal(
    generated,
    '{g, select, female{⟦她她⟧} male{⟦他他⟧} other{⟦TAT⟧}} ' +
      '{n, plural, offset:1 =0{⟦没有没⟧} one{#⟦ 条条⟧} other{#⟦ 条条⟧}} ' +
      '{r, selectordinal, =1{⟦第一第⟧} other{⟦第 第⟧#}}',
  );
  // 可再次解析且结构一致
  assert.doesNotThrow(() => parse(generated, PARSE_OPTS));
  assertSameStructure(msg, generated);
});

test('撇号引用语义保留：被引用的 {x} 仍是字面文本，不变成参数', () => {
  const msg = `'{x}' 不是参数`;
  const generated = pseudolocalizeMessage(msg);
  const ast = parse(generated, PARSE_OPTS);
  // 整则消息应只有一个字面元素（没有 argument 元素）
  assert.equal(ast.length, 1);
  assert.equal(ast[0].type, TYPE.literal);
  // 解析后的字面文本以 ⟦{x} 不是参数 开头（膨胀部分随后）
  assert.ok(ast[0].value.startsWith('⟦{x} 不是参数'), ast[0].value);
  assertSameStructure(msg, generated);
});

test('撇号与特殊字符的转义：花括号、尖括号、单引号 round-trip', () => {
  const msg = `'{a}' '<b>' it''s '{''}'`;
  const generated = pseudolocalizeMessage(msg);
  const value = parse(generated, PARSE_OPTS)[0].value;
  // 膨胀段内部以原始（未转义的）字面文本开头
  assert.ok(value.startsWith(`⟦{a} <b> it's {'}`), value);
  assertSameStructure(msg, generated);
});

test('复数选项内被引用的 # 仍是字面文本，不复数化', () => {
  const msg = `{n, plural, other{'#' 个}}`;
  const generated = pseudolocalizeMessage(msg);
  const option = parse(generated, PARSE_OPTS)[0].options.other.value;
  // 只有一个字面元素，没有 pound 元素
  assert.equal(option.length, 1);
  assert.equal(option[0].type, TYPE.literal);
  assert.ok(option[0].value.startsWith('⟦# 个'), option[0].value);
  assertSameStructure(msg, generated);
});

test('真正的复数 # 保持为 pound 元素', () => {
  const msg = '{n, plural, other{# 个}}';
  const generated = pseudolocalizeMessage(msg);
  const option = parse(generated, PARSE_OPTS)[0].options.other.value;
  assert.equal(option[0].type, TYPE.pound);
  assertSameStructure(msg, generated);
});

test('标签保留，标签内字面文本照常膨胀', () => {
  const msg = '点击 <b>这里</b> 继续';
  const generated = pseudolocalizeMessage(msg);
  const ast = parse(generated, PARSE_OPTS);
  const tag = ast.find((el) => el.type === TYPE.tag);
  assert.ok(tag, generated);
  assert.equal(tag.value, 'b');
  assert.ok(tag.children[0].value.startsWith('⟦这里'), tag.children[0].value);
  assertSameStructure(msg, generated);
});

test('嵌套分支：select 内嵌 plural，结构一致且各自膨胀', () => {
  const msg =
    '{g, select, female{{n, plural, one{她有 1 条} other{她有 # 条}}} ' +
    'other{{n, plural, other{TA 有 # 条}}}}';
  const generated = pseudolocalizeMessage(msg);
  assert.doesNotThrow(() => parse(generated, PARSE_OPTS));
  assertSameStructure(msg, generated);
});

test('整份消息对象：单键语法错误显示键名并跳过，其他键照常生成', () => {
  const { messages, skipped } = pseudolocalize({
    good: '你好 {name}',
    bad: '未闭合 {x',
    alsoGood: '{n, plural, other{# 条}}',
  });
  assert.equal(Object.keys(messages).length, 2);
  assert.ok(messages.good.startsWith('⟦'));
  assert.ok(messages.alsoGood.includes('{n, plural, other{#⟦'), messages.alsoGood);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].key, 'bad');
  assert.ok(skipped[0].error);
});

test('非字符串消息值按键跳过', () => {
  const { messages, skipped } = pseudolocalize({ str: '你好', num: 42, arr: ['x'] });
  assert.deepEqual(Object.keys(messages), ['str']);
  assert.deepEqual(skipped.map((s) => s.key), ['num', 'arr']);
  assert.ok(skipped[0].error.includes('不是字符串'));
});

test('生成的伪译文通过审计：与基准无任何差异发现', () => {
  const baseline = {
    'app.title': '消息审计台',
    'user.greeting': '{gender, select, female{她} male{他} other{TA}} 向你问好，{name}！',
    'inbox.summary': '{name}，你有 {count, plural, =0{没有新消息} one{1 条新消息} other{# 条新消息}}。',
    'meeting.time': '会议时间：{start, date, medium} {end, time, short}',
    'rank.label': '你是第 {rank, selectordinal, one{# 名} other{# 名}}',
    'quota.used': '已用 {used, number, percent}',
  };
  const { messages, skipped } = pseudolocalize(baseline);
  assert.deepEqual(skipped, []);
  assert.deepEqual(audit(baseline, [{ lang: 'en-XA', messages }]), []);
});

test('空消息与纯空白消息', () => {
  const { messages, skipped } = pseudolocalize({ empty: '', blank: '   ' });
  assert.deepEqual(skipped, []);
  assert.equal(messages.empty, '');
  assert.equal(messages.blank, '   ');
});
