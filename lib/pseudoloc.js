'use strict';

const { parse, TYPE } = require('@formatjs/icu-messageformat-parser');

/** 伪译文默认使用的语言代码（Android 风格伪本地化标签，可被前端覆盖） */
const PSEUDO_LOCALE = 'en-XA';

/** 包裹膨胀后字面文本的括号 */
const OPEN_BRACKET = '⟦'; // U+27E6
const CLOSE_BRACKET = '⟧'; // U+27E7

/** 按 Unicode 字素（grapheme cluster）切分；Node 20 / 现代浏览器均支持 Intl.Segmenter */
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** 把字符串拆成 Unicode 字素数组 */
function toGraphemes(text) {
  const out = [];
  for (const { segment } of segmenter.segment(text)) out.push(segment);
  return out;
}

/** 字素簇是否为纯空白（含全角空格、不间断空格等 \s 覆盖的空白） */
const isWhitespaceGrapheme = (g) => /^\s$/u.test(g);

/**
 * 把重新生成的字面文本按 ICU MessageFormat 字面量规则转义。
 * - 撇号一律翻倍（''），兼容原消息里未成对的宽松写法；
 * - { } < > 用撇号引用，避免被识别为参数 / 富文本标签；
 * - # 仅在 plural / selectordinal 分支内需要引用（分支外 # 是普通字符）。
 */
function escapeIcuText(text, inPlural) {
  let out = '';
  for (const ch of text) {
    if (ch === "'") {
      out += "''";
    } else if (
      ch === '{' ||
      ch === '}' ||
      ch === '<' ||
      ch === '>' ||
      (inPlural && ch === '#')
    ) {
      out += `'${ch}'`;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * 处理一个字面量节点的文本：
 * 按字素切成「纯空白段」与「非空白段」——纯空白段原样保留；
 * 每个非空白段在首尾加 ⟦⟧，并依原顺序循环追加本段的非空白字素，
 * 使段内字素数至少为原长的 1.5 倍（⌈n/2⌉ 个追加字素）。
 */
function pseudoLiteral(text, inPlural) {
  // 按字素聚合成连续的 空白 / 非空白 段
  const runs = [];
  let current = null;
  for (const g of toGraphemes(text)) {
    const ws = isWhitespaceGrapheme(g);
    if (!current || current.ws !== ws) {
      current = { ws, graphemes: [] };
      runs.push(current);
    }
    current.graphemes.push(g);
  }

  let out = '';
  for (const run of runs) {
    const raw = run.graphemes.join('');
    if (run.ws) {
      out += raw; // 纯空白段原样保留
      continue;
    }
    const n = run.graphemes.length;
    const extra = Math.ceil(n / 2); // n + ⌈n/2⌉ ≥ 1.5n
    let inner = raw;
    for (let i = 0; i < extra; i++) {
      inner += run.graphemes[i % n]; // 依原顺序循环追加
    }
    out += OPEN_BRACKET + escapeIcuText(inner, inPlural) + CLOSE_BRACKET;
  }
  return out;
}

/**
 * 遍历一层消息元素，收集所有字面量节点的「源区间 → 伪译文」替换记录。
 * 只替换字面量节点（TYPE.literal）的源文本区间，其余字符（参数名与格式、
 * select / plural / selectordinal 的选项名与 offset、显式 =n、复数 #、标签等）
 * 全部保持源文原样。
 *
 * @param inPlural 当前层是否位于 plural / selectordinal 分支之内
 *   （# 在该上下文是特殊符号，字面量里的 # 需撇号引用）
 */
function collectLiteralReplacements(elements, inPlural, replacements) {
  for (const el of elements) {
    switch (el.type) {
      case TYPE.literal:
        replacements.push({
          start: el.location.start.offset,
          end: el.location.end.offset,
          text: pseudoLiteral(el.value, inPlural),
        });
        break;
      case TYPE.select:
        for (const option of Object.values(el.options)) {
          collectLiteralReplacements(option.value, inPlural, replacements);
        }
        break;
      case TYPE.plural:
        // 进入复数分支后，内层（含嵌套 select）的字面 # 都是特殊字符
        for (const option of Object.values(el.options)) {
          collectLiteralReplacements(option.value, true, replacements);
        }
        break;
      case TYPE.tag:
        collectLiteralReplacements(el.children, inPlural, replacements);
        break;
      default:
        break; // argument / number / date / time / pound 等无字面量
    }
  }
}

/**
 * 解析并伪本地化单条消息。
 * @param {string} value 基准 ICU MessageFormat 字符串
 * @returns {{ text?: string, error?: string }}
 */
function pseudoLocalizeMessage(value) {
  if (typeof value !== 'string') {
    return { error: `消息值不是字符串（实际为 ${Array.isArray(value) ? '数组' : typeof value}）` };
  }

  let ast;
  try {
    // captureLocation:true —— 取字面量节点在源文中的 UTF-16 区间；
    // requiresOtherClause:false —— 与审计一致，缺 other 不算语法错误
    ast = parse(value, {
      requiresOtherClause: false,
      shouldParseSkeletons: false,
      captureLocation: true,
    });
  } catch (err) {
    return { error: err.message };
  }

  const replacements = [];
  collectLiteralReplacements(ast, false, replacements);

  // 从后往前替换，前面区间的偏移量不受影响
  let text = value;
  for (const r of replacements.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, r.start) + r.text + text.slice(r.end);
  }

  // 防御性自检：生成结果必须能再次解析（正常情况下不会失败）
  try {
    parse(text, { requiresOtherClause: false, shouldParseSkeletons: false });
  } catch (err) {
    return { error: `伪译文无法再次解析：${err.message}` };
  }

  return { text };
}

/**
 * 伪本地化入口：逐键处理基准消息，语法错误 / 非字符串的键跳过并记录。
 * @param {Object<string,string>} messages 基准消息（已解析的 JSON 对象）
 * @returns {{ output: Object<string,string>, skipped: Array<{key:string, error:string}> }}
 */
function pseudoLocalize(messages) {
  const output = {};
  const skipped = [];
  for (const [key, value] of Object.entries(messages)) {
    const result = pseudoLocalizeMessage(value);
    if (result.error) {
      skipped.push({ key, error: result.error });
    } else {
      output[key] = result.text;
    }
  }
  return { output, skipped };
}

module.exports = {
  pseudoLocalize,
  pseudoLocalizeMessage,
  pseudoLiteral,
  toGraphemes,
  PSEUDO_LOCALE,
};
