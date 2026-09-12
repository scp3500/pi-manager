# 提示词结构（`#/promptmap`）

把 pi 实际发给模型的**系统提示词**拆开给你看：每个区块占多少 token、内容是什么、由哪个文件产生、
一次请求还要额外带上多少工具定义。用来回答「我这轮到底塞了多少东西进去」。

入口：导航「更多 → 提示词结构」，或提示词编辑页右上角的「结构分析」。
页面：`public/promptmap-ui.js` + `public/style.css` 的 `/* === prompt map === */` 分区。
后端：`lib/prompt-structure.js`，路由 `GET /api/prompt-structure`。

---

## 1. 为什么不能"照着文件算"

系统提示词不是把 `AGENTS.md` 拼起来那么简单。pi 的 `buildSystemPrompt()` 有固定拼装顺序，
每个区块带**确定的标记**，所以只要按标记切分，归因就是精确的，不用启发式：

| 顺序 | 区块 | 起止标记 | 来源 |
|---:|---|---|---|
| 0 | 扩展前置块 | `<!-- prompt-prefix:start -->` … `end -->` | `before_agent_start` 钩子（见 §3） |
| 1 | 自定义提示词 **或** 内置基础提示词 | 字符串开头 | `<cwd>/.pi/SYSTEM.md` > `~/.pi/agent/SYSTEM.md`（替换内置） |
| 2 | 追加提示词 | `\n\n` + 追加文本 | `<cwd>/.pi/APPEND_SYSTEM.md` > `~/.pi/agent/APPEND_SYSTEM.md` |
| 3 | 项目上下文 | `\n\n<project_context>\n\n` … `</project_context>\n` | AGENTS.md 类文件（见 §4） |
| 4 | 技能清单 | `\n\nThe following skills provide…` … `</available_skills>` | 技能目录（见 §5） |
| 5 | 工作目录尾注 | `\nCurrent working directory: `（取最后一次出现） | 固定 |

后端**复用 pi 自己的实现**，不重写：`buildSystemPrompt()`、`loadProjectContextFiles()`、
`loadSkills()`、各工具的 `ToolSystemPromptContribution`（snippet 与 guidelines）。
这些通过绝对路径动态 `import()` pi 包内的 `dist/*.js`（`lib/pi-package.js` 负责定位）。

切完还有一道**自检**：所有区块字符数之和必须等于提示词总长，否则该页头部会显示
「切分自检未通过」并在体检里给出未归因字符数。正常应始终一致。

---

## 2. 两种 token 口径

页面同时给两个数，因为 pi 和真实 tokenizer 不是一个算法：

| 口径 | 算法 | 用在哪 |
|---|---|---|
| **pi 口径** | `Math.ceil(chars / 4)`，不分中英文（pi 的 `estimateTextTokens`） | pi 状态栏 / 上下文占用；要和 pi 对上就看这个 |
| **加权** | ASCII 4 字符 / token，CJK 与全角 1.5 字符 / token | 中文偏多的提示词更接近真实值 |

同一份 19,880 字符的提示词：pi 口径 4,970，加权 6,590，真实值在两者之间偏加权。
页面头图的**主数字是加权**，下面一行给 `pi 口径`，区块列表与图例都按加权算占比。

---

## 3. `prompt-prefix` 扩展：为什么它在最前面

`~/.pi/agent/extensions/prompt-prefix` 在 `before_agent_start` 里拿到**已经拼好的**字符串，
然后返回 `result.text + '\n\n' + event.systemPrompt` —— 前置拼接，所以它排在一切之前，
连内置基础提示词都在它后面。

页面是**精确计入**它的，不是估的：它的 `lib.ts` 零 pi 依赖，后端直接 `import` 并调用它的
`buildBlock(true)`，拿真实产物，再按它的 `separator` 拆出每个注入文件（每个文件成为可展开的
子块）。它自己的开关（`~/.pi/docs/prompt-prefix.json` 的 `enabled` / 单文件开关）会体现在
「扩展改写」卡片里。

