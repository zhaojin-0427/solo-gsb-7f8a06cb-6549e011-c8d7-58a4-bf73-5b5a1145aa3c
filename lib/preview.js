'use strict';

const IntlMessageFormat = require('intl-messageformat').default;
const { parse, TYPE } = require('@formatjs/icu-messageformat-parser');
const { USAGE_LABELS } = require('./audit');

/**
 * date/time 参数值要求：带时区的 ISO 8601 字符串，
 * 如 2026-09-27T10:00:00+08:00 或 2026-09-27T02:00:00Z。
 */
const ISO_WITH_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/** 值的简要描述，用于类型不符的报错 */
function describeValue(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return '数组';
  switch (typeof v) {
    case 'string': return `字符串「${v}」`;
    case 'number': return Number.isFinite(v) ? `数字 ${v}` : `非有限数字 ${v}`;
    case 'boolean': return `布尔值 ${v}`;
    case 'object': return '对象';
    default: return typeof v;
  }
}

/**
 * 按用法类型校验并转换单个参数值：
 * 普通 / select 为字符串，number / 复数类为有限数字，
 * date / time 为带时区的 ISO 8601 字符串（转换为 Date）。
 * 失败时向 errors 追加说明并返回 undefined。
 */
function coerceValue(name, usage, raw, errors) {
  const label = USAGE_LABELS[usage] || usage;
  switch (usage) {
    case 'plain':
    case 'select':
      if (typeof raw !== 'string') {
        errors.push(`参数「${name}」（${label} 用法）应为字符串，实际为${describeValue(raw)}`);
        return undefined;
      }
      return raw;
    case 'number':
    case 'plural':
    case 'selectordinal':
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        errors.push(`参数「${name}」（${label} 用法）应为有限数字，实际为${describeValue(raw)}`);
        return undefined;
      }
      return raw;
    case 'date':
    case 'time': {
      if (typeof raw !== 'string' || !ISO_WITH_TZ.test(raw)) {
        errors.push(`参数「${name}」（${label} 用法）应为带时区的 ISO 8601 字符串（如 2026-09-27T10:00:00+08:00），实际为${describeValue(raw)}`);
        return undefined;
      }
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) {
        errors.push(`参数「${name}」的日期「${raw}」无法解析`);
        return undefined;
      }
      return d;
    }
    default:
      return raw;
  }
}

/**
 * 按参数值模拟模板的分支选择，只校验「实际走到的」分支里的参数：
 * select 按值选选项（无匹配回退 other）；plural / selectordinal 先匹配显式 =n，
 * 否则用该语言自身的 Intl.PluralRules 计算类别（类别按扣除 offset 后的值）。
 * 未走到的分支里的参数不校验；缺值或类型不符逐条记入 errors。
 *
 * @returns {{ converted: Object, errors: string[] }}
 *   converted 为可直接传给 IntlMessageFormat#format 的值（date/time 已转为 Date）。
 */
