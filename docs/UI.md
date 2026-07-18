# Pi Manager · UI 交接说明（给美化 / K3）

> 本地 Web 控制台：`E:/pi_agent/tools/scripts/pi-manager`  
> 默认：`http://localhost:3001`  
> **本文只讲界面与主题约定**。业务 API / 聊天工具见根目录 `README.md`。

---

## 0. 你要做什么 / 不要做什么

### 模式

| 模式 | 范围 | 文档 |
|------|------|------|
| **Token 润色**（已做一轮） | 主要 `style.css` token/字重/小动效 | 下文约定 |
| **组件大改**（**P1–P8 已收口**，2026-07-18） | 允许 `index.html` 结构、`public/*.js` class/HTML 拼装、大改 CSS | 计划：`D:/Desktop/test/plan/2026/07/18-pi-manager-ui-components.md`；结果见 §10 |

### 可以做
- 布局、间距、圆角、阴影、动效、空状态、图标、信息层级
- **Token 润色模式**：只改 token 或引用 token 的样式
- **组件大改模式**：各页组件信息架构与 DOM 微调；仍必须用 token，禁止新裸 hex/`font-size: Npx`
- `public/style.css` + 必要时 `public/*.js` class 拼装 + `index.html` 结构

### 不要做
- **不要**再写死 `font-size: 13px` / `#3b82f6` / `rgba(15,23,42,…)`（主题与组件区已清过一轮）
- **不要**改业务逻辑：`lib/*.js`、`server.js` 的 API 语义、运行态判定、聊天写工具确认流
- **不要**给费用做 ×7.2；显示 ¥ = 标签，数字 = jsonl 原值累加
- **不要**引入 Tailwind / 新打包器 / 换框架（当前：纯静态 HTML + CSS + 原生 JS）
- **不要**把管理端聊天改成第二个 coding agent
- **不要**默认把服务绑到公网；端口默认 `3001`

### 改完怎么看
1. 静态：`public/*` → 浏览器 **Ctrl+F5**
2. 服务端：`lib/*`、`server.js` → 重启 `start.bat` / `npm start`
3. 主题：右上角主题下拉，**每个主题扫一眼**（尤其用量图 tooltip、勾选框、总览用量卡）

---

## 1. 技术栈与入口

| 项 | 说明 |
|----|------|
| 服务 | `node server.js`，端口 `PORT` 默认 `3001` |
| 启动/停止 | `start.bat` / `stop.bat`（Windows，**CRLF**） |
| 前端 | `public/index.html` + 多脚本，无 build |
| 样式 | **单文件** `public/style.css`（约 4.5k+ 行） |
| 图表 | ECharts（`/vendor/echarts.min.js`），配置在 `public/usage-ui.js` |
| 图标 | Lucide（`/vendor/lucide.min.js`）+ `nav-icons.js` |

脚本加载顺序（`index.html` 末尾）大致为：

`app.js` → `console-ui.js` → `content-pages.js` → `dash-sessions.js` → `usage-ui.js` → `runtime-ui.js` → `ops-ui.js` → `trash-ui.js` → `nav-icons.js` → `chat-ui.js`

路由：hash 路由，`app.js` 里 `routeFromHash()`；页面对应 `#page-<route>`。

主栏路由：

`总览 dashboard` → `运行 runtime` → `模型 models` → `子代理 agents` → `记忆 memory` → `用量 usage` → `搜索 search`  

更多菜单：识图 openvl、提示词、知识库、Skills、插件、会话、回收站、工作区等。

---

## 2. 设计 Token（唯一真源）

定义位置：`public/style.css` 顶部  
`:root` / `[data-theme="default"]` 及各 `[data-theme="…"]`。

### 2.1 颜色（每主题会覆盖）

| Token | 含义 |
|-------|------|
| `--bg` `--bg-1` `--bg-2` `--bg-3` | 背景层级（深→浅或浅主题反过来） |
| `--line` `--line-2` | 边框 |
| `--text` `--muted` `--faint` | 文字层级 |
| `--accent` `--accent-2` `--accent-soft` | 主强调 |
| `--accent-rgb` `--line-rgb` `--muted-rgb` `--ok-rgb` `--warn-rgb` `--danger-rgb` | 供 `rgba(var(--*-rgb), a)` |
| `--ok` `--warn` `--danger` `--danger-2` | 语义色 |
| `--preview-bg` `--preview-code-bg` | Markdown 预览 |
| `--toast-ok-bg` `--toast-err-bg` | Toast |
| `--on-accent` | **压在 accent 上的字/图标**（原写死 `#fff`） |
| `--scheme` | `dark` / `light`（`color-scheme`） |