其它扩展若也在 `before_agent_start` 里改 `systemPrompt`，`detectPromptHooks()` 会把它们列出来
并标「未计入」——要精确计入得跑 pi 的扩展 runner，本页不做（见 §8）。

---

## 4. 上下文文件（AGENTS.md 类）

发现规则与 pi 一致（`loadProjectContextFiles`）：

- `~/.pi/agent/`（全局）先注入；
- 然后从 `<cwd>` **逐级向上**到根，每级目录取**一个**文件，候选顺序
  `AGENTS.override.md` > `AGENTS.md` > `AGENTS.MD` > `CLAUDE.md` > `CLAUDE.MD`
  （同级里 `AGENTS.override.md` 会顶掉其它几个）；
- 注入顺序 = 祖先在前、`<cwd>` 自己最后 → 越靠后离提示词末尾越近。

页面上按序号列出，并给「注入顺序 = 注意力顺序」的提示。

---

## 5. 技能来源（四处，缺一处就会少算）

只调 `loadSkills({cwd, agentDir, includeDefaults:true})` 会漏掉一半技能。pi 实际还经
package-manager 合入：

1. `~/.pi/agent/skills/*`（agentDir，`includeDefaults`）
2. `<cwd>/.pi/skills/*`（项目，`includeDefaults`）
3. `settings.json` 的 `skills` 数组（本机是 `E:/pi_agent/pi_config/skills`）
4. `~/.agents/skills/*` 与 `<cwd>` 及祖先的 `.agents/skills/*`（Agent Skills 标准目录）

这四条由 `skillSourcePaths()` 合并后传给 `loadSkills({ skillPaths })`，返回值里也带上
`skillSources` 供页面/排障核对（做过去重：cwd 在 HOME 下时第 4 条会与第 2 条重合）。

带 `disable-model-invocation: true` 的技能**不会进提示词**（pi 的 `formatSkillsForPrompt` 过滤），
页面把它们列成灰色的「未注入」，所以「加载 N 个 / 注入 M 个」两个数都会显示。
每个技能还会给出它的 `SKILL.md` 体积与 token 估算——那是**按需读取**才进上下文的量。

---

## 6. 工具定义（内置 + 扩展）

工具定义**不属于系统提示词**，pi 会把它们作为 `tools` 数组随请求单独发送，但估算上下文时算进去，
所以「一次请求的固定开销」必须带上。

- **内置四个**：直接调 pi 的 `createCodingTools(cwd)`，把每个工具的
  `{name, description, parameters}` 序列化后量长度，逐个列出。
- **扩展注册的**：`subagent`、`todo` 等由扩展 `pi.registerTool()` 注册，schema 是 typebox
  在**运行时**生成的，静态读源码只能拿到名字。于是 `lib/extension-tools.js` 起一个**子进程**
  把扩展真的跑一遍：
  1. `lib/probe/register-hooks.mjs` → `prompt-hooks.mjs`：ESM 解析钩子，把
     `@earendil-works/*` 与 `typebox` 指向 pi 自带依赖（`<pkg>/node_modules`，支持
     `./providers/*` 这类通配子路径；pi 包自身单独映射）；
  2. `lib/probe/extension-tools.mjs`：`import` 每个扩展入口并调用它的工厂函数，pi API 用
     Proxy 兜底 noop，只捕获 `registerTool` 的参数；
  3. 只回吐 `{name, chars, hasSchema}`，**不落任何扩展代码**。

安全与稳健：第三方扩展代码只在子进程里执行、25s 超时、结果缓存 5 分钟、失败（或
`PROMPT_MAP_NO_PROBE=1`）退化成「只列工具名、不计数」，并在底部点名哪些工具没算进去。

---

## 7. 和 provider 上报值对账

pi 状态栏的数字取自 provider 上报的当次用量：

```js
calculateContextTokens(usage) = usage.totalTokens || input + output + cacheRead + cacheWrite
```

后端读**最近一次同 cwd 的会话**最后一条 assistant 消息的 usage（只读会话文件尾部 128KB，
避免整份读几百 MB 的 jsonl），在页面上显示为「pi 上报 X tokens」并列出 `in / out / cacheRead`。

