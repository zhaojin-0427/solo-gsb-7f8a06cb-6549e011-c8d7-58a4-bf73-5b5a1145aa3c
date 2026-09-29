'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, TYPE } = require('@formatjs/icu-messageformat-parser');
const IntlMessageFormat = require('intl-messageformat').default;
const { pseudoLocalize, pseudoLocalizeMessage, pseudoLiteral, toGraphemes } = require('../lib/pseudoloc');

/**
 * 结构规范化：字面量只保留占位节点（不含内容），其余全部保留——
 * 参数名、格式（style/skeleton）、select/plural 选项名、offset、复数类别、
 * 显式 =n、复数 #（pound）、标签名与嵌套结构。
 */
function structureOf(els) {
  return els.map((el) => {
    switch (el.type) {
      case TYPE.literal:
        return { type: 'LIT' };
      case TYPE.argument:
      case TYPE.number:
      case TYPE.date:
      case TYPE.time: {
        const node = { type: el.type, value: el.value };
        if (el.style !== undefined) node.style = el.style;
        return node;
      }
      case TYPE.select:
      case TYPE.plural: {
        const node = {
          type: el.type,
          value: el.value,
          pluralType: el.pluralType,
          offset: el.offset,
          options: {},
        };
        for (const name of Object.keys(el.options)) {
          node.options[name] = structureOf(el.options[name].value);
        }
        return node;
      }
      case TYPE.tag:
        return { type: el.type, value: el.value, children: structureOf(el.children) };
      default:
        return { type: el.type }; // pound 等
    }
  });
}

/** 去掉字面文本后的结构是否一致（生成消息先再次解析，再与原消息结构比较） */
function assertSameStructure(t, original, pseudo) {
  const a = structureOf(parse(original, { requiresOtherClause: false, shouldParseSkeletons: false }));
  const b = structureOf(parse(pseudo, { requiresOtherClause: false, shouldParseSkeletons: false }));
  assert.deepEqual(b, a, '去掉字面文本后结构应与原消息一致');
}

/** 统计伪译文里所有非空白字素段（⟦…⟧），校验长度 ≥ 1.5 倍原长 */
function assertSegmentsExpanded(t, original, pseudo) {
  const origAst = parse(original, { requiresOtherClause: false, shouldParseSkeletons: false });
  const pseudoAst = parse(pseudo, { requiresOtherClause: false, shouldParseSkeletons: false });

  const literalRuns = (els, inPlural) => {
    const runs = [];
    for (const el of els) {
      if (el.type === TYPE.literal) {
        let cur = [];
        let curWs = null;
        for (const g of toGraphemes(el.value)) {
          const ws = /^\s$/u.test(g);
          if (curWs !== null && ws !== curWs) {
            if (!curWs) runs.push(cur.join(''));
            cur = [];
          }
          curWs = ws;
          cur.push(g);
        }
        if (cur.length && !curWs) runs.push(cur.join(''));
      } else if (el.options) {
        for (const opt of Object.values(el.options)) {
          runs.push(...literalRuns(opt.value, inPlural || el.type === TYPE.plural));
        }
      } else if (el.children) {
        runs.push(...literalRuns(el.children, inPlural));
      }
    }
    return runs;
  };

  // 伪译文解析后的字面量去掉 ⟦⟧，其长度至少为原段 1.5 倍
  const origRuns = literalRuns(origAst, false).map((s) => toGraphemes(s).length);
  const pseudoRuns = literalRuns(pseudoAst, false).map((s) => toGraphemes(s).length);
  assert.equal(pseudoRuns.length, origRuns.length, '非空白段数量应一致');
  pseudoRuns.forEach((len, i) => {
    assert.ok(len >= Math.ceil(origRuns[i] * 1.5), `段长度 ${len} 应 ≥ 原长 ${origRuns[i]} 的 1.5 倍`);
  });
}

test('普通字面文本：加 ⟦⟧ 并循环扩到至少 1.5 倍，参数保留', () => {
  const msg = '你好，{name}！';
  const r = pseudoLocalizeMessage(msg);
  assert.equal(r.error, undefined);
  assert.match(r.text, /⟦你好，你好⟧/);
  assert.match(r.text, /⟦！！⟧/);
  assert.ok(r.text.includes('{name}'));
  assertSameStructure(test, msg, r.text);
  assertSegmentsExpanded(test, msg, r.text);
});

