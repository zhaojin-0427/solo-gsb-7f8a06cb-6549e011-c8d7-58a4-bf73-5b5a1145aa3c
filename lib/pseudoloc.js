'use strict';

const { parse, TYPE } = require('@formatjs/icu-messageformat-parser');

/** 段首 / 段尾包裹符 */
const OPEN_MARK = '⟦';
const CLOSE_MARK = '⟧';

/** 字面文本膨胀倍率：每段至少扩到原长的 1.5 倍（按 Unicode 字素计） */
const EXPANSION_RATIO = 1.5;

/** Unicode 空白（u 标志下 \s 匹配全部 White_Space 字符） */
const WHITESPACE_RE = /\s/u;

/** 字素切分器（模块级复用；und 语言与中立的字素规则即可） */
const graphemeSegmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

/** 按 Unicode 字素（grapheme cluster）切分，emoji 序列、组合字符均算一个字素 */
function graphemesOf(text) {
  return Array.from(graphemeSegmenter.segment(text), (s) => s.segment);
}

/**
 * 把一段非空白字面文本膨胀到至少原长的 1.5 倍（按字素计）：
 * 在段尾依原顺序循环追加段内的非空白字素，最后在段首尾加 ⟦ ⟧。
 */
function expandSegment(value) {
  const chars = graphemesOf(value);
  const nonBlank = chars.filter((c) => !WHITESPACE_RE.test(c));
  const target = Math.ceil(chars.length * EXPANSION_RATIO);
  let expanded = value;
  for (let len = chars.length, i = 0; len < target; len += 1, i += 1) {
    expanded += nonBlank[i % nonBlank.length];
  }
  return OPEN_MARK + expanded + CLOSE_MARK;
}

/**
 * 把膨胀后的字面文本重新转义为 ICU 源文本，保持撇号引用语义。
 *
 * 规则（与解析器 tryParseQuote 对应）：
 * - 可引用字符 { } < >（以及复数上下文中的 #）组成「引用段」用撇号包裹；
 *   夹在段内的撇号双写。段取极大：相邻的可引用字符与撇号并入同一段，
 *   避免两个引用段直接相邻（'{' + '}' 拼成 '{''}' 会被解析为 {'} 而非 {}）。
 * - 不与可引用字符相邻的孤立撇号在段外双写（''）。
 * - poundContext 为 true（直接位于 plural / selectordinal 选项内、中间只隔标签）时
 *   # 必须引用，否则会被解析为复数 #；其它上下文中 # 不是特殊字符，原样输出。
 */
function escapeLiteral(text, poundContext) {
  const isQuotable = (ch) =>
    ch === '{' || ch === '}' || ch === '<' || ch === '>' || (poundContext && ch === '#');
  const n = text.length;
  let out = '';
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (isQuotable(ch)) {
      // 极大引用段：连续可引用字符，以及后面仍跟着可引用字符的撇号串
      let segment = '';
      let j = i;
      while (j < n) {
        if (isQuotable(text[j])) {
          segment += text[j];
          j += 1;
        } else if (text[j] === "'") {
          let k = j;
          while (k < n && text[k] === "'") k += 1;
          if (k < n && isQuotable(text[k])) {
            segment += "''".repeat(k - j); // 段内撇号双写
            j = k;
          } else {
            break; // 尾部孤立撇号：留到段外处理
          }
        } else {
          break;
        }
      }
      out += `'${segment}'`;
      i = j;
    } else if (ch === "'") {
      out += "''";
      i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/**
 * 收集 AST 中全部字面元素及其复数上下文标记。
 * poundContext 与解析器行为一致：进入 plural / selectordinal 选项后为 true，
 * 进入 select 选项后重置为 false，标签原样透传。
 */
function collectLiterals(elements, poundContext, out) {
  for (const el of elements) {
    switch (el.type) {
      case TYPE.literal:
        out.push({ el, poundContext });
        break;
      case TYPE.select:
        for (const opt of Object.values(el.options)) collectLiterals(opt.value, false, out);
        break;
      case TYPE.plural: // plural 与 selectordinal 同为 TYPE.plural
        for (const opt of Object.values(el.options)) collectLiterals(opt.value, true, out);
        break;
      case TYPE.tag:
        collectLiterals(el.children, poundContext, out);
        break;
      default:
        break; // argument / number / date / time / pound 没有子元素
    }
  }
}

/**
 * 伪本地化单条 ICU 消息：只改写字面文本的源区间，其余内容（参数名与格式、
 * 选项名、offset、显式 =n、复数 #、标签、撇号引用）逐字节保留，
 * 因此生成消息可再次解析，且去掉字面文本后结构与原消息一致。
 * 解析失败时抛错，由调用方按键跳过。
 */
function pseudolocalizeMessage(message) {
  const ast = parse(message, {
    captureLocation: true,
    requiresOtherClause: false,
    shouldParseSkeletons: false,
  });
  const literals = [];
  collectLiterals(ast, false, literals);

  let out = message;
  // 自后向前替换，前面区间的偏移不受影响
  for (let i = literals.length - 1; i >= 0; i -= 1) {
    const { el, poundContext } = literals[i];
    if (!el.location || typeof el.value !== 'string' || !el.value) continue;
    // 纯空白段原样保留
    if (!graphemesOf(el.value).some((g) => !WHITESPACE_RE.test(g))) continue;
    const replacement = escapeLiteral(expandSegment(el.value), poundContext);
    out = out.slice(0, el.location.start.offset) + replacement + out.slice(el.location.end.offset);
  }
  return out;
}

/**
 * 伪本地化整份消息对象：逐键处理；单键失败（语法错误、非字符串值）
 * 记入 skipped 并跳过，其余键照常生成。
 * @param {Object<string,string>} messages 基准消息（已解析的 JSON 对象）
 * @returns {{ messages: Object<string,string>, skipped: Array<{key:string, error:string}> }}
 */
function pseudolocalize(messages) {
  const generated = {};
  const skipped = [];
  for (const [key, value] of Object.entries(messages)) {
    if (typeof value !== 'string') {
      skipped.push({ key, error: `消息值不是字符串（实际为 ${Array.isArray(value) ? '数组' : typeof value}）` });
      continue;
    }
    try {
      generated[key] = pseudolocalizeMessage(value);
    } catch (err) {
      skipped.push({ key, error: err.message });
    }
  }
  return { messages: generated, skipped };
}

module.exports = {
  pseudolocalize,
  pseudolocalizeMessage,
  expandSegment,
  escapeLiteral,
  graphemesOf,
  OPEN_MARK,
  CLOSE_MARK,
  EXPANSION_RATIO,
};