**坑**：部分供应商（本机的 deepseek 中转）把 `cacheRead` 报成**会话累计值**——
连续两轮递增即判定为累计，此时页面会标明「cacheRead 似为累计计数器」，并额外给出
**单轮增量**近似值；这种情况不能把上报值当上下文用量看。

一次请求的组成，按量级：

```
系统提示词（本页统计） + 全部工具定义（内置 + 扩展） + 消息历史
```

页面给出前两项的合计（`固定开销合计`）。实测（cwd = 用户主目录）：

| 项 | pi 口径 | 加权 |
|---|---:|---:|
| 系统提示词 | 4,970 | 6,590 |
| 内置 read / bash / edit / write | 679 | 678 |
| 扩展 todo 88 + subagent 450 | 538 | 538 |
| **固定开销合计** | **6,187** | **7,806** |

对应的一次真实会话上报 8,803（in 7,090 + out 177 + cacheRead 1,536），差额是消息历史 +
估算器精度（真实 tokenizer 对 JSON / 代码 / 标点比「4 字符 1 token」更贵）。

---

## 8. API

```
GET /api/prompt-structure?cwd=<目录>&custom=1|0
```

- `cwd`：要分析的工作目录，默认 `$HOME`；不存在返回 400。
- `custom`：`0` 时忽略 `<cwd>/.pi/SYSTEM.md`（默认 `1`，即按 pi 规则发现）。
- 找不到 pi 包时返回 503（页面显示分析失败）。

响应字段（节选）：

| 字段 | 说明 |
|---|---|
| `cwd` / `piPackage` / `piVersion` | 分析的目录与 pi 包信息 |
| `totalChars` / `totalLines` / `estTokens` / `piTokens` | 总长与两种口径 |
| `accountedChars` | 各区块字符数之和，应等于 `totalChars`（自检） |
| `sections[]` | `{key, label, chars, tokens, piTokens, tokenShare, lines, content, items[]}` |
| `sections[].key` | `ext` / `custom` / `core` / `append` / `context` / `skills` / `cwd` |
| `contextFiles[]` | `{label, chars, tokens, contentChars, contentTokens, content}` |
| `skills[]` / `skillsSkipped[]` / `skillsLoaded` | 注入的技能、未注入的技能（disable-model-invocation）、候选总数 |
| `skillSources[]` | 实际参与加载的技能目录 |
| `toolsSchema` | `{items[], chars, tokens, piTokens, extensionItems[], extensionPiTokens, extensionChars}` |
| `extensionTools[]` | 静态扫到的扩展工具名（探测失败时用于点名） |
| `promptHooks[]` | 会改写 `systemPrompt` 的扩展 + `accounted` 标记 |
| `promptPrefix` | prompt-prefix 的状态：`enabled / chars / truncated / files / off / missingDirs` |
| `customPromptFile` / `appendPromptFile` / `projectTrusted` | SYSTEM.md / APPEND_SYSTEM.md 命中情况与信任判定 |
| `reportedUsage` | `{tokens, input, output, cacheRead, model, at, cumulative, perTurnApprox}` |
| `cwds[]` | 工作目录选择器的候选（工作区根 + 近期会话 cwd） |
| `notes[]` | 口径与范围说明（页面直接展示） |

性能：报告缓存 10s、候选目录缓存 60s、扩展工具探测缓存 5 分钟；
pi 包首次 `import` 约 4.8s，`server.js` 启动时预热（日志里能看到 `prompt: structure warm`），
预热后单个请求约 0.2–0.4s。

---

## 9. 前端

- 头图：加权总量（大数字）+ pi 口径 + 字符/行数 + cwd + pi 版本 + 口径说明 + 范围说明。
- **构成网格**：10×5 = 50 格，每格 2%，按 token 占比用最大余数法分配，正好填满 50 格；
  点图例跳转到对应区块。
- **区块列表**：每类一块，给 tokens / 占比 / 占比条 / 复制原文；**正文懒加载**——展开才渲染
  带行号的 `<pre>`；有子项的块（上下文文件、技能、注入文件）先列子块，子块展开看各自正文。
