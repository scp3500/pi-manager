# 2026-10-04 加固与正确性修复

这轮**没有加新页面**。控制台该有的功能还在，修的是：断开会停、中文不乱码、主题不闪、目录显示对、密钥命令不卡死、本机跨端口写请求收紧。

> 2026-10-04 复核后又补了 4 处：配置根回退（`node server.js` / `npm start` 从空目录挪回真实目录）、5xx 文案只对本机请求回、IPv6 Host、vendor 缓存时长。已并入下面各节。

执行清单是 [`FIX-PLAN.md`](./FIX-PLAN.md)（已完成）。`npm test`：**183** 通过（原先 148，新增 35）。零 npm 依赖。

入口：本文件讲「改了什么、使用时会碰到什么」。计划原文仍可对照实现细节。

---

## 1. 关标签页后上游还会跑完（P0）

**以前：** 聊天 SSE 用 `req.on('close')` 判断客户端走了。请求体被 `readBody` 读完后，`req` 的 `close` 已经触发过，之后刷新 / 关页 / 断网都不会再进这个回调。上游模型和工具循环会一直跑完。

**现在：** 监听 `res.close`，且用 `writableEnded` 区分「服务端正常 `end`」和「客户端中途断开」。断开后 `AbortController` 中止 `runChatWithTools`，助手消息标 `partial` / `stopped`，不再为已中止的对话再去生成标题。

相关：`lib/routes/helpers.js` 的 `abortOnClientClose`，`lib/routes/chat.js`。测试：`test/chat-abort.test.js`。

---

## 2. 大段中文保存可能乱码（P0）

**以前：** `readBody` 把每个 `Buffer` 块直接拼进字符串。一个汉字（3 字节）若跨在两块中间，会解成 `�`。`BODY_LIMIT`（2MB）按 UTF-16 字符数算，中文实际能塞进约 6MB。超限只 `reject`，连接上的数据仍会读完。

**现在：** 先攒 Buffer 再一次性 UTF-8 解码；限额按**字节**；超限 `req.resume()` 丢弃剩余数据，调用方仍能回 413（不要 `destroy()`，否则客户端只看到连接重置）。

相关：`lib/routes/helpers.js`。测试：`test/read-body.test.js`（跨块中文、按字节 413、空 body、非法 JSON）。

---

## 3. 每次打开都先闪默认主题（P0）

**以前：** `<head>` 里有一段内联脚本，从 `localStorage` 读主题，避免闪烁。但 CSP 是 `script-src 'self'`，内联脚本被拦，等 `app.js` 加载完才切换。

**现在：** 独立文件 `public/theme-init.js`，同步、无 `defer`/`async`，放在样式表之前。主题名与 `public/app.js` 的 `THEMES` 一致。没有放宽 CSP。

测试：`index.html` 不得再出现不带 `src` 的 `<script>`；`GET /theme-init.js` 为 200。

---

## 4. 安装页 agents 路径是错的（P1）

**以前：** 真正读写在 `AGENTS_DIR/<category>/<name>.md`（默认 `$PI_CONFIG_DIR/agents`）。安装页 `status()` 和「创建示例子代理」返回的却是 `PI_AGENT_DIR/agents/...`，UI 上的目录和文件对不上。

**现在：** `status().agents.dir === AGENTS_DIR`；已存在走 `agentFilePath`，新建走 `agentPathFor(name, { category })`，与 `writeAgent` 一致。

相关：`lib/agents.js`、`lib/install.js`。测试：`test/install-agents.test.js`。

---

## 5. `!command` 形式的 API Key 会卡住整个服务（P1）

`models.json` 的 `apiKey` 支持三种写法：明文、`$ENV`、`!shell 命令`。

**以前：** `execSync(..., { timeout: 15000 })` 同步执行。一次命令最多堵住事件循环 15 秒，期间所有 HTTP 都排队。没有缓存：每条聊天、每次健康检查都会再跑（密码管理器 CLI 还可能弹窗）。

**现在：**

- 逻辑在 `lib/api-key.js`（`fetch-models.js` re-export 以保持兼容）
- `exec` 异步；同一命令并发共用一个 pending Promise
- 成功结果缓存 **5 分钟**（空字符串也缓存）；**失败不缓存**。意味着轮换了 token / vault 会话后，最多陈旧 5 分钟才生效
- `maxBuffer` 提到 4MB（默认 1MB，有的密码管理器 dump 超了会被 exec 当失败）
- 写入 `models.json` 时 `clearApiKeyCache()`，改命令立即生效
- `runHealth` 里解析 key 改为按 provider 并发，探测顺序仍按列表保序

