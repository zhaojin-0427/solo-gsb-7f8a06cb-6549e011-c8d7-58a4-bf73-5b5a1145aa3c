'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { preview } = require('../lib/preview');

/** 便捷构造：单语言预览 */
function run(key, values, messages, lang = 'zh-CN') {
  return preview(key, values, [{ lang, messages }])[0];
}

test('普通占位符：字符串值按语言渲染', () => {
  const results = preview('greet', { name: '小明' }, [
    { lang: 'zh-CN', messages: { greet: '你好，{name}！' } },
    { lang: 'ja', messages: { greet: 'こんにちは、{name}！' } },
  ]);
  assert.deepEqual(results, [
    { language: 'zh-CN', text: '你好，小明！' },
    { language: 'ja', text: 'こんにちは、小明！' },
  ]);
});

test('number：有限数字按语言格式渲染', () => {
  const r = preview('quota', { used: 0.85, total: 12345.6 }, [
    { lang: 'en-US', messages: { quota: 'Used {used, number, percent} of {total, number}' } },
    { lang: 'de-DE', messages: { quota: '{used, number, percent} von {total, number} belegt' } },
  ]);
  assert.equal(r[0].text, 'Used 85% of 12,345.6');
  assert.equal(r[1].text, '85 % von 12.345,6 belegt');
});

test('plural：各语言使用自身复数规则（ja 无 one 类别）', () => {
  const msg = '{n, plural, one{one 条} other{# 条}}';
  const results = preview('inbox', { n: 1 }, [
    { lang: 'en', messages: { inbox: msg } },
    { lang: 'ja', messages: { inbox: msg } },
  ]);
  assert.equal(results[0].text, 'one 条');
  assert.equal(results[1].text, '1 条');
});

test('plural：显式 =n 优先于语言类别', () => {
  const msg = '{n, plural, =0{没有} one{1 条} other{# 条}}';
  assert.equal(run('k', { n: 0 }, { k: msg }).text, '没有');
  assert.equal(run('k', { n: 5 }, { k: msg }).text, '5 条');
});

test('selectordinal：按语言的序数类别渲染', () => {
  const msg = '{r, selectordinal, one{#st} two{#nd} few{#rd} other{#th}}';
  const results = preview('rank', { r: 3 }, [
    { lang: 'en', messages: { rank: msg } },
    { lang: 'zh-CN', messages: { rank: '第 {r, selectordinal, other{# 名}}' } },
  ]);
  assert.equal(results[0].text, '3rd');
  assert.equal(results[1].text, '第 3 名');
});

test('select：按值选分支，无匹配时回退 other', () => {
  const msg = '{g, select, female{她} male{他} other{TA}}';
  assert.equal(run('k', { g: 'male' }, { k: msg }).text, '他');
  assert.equal(run('k', { g: '未知' }, { k: msg }).text, 'TA');
});

test('嵌套分支：select 内嵌 plural，按走到的分支校验与渲染', () => {
  const msg = '{g, select, female{{n, plural, one{她有 1 条} other{她有 # 条}}} other{{n, plural, other{TA 有 # 条}}}}';
  assert.equal(run('k', { g: 'female', n: 2 }, { k: msg }).text, '她有 2 条');
  assert.equal(run('k', { g: 'x', n: 5 }, { k: msg }).text, 'TA 有 5 条');
});

test('date/time：带时区的 ISO 8601 字符串转成日期，按语言格式化', () => {
  const iso = '2026-09-27T10:00:00+08:00';
  const msg = '{d, date, medium} {d, time, short}';
  const results = preview('t', { d: iso }, [
    { lang: 'zh-CN', messages: { t: msg } },
    { lang: 'en-US', messages: { t: msg } },
  ]);
  const instant = new Date(iso);
  const expect = (locale) =>
    `${new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(instant)} ` +
    `${new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(instant)}`;
  assert.equal(results[0].text, expect('zh-CN'));
  assert.equal(results[1].text, expect('en-US'));
  // 同一时刻的不同时区写法渲染结果一致，证明时区被正确解析
  const utc = run('t', { d: '2026-09-27T02:00:00Z' }, { t: msg });
  assert.equal(utc.text, results[0].text);
});

test('date/time：不带时区的字符串报错', () => {
  const r1 = run('t', { d: '2026-09-27' }, { t: '{d, date}' });
  const r2 = run('t', { d: '2026-09-27T10:00:00' }, { t: '{d, time}' });
  assert.ok(r1.error.includes('带时区'), r1.error);
  assert.ok(r2.error.includes('带时区'), r2.error);
});