function evaluateTemplate(ast, values, locale) {
  const errors = [];
  const INVALID = Symbol('invalid');
  const cache = new Map(); // usage -> Map(name -> 转换后的值 | INVALID)，避免同名同用法重复报错

  const useParam = (name, usage) => {
    let byName = cache.get(usage);
    if (!byName) {
      byName = new Map();
      cache.set(usage, byName);
    }
    if (byName.has(name)) {
      const hit = byName.get(name);
      return hit === INVALID ? undefined : hit;
    }
    let coerced;
    if (!Object.prototype.hasOwnProperty.call(values, name)) {
      errors.push(`缺少参数「${name}」的值（${USAGE_LABELS[usage] || usage} 用法）`);
      coerced = INVALID;
    } else {
      const v = coerceValue(name, usage, values[name], errors);
      coerced = v === undefined ? INVALID : v;
    }
    byName.set(name, coerced);
    return coerced === INVALID ? undefined : coerced;
  };

  /** 显式 =n 选项按数值匹配（源文本写法可能带小数点，如 =1.0） */
  const findExact = (options, n) => {
    for (const optName of Object.keys(options)) {
      if (optName.startsWith('=') && Number(optName.slice(1)) === n) return options[optName];
    }
    return null;
  };

  const walk = (elements) => {
    for (const el of elements) {
      switch (el.type) {
        case TYPE.argument: useParam(el.value, 'plain'); break;
        case TYPE.number: useParam(el.value, 'number'); break;
        case TYPE.date: useParam(el.value, 'date'); break;
        case TYPE.time: useParam(el.value, 'time'); break;
        case TYPE.select: {
          const v = useParam(el.value, 'select');
          if (v === undefined) break; // 值缺失/类型不符：无法确定分支，错误已记录
          const option = el.options[v] || el.options.other;
          if (option) walk(option.value);
          else errors.push(`select 参数「${el.value}」的值「${v}」没有匹配的选项，且该处缺少 other 分支`);
          break;
        }
        case TYPE.plural: {
          const kind = el.pluralType === 'ordinal' ? 'selectordinal' : 'plural';
          const v = useParam(el.value, kind);
          if (v === undefined) break;
          let option = findExact(el.options, v);
          if (!option) {
            const category = new Intl.PluralRules(locale, {
              type: el.pluralType === 'ordinal' ? 'ordinal' : 'cardinal',
            }).select(v - (el.offset || 0));
            option = el.options[category] || el.options.other;
          }
          if (option) walk(option.value);
          else errors.push(`复数参数「${el.value}」的值 ${v} 没有匹配的分支，且该处缺少 other 分支`);
          break;
        }
        case TYPE.tag:
          walk(el.children);
          break;
        default:
          break; // literal / pound 无需处理
      }
    }
  };

  walk(ast);

  const converted = { ...values };
  for (const [usage, byName] of cache) {
    if (usage !== 'date' && usage !== 'time') continue;
    for (const [name, v] of byName) {
      if (v !== INVALID) converted[name] = v;
    }
  }
  return { converted, errors };
}

/**
 * 渲染单个语言的该键消息；任何问题只影响本语言的结果。
 * @returns {{ language: string, text?: string, error?: string }}
 */
function renderOne(lang, messages, key, values) {
  let locale;
  try {
    locale = Intl.getCanonicalLocales(lang)[0];
  } catch {
    return { language: lang, error: `无效语言代码「${lang}」` };
  }

  if (!Object.prototype.hasOwnProperty.call(messages, key)) {
    return { language: lang, error: '该语言缺失此消息' };
  }
  const message = messages[key];
  if (typeof message !== 'string') {
    return { language: lang, error: `消息值不是字符串（实际为 ${Array.isArray(message) ? '数组' : typeof message}）` };
  }

  let ast;
  try {
    ast = parse(message, { requiresOtherClause: false, shouldParseSkeletons: false });
  } catch (err) {
    return { language: lang, error: `模板错误：${err.message}` };
  }

  const { converted, errors } = evaluateTemplate(ast, values, locale);
  if (errors.length) {
    return { language: lang, error: errors.join('；') };
  }

  try {
    const mf = new IntlMessageFormat(message, locale, undefined, {
      requiresOtherClause: false,
      shouldParseSkeletons: false,
    });
    return { language: lang, text: String(mf.format(converted)) };
  } catch (err) {
    return { language: lang, error: `渲染失败：${err.message}` };
  }
}

/**
 * 预览入口：按各译文语言代码渲染同一消息键，逐语言给出实际文本或失败原因。
 * @param {string} key 基准中选中的消息键
 * @param {Object} values 参数值（已解析的 JSON 对象）
 * @param {Array<{lang:string, messages?:Object, error?:string}>} blocks
 *   译文块；error 为该块 JSON 解析失败信息（直接作为该语言失败原因）
 * @returns {Array<{language:string, text?:string, error?:string}>} 顺序与输入译文块一致
 */
function preview(key, values, blocks) {
  return blocks.map((block) => {
    if (block.error) return { language: block.lang, error: block.error };
    return renderOne(block.lang, block.messages || {}, key, values || {});
  });
}

module.exports = { preview, evaluateTemplate, ISO_WITH_TZ };