### 2.2 图表色板（用量 ECharts）

| Token | 默认含义 |
|-------|----------|
| `--chart-1` | = `var(--accent)` |
| `--chart-2` | = `var(--ok)` |
| `--chart-3` | = `var(--warn)` |
| `--chart-4` | = `var(--danger)` |
| `--chart-5` … `--chart-11` | 区分色（可随主题改） |
| `--chart-12` | = `var(--muted)` |

JS：`usageChartColors()` **只读** `--chart-1`…`12`，不要再在 JS 里写死彩虹 hex。

Tooltip：`usageTheme()` 用 `--bg-2` 转半透明 + `--text` / `--muted` / `--line`。  
换主题：`applyTheme()` 在用量页会 `renderUsageCharts` 重画。

### 2.3 运行态（Agent View）

| Token | 用途 |
|-------|------|
| `--phase-answer` | 「在说 / answering」轨/点 |
| `--phase-answer-soft` | 光晕 |
| `--phase-answer-text` | 文案色 |

其它运行态优先：`--accent`（干活）、`--warn`（等待）、`--muted`（停/闲）、`--ok`（完成）。

### 2.4 尺寸 / 字号 / 控件

| Token | 典型值 | 用途 |
|-------|--------|------|
| `--sp-1`…`--sp-6` | 4…32px | 间距 |
| `--fs-xs` | 11px | 标签、角标 |
| `--fs-sm` | 12.5px | 辅助 |
| `--fs-md` | 13.5px | 正文默认 |
| `--fs-lg` | 15px | 小标题 / toolbar 标题 |
| `--fs-title` | 18px | 区块标题 |
| `--fs-display` | 22px | 大数字 / 页标题 |
| `--fw-normal/med/semi/bold` | 400…750 | 字重 |
| `--ctrl-sm` / `--ctrl` / `--ctrl-lg` | 28 / 34 / 40 | 控件高度 |
| `--radius` / `--radius-lg` / `--radius-sm` / `--radius-pill` | 12 / 18 / 8 / 999 | 圆角（lg 用于总览大卡） |
| `--shadow-1` `--shadow-2` | 阴影 | 卡片抬起 |
| `--focus-ring` | focus 环 | 可访问性 |
| `--header-h` `--toolbar-h` `--side-w` | 布局槽 | |
| `--t` | 过渡 | |
| `--surface-raised` | = `var(--bg-1)` | 抬升表面语义别名（P1） |
| `--row-hover` | `rgba(var(--accent-rgb),0.07)` | 表行/列表 hover（P1） |
| `--border-subtle` | `rgba(var(--line-rgb),0.55)` | 淡化分割线（P1） |

**规则：组件样式用 token；主题色板只在 `[data-theme]` 里写 hex。**

---

## 3. 组件约定（已有 class）

优先复用，不要平行发明一套：

| 模式 | Class / 位置 |
|------|----------------|
| 页顶栏 | `.toolbar` + `.toolbar-title` + `.toolbar-actions` |
| 按钮 | `.btn` / `.btn.ghost` / `.btn.danger` + `.sm` |
| 表单 | `.fields` 内 input/select/textarea |
| 卡片 | 各页 `*-card` / `.block` / `.block-lite`，表面用 `--bg-1`/`--bg-2` |
| Chip | `.chip` / `.scope-chip` / 用量 `.usage-preset` |
| 空状态 | `.empty` / 各页 empty |
| Toast | 全局 toast 样式（跟 token） |
| 勾选框 | **全局自绘** `input[type=checkbox|radio]`（`appearance:none` + accent） |
| 导航 | `#nav-tabs .tab`、`#nav-more-*` |

### 勾选框（注意）

未勾选系统色管不住 → 已自绘：

- 未勾选：`--bg-1` + `--line-2` 边框  
- 勾选：底/边 `--accent` + 白勾 SVG  
- 会话表：`#sess-check-all` / `.sess-check` 同一套  