聊天路径：`resolveProviderAuth` 改为 `async`，`completeChat` / `streamChat` / `runChatWithTools` 均 `await`。

测试：`test/api-key.test.js`（明文 / `$ENV` / `!node -e`、缓存、并发去重、失败不缓存、不阻塞事件循环、>1MB 输出）。

---

## 6. 静态资源每次整包重下（P1）

**以前：** 只有 `Cache-Control: no-cache`，无 ETag。echarts ~1MB 且大于 512KB 缓存阈值，每次 `readFileSync`。HEAD 也返回完整 body。`index.html` 用 `?v=...` 手工 bust。

**现在：**

| 项 | 行为 |
|---|---|
| ETag | 弱校验 `W/"<size16>-<mtime16>"`，匹配则 304 |
| Cache-Control | `/vendor/` → `public, max-age=300`；其余 `no-cache`（每次验证，改动能立刻生效） |
| HEAD | 带头（含 `Content-Length`），无 body |
| 内存缓存 | 单文件上限 2MB，echarts 可进缓存 |
| 查询参数 | 去掉 `?v=nav-noscroll-1` 等 |
| 调试头 | `X-Static-Cache: HIT/MISS` 只在 `PI_MANAGER_DEBUG=1` 时返回 |

**未做：** gzip（计划里的可选项）。`text/*` / JS / SVG 可在缓存条目里预压，本次没上。

vendor 的 `max-age` 从一天降到 **5 分钟**：去掉 `?v=` 手工 bust 之后，一天不回源会让 echarts / lucide 的更新看不到。现在改 vendor 文件后最多 5 分钟刷新出来。

相关：`server.js` 的 `serveStatic(req, res, urlPath)`。测试在 `test/server-integration.test.js`。

---

## 7. 安装状态页同步 `where`（P2）

Windows 上 `whichSync` 用 `execFileSync('where')`，单次约 100ms+。`status()` 每次打 npm / pi，安装流程里还会再打。

现在模块级缓存 **60 秒**（命中与未命中都缓存）；`runJob` 子进程 `close` 时清空，因为 PATH 里可能多了新命令。`status()` 本身仍是同步函数，避免把所有调用路由改成 async。

---

## 8. 本机其它端口的网页也能改配置（P2）

**以前：** 写请求只要 Origin 和 Host 都是 loopback，**端口不同也放行**。`localhost:3000` 上的页面（或被注入脚本的本地页）可以向 `:3001` 发 POST。控制台能改 `models.json`，apiKey 又支持 `!command`，构成「本地网页 → 执行命令」。

**现在：**

- Origin 端口必须与服务端口一致。Origin 无端口时按协议默认端口（http 80 / https 443），一般不等于 3001，会被拒——这是预期。
- `PI_MANAGER_ALLOWED_ORIGINS`：逗号分隔的完整 Origin 列表，列表内直接放行（前端开发跨端口用）。
- `PI_MANAGER_ALLOW_REMOTE=1` 语义不变。
- 没有 Origin 的 POST（curl 等）仍然放行。
- Host 头支持 IPv6：`[::1]:3001` / `[::1]` 都当 loopback（之前按 `:` 切字符串，IPv6 直接被当非法 Host 拒掉）。

同端口下 `localhost` 与 `127.0.0.1` 仍视为同一 loopback。测试：`test/http-security.test.js`。

---

## 9. 错误码跟着文案走（P2）

**以前：** `mapError` 用 `message.includes('must be')`、`'not found'` 等猜状态码。改一句提示，码就可能变。路由里约几十处重复 `if (e.status) sendError; else mapError`。

**现在：** `mapError` 开头若 `e.status` 是 400–599 的整数，直接用它（≥500 才 `console.error`）。那些两行重复全部收成 `mapError(res, e)`。`chat.js` 读 body 失败仍是 `sendError(res, e.status || 400, ...)`，未改。字符串匹配**保留作兜底**，业务抛错补 `err.status` 是长期工作，这次没铺开。

5xx 的文案分两种去向（`res.req.socket.remoteAddress` 判断）：本机请求回详细文案（`session file corrupt: ...` 这类带路径的诊断信息保留，方便排障），远程请求（`PI_MANAGER_ALLOW_REMOTE=1`）只回 `Internal error`。

