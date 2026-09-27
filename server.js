'use strict';

const path = require('path');
const express = require('express');
const { audit, compareFindings, FINDING_TYPES } = require('./lib/audit');
const { preview } = require('./lib/preview');
const { pseudolocalize } = require('./lib/pseudoloc');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_TRANSLATIONS = 4;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/** 把用户粘贴的 JSON 文本解析为平铺消息对象 */
function parseJsonObject(text, label) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    throw new Error(`${label}不是合法的 JSON：${err.message}`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`${label}必须是平铺的 JSON 对象（消息键 → ICU 字符串）`);
  }
  return obj;
}

app.post('/api/audit', (req, res) => {
  const { baseline, translations } = req.body || {};

  if (typeof baseline !== 'string' || !baseline.trim()) {
    return res.status(400).json({ error: '请粘贴基准消息 JSON' });
  }

  let baselineMessages;
  try {
    baselineMessages = parseJsonObject(baseline, '基准消息');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const validTranslations = [];
  const findings = [];
  const seenLangs = new Set();

  (Array.isArray(translations) ? translations : []).slice(0, MAX_TRANSLATIONS).forEach((t, i) => {
    const lang = String((t && t.lang) || '').trim() || `译文${i + 1}`;
    const text = (t && typeof t.messages === 'string' ? t.messages : '').trim();
    if (!text) return; // 空白块直接忽略
    if (seenLangs.has(lang)) {
      findings.push({ language: lang, key: '（整个文件）', type: 'json', detail: `语言代码「${lang}」重复，请为每份译文填写不同的代码` });
      return;
    }
    seenLangs.add(lang);
    try {
      validTranslations.push({ lang, messages: parseJsonObject(text, `译文「${lang}」`) });
    } catch (err) {
      findings.push({ language: lang, key: '（整个文件）', type: 'json', detail: err.message });
    }
  });

  if (!validTranslations.length && !findings.length) {
    return res.status(400).json({ error: '请至少填写一份译文 JSON 和语言代码' });
  }

  findings.push(...audit(baselineMessages, validTranslations));
  findings.sort(compareFindings);

  const summary = {};
  for (const f of findings) summary[f.type] = (summary[f.type] || 0) + 1;

  res.json({ findings, summary, types: FINDING_TYPES });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

/**
 * 伪本地化：读取基准 JSON，逐键生成字面文本膨胀的伪译文（结构与原消息一致）。
 * 单键语法错误只跳过该键并在 skipped 中给出键名与原因，其余键照常生成。
 */
app.post('/api/pseudolocalize', (req, res) => {
  const { baseline } = req.body || {};

  if (typeof baseline !== 'string' || !baseline.trim()) {
    return res.status(400).json({ error: '请粘贴基准消息 JSON' });
  }

  let baselineMessages;
  try {
    baselineMessages = parseJsonObject(baseline, '基准消息');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const { messages, skipped } = pseudolocalize(baselineMessages);
  res.json({
    messages: JSON.stringify(messages, null, 2),
    count: Object.keys(messages).length,
    skipped,
  });
});

/**
 * 消息实例预览：从基准选一个键，用一份参数值按各译文语言渲染。
 * 逐语言返回实际文本或失败原因，互不影响；不改动审计结果。
 */
app.post('/api/preview', (req, res) => {
  const { baseline, key, values, translations } = req.body || {};

  if (typeof baseline !== 'string' || !baseline.trim()) {
    return res.status(400).json({ error: '请粘贴基准消息 JSON' });
  }

  let baselineMessages;
  try {
    baselineMessages = parseJsonObject(baseline, '基准消息');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (typeof key !== 'string' || !key) {
    return res.status(400).json({ error: '请选择要预览的消息键' });
  }
  if (!(key in baselineMessages)) {
    return res.status(400).json({ error: `基准中不存在消息键「${key}」` });
  }

  let parsedValues = {};
  const valuesText = typeof values === 'string' ? values.trim() : '';
  if (valuesText) {
    try {
      parsedValues = JSON.parse(valuesText);
    } catch (err) {
      return res.status(400).json({ error: `参数值不是合法的 JSON：${err.message}` });
    }
    if (!parsedValues || typeof parsedValues !== 'object' || Array.isArray(parsedValues)) {
      return res.status(400).json({ error: '参数值必须是 JSON 对象（参数名 → 值）' });
    }
  }

  const blocks = [];
  (Array.isArray(translations) ? translations : []).slice(0, MAX_TRANSLATIONS).forEach((t, i) => {
    const lang = String((t && t.lang) || '').trim() || `译文${i + 1}`;
    const text = (t && typeof t.messages === 'string' ? t.messages : '').trim();
    if (!text) return; // 空白块直接忽略
    try {
      blocks.push({ lang, messages: parseJsonObject(text, `译文「${lang}」`) });
    } catch (err) {
      blocks.push({ lang, error: err.message }); // JSON 解析失败只影响该语言
    }
  });

  if (!blocks.length) {
    return res.status(400).json({ error: '请至少填写一份译文 JSON 和语言代码' });
  }

  res.json({ results: preview(key, parsedValues, blocks) });
});

app.listen(PORT, () => {
  console.log(`ICU 消息审计工具已启动：http://localhost:${PORT}`);
});