不要改回原生不设样式，否则主题又花。

### 总览「用量概览」

- 类名：`.dash-usage-hero` / `.dash-metric` / `.dash-usage-panel`  
- **禁止** `rgba(var(--bg-rgb), …)`：主题里没有 `--bg-rgb`，会落到死色  
- 正确：表面 `var(--bg)` / `var(--bg-1)` / `var(--bg-2)`，边框 `var(--line)`

### 用量页

- 顶栏：`.usage-topbar`（对齐 toolbar token）  
- 统计卡：`.usage-stat-card` + `tone-*`（映射 accent/ok/warn/danger/chart）  
- 图：`#usage-chart-pie|cost|tokens|rank`，逻辑只在 `usage-ui.js`

### 运行页

- UI：`public/runtime-ui.js`，样式 `av2-*`  
- 文案人话：「在调工具 / 在想 / 停了，等你说话」  
- 任务标题：后端 `currentTask` = 过滤噪声后的 `lastTaskUser`（「批准执行」「继续」不当标题）  
- Todo 摘要：人话「勾完 #id」，不是 raw JSON  
- 子代理：无 open/recent **整块不渲染**

---

## 4. 关键文件地图

```
public/
  index.html          # 壳 + 各 page section
  style.css           # ⭐ 主题 + 全站样式（先改这里）
  app.js              # 路由、主题 applyTheme、全局状态
  usage-ui.js         # 用量页 + ECharts + usageTheme/usageChartColors
  runtime-ui.js       # 运行列表 Agent View
  dash-sessions.js    # 总览 + 会话列表
  chat-ui.js          # 侧栏助手 UI
  console-ui.js       # 提示词/skills/插件等
  content-pages.js    # 记忆/知识库
  ops-ui.js / trash-ui.js / nav-icons.js / diff-util.js

lib/                  # 后端业务 — 美化默认别动
  runtime.js          # 运行态解析
  chat.js / chat-tools.js / chat-client.js
  usage.js / sessions.js / ...

server.js
start.bat / stop.bat
README.md             # 产品/API 说明
UI-README.md          # 本文
```

---

## 5. 主题列表

`app.js` → `THEMES`：

`default` `midnight` `aurora` `orchid` `amber` `miku`  
`light` `paper` `rose` `miku-light`

- 浅色主题会设 `--scheme: light` 与更轻的 `--shadow-*`  
- 换主题只改 `document.documentElement` 的 `data-theme`  
- 新主题：复制一块 `[data-theme="…"]`，补齐与 default 相同的变量名（含 rgb），**不要**漏 `--accent-rgb` 等

---

## 6. 已知限制（别当 bug 硬修错层）

1. **运行态「是否真在跑」** 只能靠 session jsonl + 时间窗；长思考无落盘无法 100% 区分。要实时需 Pi heartbeat（产品层，不是纯 CSS）。  
2. **费用**：用量数字按产品约定直接展示；聊天里费用回复「只报数字」。  
3. **遮罩** `rgba(0,0,0,.45~.58)` 可保留（模态通用），不必强行 token。  
4. **按钮 inset 高光** `rgba(255,255,255,.08~.14)` 可保留。  
5. 无 Visual regression；改完靠多主题肉眼扫。

---

## 7. 美化建议优先级（给 K3）

1. **统一节奏**：同一页内间距只用 `--sp-*`，标题层级只用 `--fs-*`  
2. **抬信息**：总览 / 运行 / 用量三页的「第一眼」层级（不必重做信息架构）  
3. **空状态与加载**：比裸「加载中…」更稳  
4. **表格与表单**：会话表、模型表、用量表对齐行高/对齐方式  
5. **动效克制**：已有 `--t`；运行 pulse 已有，勿堆动画  
6. 若改图表观感：改 `--chart-*` 或 ECharts `grid`/圆角，**颜色仍走 token**

---

## 8. 自检清单（交工前）

- [ ] 深色 `default` + 至少一个浅色 `light`/`paper`  
- [ ] 用量页：悬停图表 tooltip 不「死深蓝」  
- [ ] 会话页：未勾选 / 勾选 框色跟主题  
- [ ] 总览用量卡：不发脏、不固定深蓝灰底  
- [ ] 运行页：任务名不是「批准执行」；无子代理时不空白标题块  
- [ ] `grep` 主体样式无新增 `font-size: Npx`、无业务区新增裸 `#rrggbb`（主题块除外）  
- [ ] `npm test`（12）仍通过  
- [ ] 未改写工具确认流 / 未误删 `safePublicPath`