- **搜索**：命中行高亮、未命中行不渲染；搜索时自动展开区块与子块（否则命中藏在折叠里）。
- **一次请求的固定开销**：系统提示词 + 各工具定义，带「内置 / 扩展」标记与合计。
- **扩展改写**：列会改 `systemPrompt` 的扩展，标「已计入 / 未计入」。
- **体检**：上下文文件过多、工具缺 snippet、技能未注入、基础提示词偏长、切分自检等。
- 颜色只走 `--chart-*`（区块映射：`ext`=4、`core`=1、`append`=2、`context`=3、`skills`=5、
  `cwd`=12），表面走 `--surface-raised` / `--bg-2`，尺寸只走 `--sp-*` / `--fs-*`。

---

## 10. 测试

```bash
npm test                        # 全量
npx node --test test/prompt-structure.test.js   # 后端切分/发现规则
npx node --test test/promptmap-ui.test.js       # 前端渲染
```

- `test/prompt-structure.test.js`：标记切分（含 append / custom / 缺标记退化）、两种口径、
  区块汇总自检、SYSTEM.md 与 APPEND_SYSTEM.md 的信任判定、技能来源合并与去重、
  扩展改写识别、扩展工具名扫描、探测输出解析。
- `test/promptmap-ui.test.js`：VM 沙箱里跑 `promptmap-ui.js`，断言 50 格分配、区块与子块懒加载、
  搜索过滤与转义、固定开销合计、上报值对账、空数据不静默画 0。
- 集成测试：`test/server-integration.test.js` 覆盖 `GET /api/prompt-structure` 契约。
- 测试默认 `PROMPT_MAP_NO_PROBE=1`（不 spawn 子进程），保持 hermetic；要测真实探测：

```bash
PROMPT_MAP_DEBUG=1 node -e "require('./lib/extension-tools').probeExtensionTools().then(r=>console.log(r))"
```

---

## 11. 已知限制

| 限制 | 说明 |
|---|---|
| 逐轮改写无法精确计入 | 其它扩展在 `before_agent_start` 里对提示词的改写只在「扩展改写」里点名，未计入总量 |
| 启动参数不可见 | `--system-prompt` / `--append-system-prompt` 是逐次会话的，控制台看不到 |
| 扩展工具探测可能失败 | 扩展用了无法解析的依赖或需要真实运行环境时会被跳过，此时只列名字 |
| 解析钩子不完美 | 依赖入口按 `exports` / `module` / `main` 猜测，个别包（如 `pi-powerline-footer` 引用的 pi-ai 入口）会跳过；不影响工具统计 |
| 只是估算 | 两种口径都不是真 tokenizer；真实值通常在加权数之上 5–15% |
| 不含会话消息 | 消息历史不计入，所以页面的合计永远低于 pi 状态栏 |
| 首次较慢 | 进程首次 import pi 包约 5s（启动已预热）；扩展探测首次约 4s |


## 12. 排障

| 现象 | 处理 |
|---|---|
| 页面显示「分析失败：未找到 @earendil-works/pi-coding-agent」 | 确认全局 npm 目录里有 pi 包，或用 `PI_PKG_DIR` 指过去 |
| 「切分自检未通过」 | pi 版本升级改了拼装或标记，核对 `docs/prompt-map.md` §1 的标记表后更新 `lib/prompt-structure.js` |
| 技能数比预期少 | 检查 `skillSources` 是否包含 `settings.json` 的 `skills` 与 `.agents/skills` |
| 扩展工具没算进去 | `PROMPT_MAP_DEBUG=1` 跑一次探测看 stderr 的 `[skip]` 原因；换完扩展代码可 `clearProbeCache()` 或等 5 分钟 |
| 上报值大得离谱 | 该供应商的 `cacheRead` 是累计计数器，看页面给出的「单轮增量」而不是总量 |

---

*相关：`README.md`（功能总览）、`memory/projects/pi-manager/docs/pi-manager-UI.md`（样式约定）、
`memory/projects/pi-manager/docs/pi-manager-OPTIMIZATION-ROADMAP.md`（阶段五/六记录）。*