测试：`test/map-error.test.js`。

---

## 10. 路径、测试脚本、重复文件（P3）

| 项 | 结果 |
|---|---|
| `PI_CONFIG_DIR` 默认值 | 代码里改为「显式环境变量 → `E:\pi_agent\pi_config`（存在才认）→ `~/.pi/config`」，不再无条件写死 `E:/pi_agent/pi_config` |
| 直接跑 `node server.js` / `npm start` | 不再落到空的 `~/.pi/config/agents`（会显示 0 个 agent、新建落错地方）；本机启动仍 `start.bat` / `start-bg.ps1` **显式** `PI_CONFIG_DIR=E:\pi_agent\pi_config` |
| `npm test` | `node --test test/*.test.js`（Windows 上 `node --test test/` 会把目录当成模块加载失败） |
| `docs/assets/hero.svg` | 与 `hero-v2.svg` 内容相同，README 用 v2，已删 svg 副本 |
| `templates/workflow/AGENTS_SUBAGENT.md` | 与 `public/templates/...` 相同；前端 fetch 的是 public 这份，仓库根那份已删 |
| SPA | `server.js` 用模块级 `SPA_ROUTES` Set |
| `backups/*.bak` | **未删**（可能是有意留的本地备份） |

---

## 对使用者

- 聊天中途关页，不应再把整段回复和工具跑完。
- 保存很大的中文 AGENTS.md / 技能 / 提示词，不应再出现跨块乱码。
- 选过非默认主题后刷新，不应先闪默认蓝。
- 教程页创建的示例子代理，路径应落在真实的 `AGENTS_DIR`。
- Provider 用 `!vault ...` 一类命令取 Key 时，控制台其它请求不应被堵死 15 秒。
- 静态资源第二次加载应走 304；改 `public/` 下非 vendor 文件刷新即可（`no-cache` + ETag）；vendor 文件最多 5 分钟后生效。
- 其它本机端口的网页默认不能再对本控制台做写操作；开发服务器跨端口需设环境变量。

---

## 环境变量（本轮新增 / 语义变化）

| 变量 | 默认 | 含义 |
|------|------|------|
| `PI_MANAGER_ALLOWED_ORIGINS` | 未设置 | 逗号分隔完整 Origin，如 `http://localhost:5173` |
| `PI_MANAGER_DEBUG` | 未设置 | 设为 `1` 时静态响应带 `X-Static-Cache: HIT/MISS` |
| `PI_CONFIG_DIR` | 自动 | 共享 Agent / Skill 根：环境变量 → `E:\pi_agent\pi_config`（存在才认）→ `~/.pi/config`；本仓库启动脚本会显式设成 `E:\pi_agent\pi_config` |

`PI_MANAGER_ALLOW_REMOTE`、`PI_MANAGER_HOST`、`PORT` 未改语义。README「环境变量 / 安全」两节已同步。

---

## 测试文件

| 文件 | 覆盖 |
|------|------|
| `test/chat-abort.test.js` | 客户端 destroy 会 abort；正常 `res.end` 不 abort |
| `test/read-body.test.js` | 跨块 UTF-8、字节限额 413、空 body、非法 JSON |
| `test/api-key.test.js` | 三种 Key 形态、缓存、并发、失败、事件循环、大输出（>1MB，验 maxBuffer） |
| `test/install-agents.test.js` | 示例子代理路径在 `AGENTS_DIR` 下 |
| `test/map-error.test.js` | `status` 优先，文案兜底 404/500；5xx 本机回详情 / 远程回 `Internal error` |
| `test/http-security.test.js` | 同端口放行、跨端口拒绝、白名单、无 Origin、IPv6 loopback Host/Origin |
| `test/config-dir.test.js` | `PI_CONFIG_DIR` 回退顺序：环境变量 > 本机历史目录 > `~/.pi/config` |
| `test/server-integration.test.js` | 无内联脚本、theme-init、ETag/304、HEAD、vendor `max-age=300`、默认无调试头 |

---

## 刻意没做

- 静态 gzip。
- 把 `status()` / `whichSync` 改成全异步（只做缓存）。
- 给 `lib/` 里所有 `throw` 补 `err.status`。
- 删除 `backups/`。
- 扩大 SPA 路由表（只把原有 pathname 列表收成 Set，未加 `/runtime`、`/chat` 等；这些本来走 hash）。