快速自检命令（Git Bash）：

```bash
# 主体区不应再出现 font-size: 12px 这类（主题块除外，约 360 行后）
rg -n "font-size:\s*[0-9.]+px" public/style.css | head

# 图表应从 CSS 变量读
rg -n "usageChartColors|--chart-" public/usage-ui.js

npm test
```

---

## 9. 一句话给模型

> Pi Manager 是 **token 驱动的静态控制台**。美化时改 `public/style.css` 的 token 与布局 class，图表颜色只动 `--chart-*` / `usageTheme`，**不要**写死色值和字号，**不要**动 `lib/` 业务与写操作确认。

---

## 10. 组件大改结果（P1–P8 · 2026-07-18）

计划：`D:/Desktop/test/plan/2026/07/18-pi-manager-ui-components.md`。  
施工前备份：`D:/Desktop/test/backup-pimgr-public-20260718/public/`。

### 10.1 各包一句话

| 包 | 做了什么 |
|----|----------|
| **P1 壳+token** | 顶栏/导航/更多菜单/保存区统一；新增 `--surface-raised` / `--row-hover` / `--border-subtle` |
| **P2 总览** | 用量 hero 四 metric 主次、状态 tile 头/值/脚、最近会话扫描路径 |
| **P3 用量** | 顶栏分段 + KPI 卡 + 图表空态 + 表密度；费用仍 `fmtCost` 原值 ¥ |
| **P4 运行 av2** | 列表左轨状态/中任务/右工具；peek 分段；toolbar 对齐 |
| **P5 会话/回收站/搜索** | 共用表+工具条语言、空/加载行、分页 footer |
| **P6 编辑页** | 侧栏 split、表单节奏、skill/plugin 行、md 预览 |
| **P7 聊天** | 仅样式（消息层级、tool 卡、session 列表）；confirm/Diff 逻辑零改 |
| **P8 收口** | 分区锚点/class 同步/裸 hex/费用红线/npm test；本文更新 |

### 10.2 style.css 分区协作（勿整文件重排）

```text
/* === tokens / themes（仅 P1 可扩 token） === */
/* === shell: header nav === */
/* === pages layout (shared) === */
/* === editors split side === */
/* === buttons forms table global === */
/* === overlays toast modal === */
/* === dashboard === */
/* === usage === */
/* === sessions search trash === */
/* === chat === */
/* === runtime av2 === */
```

后续改动只进对应分区；公共 `.btn` 变更归壳/全局区。

### 10.3 新增 3 个 token（P1）

| Token | 值 | 用途 |
|-------|-----|------|
| `--surface-raised` | `var(--bg-1)` | 卡片/peek/抬升面 |
| `--row-hover` | `rgba(var(--accent-rgb), 0.07)` | 表行、侧栏、列表 hover |
| `--border-subtle` | `rgba(var(--line-rgb), 0.55)` | 淡边、分隔 |

### 10.4 红线验收（P8）

- 费用：`public/` 无 `7.2` 命中；`fmtCost` / `fmtSummaryCost` / `fmtRowCost` 与备份一致，显示 `¥` + 原值
- 用量页脚注：`费用=jsonl 原值累加 · 显示 ¥`
- 主题块外无新增裸 `#rgb/#rrggbb`（业务区走 token）
- `npm test` **12/12** 通过
- 未改 `lib/**`、`server.js`；chat confirmId / Diff 时序未动

### 10.5 残留事项

1. **三主题截图走查**（`default` + `light` + `paper` × 总览/用量/运行/会话）由主会话人工完成；建议目录 `D:/Desktop/pimgr-shots-components/`
2. 无 Visual regression 自动化；仍靠多主题肉眼扫
3. 运行态「是否真在跑」仍依赖 jsonl 时间窗（产品层限制，非本轮 CSS）
4. 遮罩 `rgba(0,0,0,…)` / 按钮 inset 高光按 §6 可保留

---

*生成上下文：硬编码清理 + 图表跟主题 + 组件大改 P1–P8 收口。产品总览仍以 `README.md` 为准。*
