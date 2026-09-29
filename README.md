# ICU 多语言消息审计

本地运行的多语言消息审计工具：粘贴一份基准和 1～4 份译文 JSON（均为**消息键 → ICU MessageFormat 字符串**的平铺对象），逐键比对并报告差异；还可以选一个消息键、输入一份参数值，按各译文语言**实际渲染**并并排预览。页面上另有「伪本地化」模块：读取当前基准 JSON，生成文案膨胀约 1.5 倍的可复制伪译文 JSON，用于检查文案膨胀后的界面。数据不出本机。

技术栈：Node.js + Express + [`@formatjs/icu-messageformat-parser`](https://formatjs.github.io/docs/icu-messageformat-parser/)（审计解析）+ [`intl-messageformat`](https://formatjs.github.io/docs/intl-messageformat/)（实例渲染），前端为原生 HTML/CSS/JS，无构建步骤。

## 快速开始

### 方式一：Docker Compose（推荐）

```bash
docker compose up --build
```

### 方式二：纯 Docker

```bash
docker build -t icu-audit .
docker run --rm -p 3000:3000 icu-audit
```

### 方式三：本地 Node.js（≥ 18）

```bash
npm install
npm start
```

启动后打开 **http://localhost:3000**。

## 使用说明

1. 在「基准消息」中粘贴基准 JSON，例如：
   ```json
   {
     "app.title": "消息审计台",
     "inbox.summary": "{name}，你有 {count, plural, =0{没有新消息} other{# 条新消息}}。"
   }
   ```
2. 为每份译文（1～4 份）填写**语言代码**（如 `zh-CN`、`ja`）并粘贴译文 JSON。
3. 点击「开始审计」。也可以先点「填入示例」查看演示效果（示例数据同时存放在 `examples/` 目录）。
4. 结果按**语言 → 消息键**排序，可用下拉框或点击统计徽章**按错误类型筛选**。
5. 需要看某条消息的实际效果时，用下方的「消息实例预览」：选一个消息键、填一份参数值 JSON，点击「渲染预览」，即可按各译文语言并排查看渲染结果（见下一节）。
6. 想检查文案膨胀后的界面时，用「伪本地化」面板（见下文），一键生成伪译文 JSON，可直接复制或填入一个译文块，继续走审计与预览流程。

## 伪本地化

审计页「译文」与「开始审计」之间的 **伪本地化（Pseudolocalization）** 面板读取**当前基准编辑区**的 JSON，逐键解析 ICU MessageFormat 并生成可复制的伪译文 JSON：

- 每段**非空白字面文本**按 Unicode 字素（grapheme cluster，含组合字符、emoji ZWJ 序列）扩到**至少原长的 1.5 倍**：依原顺序循环追加本段的非空白字素，并在段首尾加 `⟦⟧`（如 `消息审计台` → `⟦消息审计台消息审⟧`）；**纯空白段原样保留**。
- 只改字面文本，**参数名与格式（number / date / time 的 style、skeleton）、`select` / `plural` / `selectordinal` 的选项名与 `offset`、显式 `=n`、复数 `#`、富文本标签、撇号（`'`）引用语义全部保留**；字面量里可能被误读为特殊符号的字符（`{` `}` `<` `>` 及复数分支内的 `#`）会用撇号引用，撇号本身翻倍。
- 生成的消息**保证能再次解析**，且去掉字面文本后与原消息结构完全一致。
- **单键语法错误（或非字符串值）只跳过该键**，结果状态行列出被跳过的键名与原因，其余键照常生成。

操作：点击「生成伪译文」→「复制 JSON」，或点「填入译文块（en-XA）」自动放入一个语言代码为 `en-XA` 的译文块（优先复用已有 `en-XA` 块，其次第一个空块，否则新建；达到 4 份上限时需先空出一块）。填入后可直接「开始审计」（伪译文与基准结构一致，不应出现结构类差异），或在「消息实例预览」中选键渲染，直观看到文案膨胀后的排版效果。

## 审计规则

| 错误类型 | 说明 |
| --- | --- |
| 缺失消息 | 键存在于基准、不存在于译文 |
| 额外消息 | 键存在于译文、不存在于基准（该键若有语法错误会一并报告） |
| 语法错误 | 消息不是合法 ICU MessageFormat（含非字符串值）；基准与译文都会检查 |
| JSON 解析失败 | 整个文件不是合法 JSON / 不是平铺对象 / 语言代码重复 |
| 参数签名不一致 | 递归解析 `select` / `plural` / `selectordinal` 分支后，参数名或用法类型（普通、number、date、time、select、plural、selectordinal）与基准不同；译文在某结构路径整处新增/删除同名同类型分支节点（其余节点选项均完整）时，也按双侧数量差报此项 |
| 同名参数混用 | 同一消息内同一参数名以多种用法类型出现（基准与译文都会检查） |
| select 选项不一致 | 同一结构路径下该 `select` 的选项名集合与基准不一致 |
| 复数 =n 选项不一致 | 同一结构路径下该 `plural` / `selectordinal` 的显式 `=n` 选项与基准不一致 |
| 缺少 other 分支 | 复数类参数的每一处分支都需有 `other`（复数语言类别 zero/one/two/few/many 允许与基准不同） |

每条发现都会标明**语言、消息键、错误类型和差异详情**；分支类差异的详情中带「位置」，如 `g(select)=male › n(plural)（第 2 处）`。

### 结构路径与整处增删核对

- 结构路径覆盖**消息顶层**及**祖先全部为 `select`** 的 `select` / `plural` / `selectordinal` 节点（位于 `plural` 分支之下的节点暂不按结构路径核对，但仍参与参数与 `other` 自检）。
- 路径由各祖先的**参数名、类型、同层同名同类型出现序号和选项名**组成；选项的书写顺序不改变路径。
- 按**路径 + 当前参数名 + 类型**归组，核对基准与译文两侧的节点数量：不同路径的一增一减**不能相互抵消**。数量差计入「参数签名不一致」，详情列出语言、消息键、路径与基准、译文数量，如「路径 `g(select)=female › n(plural)`，n（plural）基准 1 处、译文 0 处」。
- 数量一致的已配对节点继续逐处检查 `select` 选项、显式 `=n` 和 `other`；其中复数语言类别仍可随语言变化。同层出现多对同名同类型节点时按出现序号一一配对。
- 若某参数名在一侧整体不存在（或类型已改变），只报参数名/用法差异，不重复报数量。

## 消息实例预览

审计页下方的「消息实例预览」用 [`intl-messageformat`](https://formatjs.github.io/docs/intl-messageformat/) 把一条消息**实际渲染**出来，便于确认参数在各语言下的真实效果。操作步骤：

1. 启动服务后打开 **http://localhost:3000**，先在「基准消息」编辑区粘贴基准 JSON —— 预览面板的**消息键下拉框**会随之列出其中的键（编辑后自动刷新）。
2. 选择一个消息键，在参数值框中输入一份 **JSON 对象**（参数名 → 值）。
3. 点击「渲染预览」：按各译文语言代码渲染该键在**各译文**中的 ICU 文本，结果表并排显示**语言、实际文本、失败原因**。

参数值类型规则（按各语言模板中**实际走到的分支**逐一校验，未走到的分支不校验）：

| 参数用法 | 参数值要求 |
| --- | --- |
| 普通占位符、select | 字符串 |
| number、plural、selectordinal | 有限数字（`NaN` / `Infinity` 视为类型不符） |
| date、time | 带时区的 ISO 8601 字符串（如 `2026-09-27T10:00:00+08:00`），渲染前转成日期 |

渲染语义：

- 支持普通占位符、`number`、`date`、`time`、`select`、`plural`、`selectordinal` 及任意嵌套分支；`select` 无匹配选项时回退 `other`，复数类先匹配显式 `=n`，否则按**该语言自身的复数规则**（`Intl.PluralRules`）选类别。
- 数字、百分比、日期、时间均按**各语言自身的格式**输出（`Intl.NumberFormat` / `Intl.DateTimeFormat`）。
- 实际走到的分支里**缺值或类型不符**时，该语言行报具体原因；某一语言**缺失消息、语言代码无效或模板错误**只影响该语言行，其余语言照常渲染。
- 预览读取的是编辑区**最新内容**（无需先审计），结果显示在独立区域，**不会覆盖审计发现**。

## 项目结构

```
├── server.js            # Express 服务：静态页面 + POST /api/audit + /api/preview + /api/pseudolocalize
├── lib/audit.js         # 审计核心：ICU 解析、签名提取与比对
├── lib/preview.js       # 预览核心：按语言渲染消息实例（分支模拟、值校验、intl-messageformat）
├── lib/pseudoloc.js     # 伪本地化核心：逐键解析 ICU，按字素膨胀字面文本并保留全部结构
├── public/              # 原生前端（index.html / app.js / style.css）
├── test/                # 单元测试（node:test）：audit / preview / pseudoloc
├── examples/            # 示例基准与译文
├── Dockerfile
└── docker-compose.yml
```

## 测试

```bash
npm test
```

## API

`POST /api/audit`

```json
{
  "baseline": "{\"a\":\"你好 {name}\"}",
  "translations": [
    { "lang": "ja", "messages": "{\"a\":\"こんにちは {name}\"}" }
  ]
}
```

响应：`{ findings: [{ language, key, type, detail }], summary: { <type>: <count> }, types: { <type>: 中文标签 } }`，`findings` 已按语言、键排序。

`POST /api/preview`

```json
{
  "baseline": "{\"a\":\"你好 {name}\"}",
  "key": "a",
  "values": "{\"name\":\"小明\"}",
  "translations": [
    { "lang": "ja", "messages": "{\"a\":\"こんにちは {name}\"}" }
  ]
}
```

响应：`{ results: [{ language, text } | { language, error }] }`，顺序与译文块一致；`key` 必须存在于基准中，`values` 省略时按空对象处理。

`POST /api/pseudolocalize`

```json
{
  "baseline": "{\"a\":\"你好 {name}\",\"bad\":\"未闭合 {x\"}"
}
```

响应：`{ messages: { <key>: <伪译文 ICU 字符串> }, skipped: [{ key, error }], count }`。`messages` 为可复制的平铺 JSON（跳过语法错误 / 非字符串的键），生成的每条消息均可再次解析且结构与原消息一致。