test('date/time：无法解析的日期报错', () => {
  const r = run('t', { d: '2026-13-99T99:99:99Z' }, { t: '{d, date}' });
  assert.ok(r.error.includes('无法解析'), r.error);
});

test('类型不符：number/复数给字符串、普通/select 给数字均报错', () => {
  const r1 = run('k', { n: '3' }, { k: '{n, number}' });
  assert.ok(r1.error.includes('有限数字'), r1.error);
  const r2 = run('k', { n: '3' }, { k: '{n, plural, other{#}}' });
  assert.ok(r2.error.includes('有限数字'), r2.error);
  const r3 = run('k', { name: 42 }, { k: '{name}' });
  assert.ok(r3.error.includes('应为字符串'), r3.error);
  const r4 = run('k', { g: 1 }, { k: '{g, select, male{他} other{TA}}' });
  assert.ok(r4.error.includes('应为字符串'), r4.error);
});

test('非有限数字（NaN / Infinity）报错', () => {
  const r1 = run('k', { n: Number.NaN }, { k: '{n, number}' });
  const r2 = run('k', { n: Infinity }, { k: '{n, plural, other{#}}' });
  assert.ok(r1.error.includes('有限数字'), r1.error);
  assert.ok(r2.error.includes('有限数字'), r2.error);
});

test('实际走到的分支缺值才报错；未走到的分支不校验', () => {
  const msg = '{g, select, male{{n, number} 封} other{没有}}';
  // n 所在分支未走到：不报错
  assert.equal(run('k', { g: 'other' }, { k: msg }).text, '没有');
  // 走到 male 分支：缺 n 报错
  const r = run('k', { g: 'male' }, { k: msg });
  assert.ok(r.error.includes('缺少参数「n」'), r.error);
  // 类型不符同样只在走到的分支报错
  const r2 = run('k', { g: 'male', n: '三' }, { k: msg });
  assert.ok(r2.error.includes('有限数字'), r2.error);
});

test('缺失消息只影响对应语言', () => {
  const results = preview('k', {}, [
    { lang: 'zh-CN', messages: {} },
    { lang: 'ja', messages: { k: 'こんにちは' } },
  ]);
  assert.ok(results[0].error.includes('缺失'), results[0].error);
  assert.equal(results[1].text, 'こんにちは');
});

test('无效语言代码只影响对应语言', () => {
  const results = preview('k', {}, [
    { lang: 'not a locale!', messages: { k: 'x' } },
    { lang: 'ja', messages: { k: 'y' } },
  ]);
  assert.ok(results[0].error.includes('无效语言代码'), results[0].error);
  assert.equal(results[1].text, 'y');
});

test('模板错误只影响对应语言', () => {
  const results = preview('k', { n: 1 }, [
    { lang: 'zh-TW', messages: { k: '{n, plural, one{未闭合' } },
    { lang: 'ja', messages: { k: '{n, plural, other{# 件}}' } },
  ]);
  assert.ok(results[0].error.includes('模板错误'), results[0].error);
  assert.equal(results[1].text, '1 件');
});

test('译文块 JSON 解析失败作为该语言失败原因', () => {
  const results = preview('k', {}, [
    { lang: 'zh-TW', error: '译文「zh-TW」不是合法的 JSON：Unexpected token' },
    { lang: 'ja', messages: { k: 'OK' } },
  ]);
  assert.ok(results[0].error.includes('JSON'), results[0].error);
  assert.equal(results[1].text, 'OK');
});

test('select 无匹配选项且缺少 other：该语言报错', () => {
  const r = run('k', { g: 'x' }, { k: '{g, select, male{他}}' });
  assert.ok(r.error.includes('other'), r.error);
});

test('plural 缺少 other 且类别无匹配：该语言报错；有匹配则正常渲染', () => {
  const msg = '{n, plural, one{一条}}';
  assert.equal(run('k', { n: 1 }, { k: msg }, 'en').text, '一条');
  const r = run('k', { n: 5 }, { k: msg }, 'en');
  assert.ok(r.error.includes('other'), r.error);
});

test('非字符串消息值视为模板错误', () => {
  const r = run('k', {}, { k: 42 });
  assert.ok(r.error.includes('不是字符串'), r.error);
});

test('多余参数不影响渲染；结果顺序与输入译文块一致', () => {
  const results = preview('k', { name: 'A', extra: '忽略' }, [
    { lang: 'zh-CN', messages: { k: '你好 {name}' } },
    { lang: 'en', messages: { k: 'Hi {name}' } },
    { lang: 'ja', messages: { k: '{name} さん' } },
  ]);
  assert.deepEqual(
    results.map((r) => `${r.language}:${r.text}`),
    ['zh-CN:你好 A', 'en:Hi A', 'ja:A さん'],
  );
});