test('空白分段：每个非空白段独立膨胀，纯空白原样保留', () => {
  const out = pseudoLiteral('a bcd  e', false);
  assert.equal(out, '⟦aa⟧ ⟦bcdbc⟧  ⟦ee⟧');
  // 纯空白字面量原样
  assert.equal(pseudoLiteral('   \t\n ', false), '   \t\n ');
  assert.equal(pseudoLiteral('', false), '');
});

test('膨胀长度按 Unicode 字素计算：组合字符与 emoji ZWJ 序列各算一个字素', () => {
  // é（e + 组合重音）为一个字素；3 个字素 → 至少 5 个字素
  const out = pseudoLiteral('éabc', false);
  const inner = out.slice(1, -1);
  assert.ok(toGraphemes(inner).length >= 5);
  // ZWJ family emoji 👨‍👩‍👧 是 1 个字素；n=3 → ⌈3/2⌉=2 个追加
  const family = '👨‍👩‍👧';
  const out2 = pseudoLiteral(`${family}ab`, false);
  const inner2 = out2.slice(1, -1);
  assert.equal(toGraphemes(inner2).length, 5); // 3 + 2
  assert.ok(inner2.includes(`${family}ab${family}a`));
});

test('select：选项名与各分支结构保留，分支内字面文本膨胀', () => {
  const msg = '{gender, select, female{她} male{他} other{TA}} 向你问好';
  const r = pseudoLocalizeMessage(msg);
  for (const opt of ['female', 'male', 'other']) {
    assert.ok(r.text.includes(`${opt}{`), `选项名 ${opt} 应保留`);
  }
  assert.ok(r.text.includes('{gender, select,'));
  assertSameStructure(test, msg, r.text);
  assertSegmentsExpanded(test, msg, r.text);
});

test('plural / selectordinal：offset、显式 =n、语言类别与 # 全部保留', () => {
  const msg = '{count, plural, offset:2 =0{没有} =1{一} one{# 条} other{# 条}}';
  const r = pseudoLocalizeMessage(msg);
  assert.ok(r.text.includes('offset:2'));
  assert.ok(r.text.includes('=0{'));
  assert.ok(r.text.includes('=1{'));
  assert.ok(r.text.includes('one{'));
  assert.ok(r.text.includes('other{'));
  assert.equal((r.text.match(/#/g) || []).length, 2, '两个复数 # 须原样保留');
  assertSameStructure(test, msg, r.text);

  const ord = '{r, selectordinal, =1{#st} two{#nd} other{#th}}';
  const ro = pseudoLocalizeMessage(ord);
  assert.ok(ro.text.includes('selectordinal'));
  assertSameStructure(test, ord, ro.text);
});

test('数字 / 日期 / 时间格式（style / skeleton）原样保留', () => {
  const msg = '已用 {used, number, percent}；{start, date, medium} {start, time, short}';
  const r = pseudoLocalizeMessage(msg);
  assert.ok(r.text.includes('{used, number, percent}'));
  assert.ok(r.text.includes('{start, date, medium}'));
  assert.ok(r.text.includes('{start, time, short}'));
  assertSameStructure(test, msg, r.text);
});

test('富文本标签名与结构保留，标签内文本膨胀', () => {
  const msg = '<b>加粗</b> 与 <link>链接文字</link> {x}';
  const r = pseudoLocalizeMessage(msg);
  assert.ok(r.text.includes('<b>'));
  assert.ok(r.text.includes('</b>'));
  assert.ok(r.text.includes('<link>'));
  assert.ok(r.text.includes('{x}'));
  assertSameStructure(test, msg, r.text);
});

test('字面文本里的特殊字符被撇号引用：{ } < > 与复数分支内的 #', () => {
  // 复数分支内：未引用的 # 是 pound 节点；被源文撇号引用的 '#' 是字面 #，
  // 重新生成后仍须一个 pound + 一个字面 #
  const msg = "{n, plural, other{价格 # 与字面 '#' 号}}";
  const r = pseudoLocalizeMessage(msg);
  // 重新解析后，分支字面量应同时含渲染用 #（pound）和字面 #
  const ast = parse(r.text, { requiresOtherClause: false });
  const opt = ast[0].options.other.value;
  const kinds = opt.map((n) => (n.type === TYPE.literal ? `L:${JSON.stringify(n.value)}` : `P${n.type}`));
  assert.ok(kinds.some((k) => k === `P${TYPE.pound}`), '复数 # 仍是 pound 节点');
  const literals = opt.filter((n) => n.type === TYPE.literal).map((n) => n.value).join('|');
  assert.ok(literals.includes('#'), '字面 # 应被引用保留为普通字符');
  assertSameStructure(test, msg, r.text);

  // 源文本里带未转义尖括号的字面量，重新生成后必须能解析（不再被当成标签）
  const angle = pseudoLocalizeMessage('a < b > c');
  assert.equal(angle.error, undefined);
  const rendered = new IntlMessageFormat(angle.text, 'en').format();
  assert.ok(rendered.includes('<') && rendered.includes('>'));
});

test('撇号引用语义保留：单撇号、双撇号、花括号引用重新解析后含义一致', () => {
  const cases = [
    "it's fine",
    "don''t panic",
    "'{'not arg'}'",
    "100% 折扣 '#'",
  ];
  for (const msg of cases) {
    const r = pseudoLocalizeMessage(msg);
    assert.equal(r.error, undefined, `${msg} 应能处理`);
    const origText = String(new IntlMessageFormat(msg, 'en').format());
    const pseudoText = String(new IntlMessageFormat(r.text, 'en').format());
    // 去掉 ⟦⟧ 标记后，原有的字面字符（撇号、花括号等）必须全部还在
    const stripped = pseudoText.replace(/[⟦⟧]/g, '');
    for (const ch of origText) {
      assert.ok(stripped.includes(ch), `「${msg}」处理后字符 ${ch} 不应丢失（得到 ${pseudoText}）`);
    }
    assertSameStructure(test, msg, r.text);
  }
});

test('嵌套分支：select 内 plural 内字面文本与结构均正确', () => {
  const msg = '{g, select, female{{n, plural, one{她有 # 条} other{她有 # 条}}} other{无}}';
  const r = pseudoLocalizeMessage(msg);
  assertSameStructure(test, msg, r.text);
  assertSegmentsExpanded(test, msg, r.text);
});

test('单键语法错误返回 error 且给出解析原因', () => {
  const r1 = pseudoLocalizeMessage('未闭合 {x');
  assert.ok(r1.error);
  const r2 = pseudoLocalizeMessage(42);
  assert.ok(r2.error.includes('不是字符串'));
});

test('pseudoLocalize：错误键跳过并记录键名，其他键照常生成', () => {
  const { output, skipped } = pseudoLocalize({
    ok: '你好 {name}',
    bad: '未闭合 {x',
    num: 123,
    fine: '{n, plural, other{# 条}}',
  });
  assert.deepEqual(Object.keys(output), ['ok', 'fine']);
  assert.equal(skipped.length, 2);
  assert.deepEqual(skipped.map((s) => s.key), ['bad', 'num']);
  assert.ok(skipped[0].error);
  assert.ok(output.ok.includes('⟦'));
  assert.ok(output.fine.includes('#'));
});

test('空消息与纯空白消息：合法且原样可再解析', () => {
  assert.equal(pseudoLocalizeMessage('').text, '');
  const r = pseudoLocalizeMessage('   ');
  assert.equal(r.text, '   ');
});

test('端到端：伪译文与基准做审计不报参数/选项差异，且能实际渲染', () => {
  const { audit } = require('../lib/audit');
  const baseline = {
    'app.title': '消息审计台',
    'inbox.summary': '{name}，你有 {count, plural, offset:0 =0{没有新消息} one{1 条新消息} other{# 条新消息}}。',
    'user.greeting': '{gender, select, female{她} male{他} other{TA}} 向你问好，{name}！',
  };
  const { output, skipped } = pseudoLocalize(baseline);
  assert.equal(skipped.length, 0);

  const findings = audit(baseline, [{ lang: 'en-XA', messages: output }]);
  // 语法错误 / 参数签名 / select 选项 / =n / other 均不应出现
  const blocking = findings.filter((f) =>
    ['syntax', 'arg', 'mixed', 'select', 'exact', 'other'].includes(f.type));
  assert.deepEqual(blocking, [], `伪译文审计应无结构差异：${JSON.stringify(findings)}`);

  const mf = new IntlMessageFormat(
    output['inbox.summary'], 'en-XA', undefined, { requiresOtherClause: false });
  const text = String(mf.format({ name: 'Sam', count: 5 }));
  assert.match(text, /5/);
  assert.ok(text.includes('⟦'), text);
});
