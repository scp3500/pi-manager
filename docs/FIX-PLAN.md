# Pi Manager 修复计划

> **已于 2026-10-04 执行完毕。** 说明（改了什么、使用时会碰到什么）见 [`hardening.md`](./hardening.md)。
> 本文档是当时的执行清单，保留作对照；不要再按任务顺序改一遍代码。
>
> 原目标读者：接手执行修复的开发者 / 模型。行号基于编写时的代码。

---

## 0. 执行前必读

### 0.1 项目概况

- 纯 Node.js 本地 Web 控制台，**零 npm 依赖**（不要引入任何第三方包），`engines.node >= 18`，本机 Node 为 v24。
- 结构：`server.js`（入口 + 静态文件）、`lib/`（业务逻辑）、`lib/routes/`（HTTP 路由）、`public/`（原生 JS 前端，无构建步骤）、`test/`（`node:test`）。
- 运行环境：Windows + PowerShell。路径比较、子进程调用要兼顾 Windows。
- 测试：`npm test`，当前 **148 个用例全部通过**，耗时约 30–50 秒。每完成一个任务都要跑一遍，必须保持全绿。

### 0.2 工作区注意事项

- 这是 git 仓库，**当前已有未提交的改动**：`README.md`、`lib/fetch-models.js`、`lib/models.js`、`public/index.html`、`public/models-ui.js`。这些是用户自己的工作，**不要 revert、不要 `git checkout`/`git stash`**，在其基础上修改。
- 建议每个任务单独提交一次（如果用户同意提交），提交信息风格参照 `git log`，例如 `fix(chat): ...`。
- 代码风格：2 空格缩进、单引号、分号、CommonJS `require`。注释稀疏，中英混用均可，与周边保持一致。不要写"这里修复了 xx"之类的说明性注释。
- 在 `E:` 盘上 IDE 的 Grep 工具可能超时，可以在 shell 里直接用 `rg`。

### 0.3 任务总览（按建议执行顺序）

| # | 优先级 | 任务 | 主要文件 |
|---|---|---|---|
| 1 | P0 | 客户端断开时没能中止上游对话 | `lib/routes/chat.js` |
| 2 | P0 | `readBody` 按块拼字符串导致 UTF-8 乱码、上限按字符算 | `lib/routes/helpers.js` |
| 3 | P0 | CSP 拦截了内联主题脚本 | `public/index.html`，新建 `public/theme-init.js` |
| 4 | P1 | 安装页显示的 agents 目录与实际写入位置不一致 | `lib/install.js`、`lib/agents.js` |
| 5 | P1 | `resolveApiKey` 用 `execSync` 阻塞事件循环，且无缓存 | `lib/fetch-models.js`、`lib/chat-client.js`、`lib/ops.js` |
| 6 | P1 | 静态资源无 ETag/304，HEAD 返回 body | `server.js` |
| 7 | P2 | `install.status()` 每次同步调用 4 次 `where` | `lib/install.js` |
| 8 | P2 | Origin 校验放行任意本地端口 | `lib/http-security.js` |
| 9 | P2 | `mapError` 依赖错误文案字符串匹配，且路由里大量重复 `if (e.status)` | `lib/routes/*.js` |
| 10 | P3 | 杂项清理（硬编码路径、测试脚本、重复文件、SPA 路由） | 多处 |

任务之间基本独立。只有任务 9 会改到很多路由文件，建议放在后面做，避免冲突。

---

## 任务 1（P0）：客户端断开时中止上游对话

### 问题

`lib/routes/chat.js` 发送消息的流式接口（约第 401 行）用下面的代码检测客户端断开：

```js
req.on('close', () => {
  if (!ac.signal.aborted) {
    try { ac.abort(); } catch { /* ignore */ }
  }
});
```

在 Node 18+ 中，`IncomingMessage`（`req`）的 `close` 事件在**请求体读完后**就会触发。这里的请求体之前已经被 `readBody` 读完，所以到挂监听时事件早已发生，之后客户端断开也不会再触发。真正能反映连接断开的是 `res` 的 `close` 事件。

已经用最小脚本验证过：SSE 写出后客户端 `destroy()`，结果是 `req close` 没有触发，`res close` 触发了，并且 `writableEnded=false`。

**后果**：用户关闭标签页、刷新页面或者网络断开后，上游大模型的流式输出和工具调用循环（`runChatWithTools`）会一直跑完，浪费 token，还可能继续执行工具。

### 修复步骤

1. 在 `lib/routes/helpers.js` 新增并导出一个工具函数：

   ```js
   function abortOnClientClose(res, ac) {
     res.on('close', () => {
       if (!res.writableEnded && !ac.signal.aborted) {
         try {
           ac.abort();
         } catch {
           /* ignore */
         }
       }
     });
   }
   ```

   `writableEnded` 用来区分"服务端正常 `res.end()` 后关闭"和"客户端中途断开"两种情况。

2. 在 `lib/routes/chat.js` 中，把上面的 `req.on('close', ...)` 整段替换为 `abortOnClientClose(res, ac);`，并从 `./helpers` 引入。
3. 全局搜索 `req.on('close'`（`rg -n "req.on\('close'" lib`），其他 SSE/长连接接口如果有同样写法，一并替换。
4. 检查 abort 之后的收尾逻辑：被中止的 assistant 消息应该被标记为 aborted/stopped 并保存，`chatAbortMap` 中的条目要删除。现有代码里已经有 `aborted` 标志和对应分支，确认断开路径会走到它，不要因为 `res` 已关闭而在 `writeSse` 时抛错。如果抛错，在写之前判断 `res.writableEnded || res.destroyed`。

### 测试

新建 `test/chat-abort.test.js`：

- 起一个 `http.createServer`。处理函数里先读完 body，然后 `writeHead(200, text/event-stream)` 并写一条数据，再调用 `abortOnClientClose(res, ac)`。
- 客户端发送 POST，收到第一块数据后执行 `req.destroy()`。
- 断言 `ac.signal.aborted === true`（用 Promise 等待 `abort` 事件，加 2 秒超时）。
- 再测一个反例：服务端正常 `res.end()` 后，`ac.signal.aborted` 应为 `false`。

### 验收

- 新测试通过，`npm test` 全绿。
- 手动验证：在聊天页发一条长回复的消息，中途关掉标签页，服务端日志或会话文件里这条消息应该被标记为中止，而不是继续完成。

---

## 任务 2（P0）：修复 `readBody` 的 UTF-8 切分和大小上限

### 问题

`lib/routes/helpers.js` 中的 `readBody` 实现如下：

```js
let body = '';
req.on('data', (chunk) => {
  body += chunk;               // Buffer 被逐块 toString
  if (body.length > BODY_LIMIT) { ... }   // 按 UTF-16 字符数计
});
```

- 每个 `chunk` 是 `Buffer`，`+=` 会对每块单独做 UTF-8 解码。如果一个多字节字符（中文 3 字节）恰好跨在两块之间，会被解成 `\uFFFD` 乱码。保存较大的 AGENTS.md、提示词、技能文件时会出现。
- `body.length` 是字符数，不是字节数。`BODY_LIMIT` 为 2MB，对中文内容实际放宽到约 6MB。
- 超过上限后只 `reject`，没有停止接收数据，连接上的数据仍会被持续读完。

### 修复步骤

将 `readBody` 改写为：

```js
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let exceeded = false;
    req.on('data', (chunk) => {
      if (exceeded) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        exceeded = true;
        chunks.length = 0;
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (exceeded) return;
      if (size === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks, size).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}
```

说明：

- 超限后用 `req.resume()` 丢弃剩余数据，**不要**直接 `req.destroy()`。否则调用方来不及返回 413 响应，客户端只会看到连接被重置。调用方在 catch 里会用 `e.status` 返回 413。
- 如果项目里还有其他地方自己读请求体（`rg -n "on\('data'" lib`），按同样方式检查并修复。

### 测试

在 `test/` 新建 `read-body.test.js`：

1. **跨块中文**：起一个 server，用 `readBody` 解析后原样返回。客户端构造 `JSON.stringify({ s: '中文测试'.repeat(10) })` 的 Buffer，在一个中文字符的中间（比如第 `Buffer.byteLength('{"s":"') + 1` 字节处）切成两段。先 `write` 前半段，`setTimeout` 20ms 后再 `end` 后半段。断言服务端解析出的 `s` 与原文完全一致。
2. **按字节限额**：构造字节数略大于 `BODY_LIMIT`、但字符数小于 `BODY_LIMIT` 的中文 body，断言返回 413。
3. **空 body** 返回 `{}`；**非法 JSON** 返回 400。

### 验收

新测试通过，`npm test` 全绿。

---

## 任务 3（P0）：内联主题脚本被 CSP 拦截

### 问题

`public/index.html` 第 8–17 行有一段内联 `<script>`，用来在首屏绘制前从 `localStorage` 读取主题并设置 `data-theme`，避免主题闪烁。

但 `lib/http-security.js` 的 `securityHeaders()` 下发的 CSP 是 `script-src 'self'`，不允许内联脚本，`index.html` 本身也带着这个响应头。所以这段脚本**根本不会执行**。浏览器控制台会报 CSP 违规，每次打开页面都会先显示默认主题，等 `app.js`（第 196 行附近）加载后才切换，出现闪烁。

### 修复步骤

1. 新建 `public/theme-init.js`，内容与内联脚本相同：

   ```js
   (function () {
     try {
       var t = localStorage.getItem('pi-manager-theme');
       var ok = {
         default: 1, midnight: 1, aurora: 1, orchid: 1, amber: 1, miku: 1,
         light: 1, paper: 1, rose: 1, 'miku-light': 1
       };
       if (ok[t]) document.documentElement.setAttribute('data-theme', t);
     } catch (e) {}
   })();
   ```

   主题列表要与 `public/app.js` 中的主题定义保持一致。实施时打开 `app.js` 第 167 行附近核对，如果有差异，以 `app.js` 为准。

2. 将 `index.html` 中的内联 `<script>...</script>` 整段替换为：

   ```html
   <script src="/theme-init.js"></script>
   ```

   保持它在 `<head>` 中、位于 `<link rel="stylesheet">` 之前，并且**不要**加 `defer`/`async`，必须同步执行才能避免闪烁。

3. **不要**通过放宽 CSP（如加 `'unsafe-inline'`）来解决。

### 测试

在 `test/` 新增断言（可以放进现有的 `server-integration.test.js` 或新建 `index-html.test.js`）：

- 读取 `public/index.html`，用正则 `/<script(?![^>]*\bsrc=)[^>]*>/i` 断言**不存在**不带 `src` 的 `<script>` 标签。这样可以防止以后再引入内联脚本。
- 请求 `/theme-init.js` 返回 200，`Content-Type` 为 JavaScript。

### 验收

浏览器打开控制台，不再出现 CSP 违规报错。切换到非默认主题后刷新页面，没有闪烁。

---

## 任务 4（P1）：安装页显示的 agents 目录错误

### 问题

- `lib/config.js` 中 `AGENTS_DIR = process.env.AGENTS_DIR || path.join(PI_CONFIG_DIR, 'agents')`。
- `lib/agents.js` 实际按 `AGENTS_DIR/<category>/<name>.md` 读写（见 `categoryDir` / `agentPathFor`，未知分类落到 `other/`）。
- `lib/install.js` 却写死了 `path.join(PI_AGENT_DIR, 'agents')`：
  - 第 151 行附近：`status().agents.dir`
  - 第 232 行附近：`createStarterAgent()` 在"已存在"分支返回的 `path`
  - 第 250 行附近：`createStarterAgent()` 在"新建"分支返回的 `path`

结果是 UI 显示的目录和文件路径都不对。

### 修复步骤

1. `lib/agents.js`：在 `module.exports` 中导出 `agentPathFor`，同时导出一个按名字查找实际文件路径的函数（`findAgentEntry` 已存在，它返回的 entry 带 `filePath`）。推荐新增：

   ```js
   function agentFilePath(name) {
     return findAgentEntry(name).filePath;
   }
   ```

   然后导出 `agentPathFor` 和 `agentFilePath`。

2. `lib/install.js`：
   - 从 `./config` 引入 `AGENTS_DIR`。如果 `PI_AGENT_DIR` 不再被使用，就从解构中删除。
   - `status()` 中 `dir: AGENTS_DIR`。
   - "已存在"分支：`path: agentsApi.agentFilePath(name)`。
   - "新建"分支：`path: agentsApi.agentPathFor(name, { category: STARTER_AGENT.category })`。必须与 `writeAgent` 时传入的 data 一致，确保算出的路径就是实际写入的路径。

### 测试

在 `test/agents.test.js`（参考其中设置临时 `AGENTS_DIR` 的方式）或新文件中：

- 设置临时 `AGENTS_DIR` 后调用 `install.createStarterAgent()`，断言返回的 `path` 存在（`fs.existsSync`），并且位于临时 `AGENTS_DIR` 之下。
- 再调用一次，断言 `created === false`，`path` 与第一次相同。
- `install.status().agents.dir === AGENTS_DIR`。

注意：`config.js` 在 require 时就读取了环境变量，测试必须在 require `lib/*` **之前**设置 `process.env.AGENTS_DIR`。如果同一进程中已经被别的测试 require 过，参考现有测试的隔离方式（`node --test` 默认每个文件一个子进程）。

---

## 任务 5（P1）：`resolveApiKey` 异步化并加缓存

### 问题

`lib/fetch-models.js` 中的 `resolveApiKey(raw)` 对 `!command` 形式的 apiKey 使用 `execSync(cmd, { shell: true, timeout: 15000 })`：

- 同步执行，每次最多**阻塞整个服务 15 秒**，期间所有 HTTP 请求都会卡住。
- 没有缓存，每次调用都重新执行命令（例如调用密码管理器 CLI，可能很慢，还可能弹窗）。

调用方：

| 位置 | 所在函数 | 是否已是 async |
|---|---|---|
| `lib/fetch-models.js` 约第 238 行 | `fetchRemoteModels` | 是 |
| `lib/fetch-models.js` 约第 443 行 | `testProviderConnection` | 是 |
| `lib/chat-client.js` 约第 51 行 | `resolveProviderAuth`（同步函数） | **否** |
| `lib/ops.js` 约第 484 行 | `runHealth` 的 for 循环内，串行 | 是（但循环是串行的） |

`resolveProviderAuth` 的调用方是 `completeChat`（约第 339 行）、`streamChat`（约第 392 行）、`runChatWithTools`（约第 591 行），这三个都是 async 函数。也就是说，**每发一条聊天消息**都会同步执行一次命令。

`ops.js` 的 `runHealth` 会先串行解析所有 provider 的 key，再 `Promise.allSettled` 并发探测。只要串行这一步有一个慢命令，就会抵消后面并发的意义。

### 修复步骤

1. **`lib/fetch-models.js`**：
   - 将 `const { execSync } = require('child_process')` 改为 `const { exec } = require('child_process')`。`exec` 默认通过 shell 执行，等价于原来的 `shell: true`。
   - 新增模块级缓存和异步实现：

     ```js
     const API_KEY_CMD_TTL_MS = 5 * 60_000;
     /** @type {Map<string, {value: string, expires: number} | {pending: Promise<string>}>} */
     const apiKeyCmdCache = new Map();

     function runApiKeyCommand(cmd) {
       return new Promise((resolve, reject) => {
         exec(
           cmd,
           { encoding: 'utf8', windowsHide: true, timeout: 15000 },
           (err, stdout, stderr) => {
             if (err) {
               reject(new Error('apiKey 命令执行失败: ' + (stderr || err.message || err)));
               return;
             }
             resolve(String(stdout || '').trim());
           }
         );
       });
     }

     async function resolveApiKey(raw) {
       // 前两个分支（空、$ENV）保持原逻辑，直接 return
       // ...
       if (s.startsWith('!')) {
         const cmd = s.slice(1).trim();
         if (!cmd) return '';
         const hit = apiKeyCmdCache.get(cmd);
         if (hit && hit.pending) return hit.pending;
         if (hit && hit.expires > Date.now()) return hit.value;
         const pending = runApiKeyCommand(cmd);
         apiKeyCmdCache.set(cmd, { pending });
         try {
           const value = await pending;
           apiKeyCmdCache.set(cmd, { value, expires: Date.now() + API_KEY_CMD_TTL_MS });
           return value;
         } catch (e) {
           apiKeyCmdCache.delete(cmd);
           throw e;
         }
       }
       return s;
     }

     function clearApiKeyCache() {
       apiKeyCmdCache.clear();
     }
     ```

     要点：同一命令并发调用时复用同一个 pending Promise；**失败不缓存**；空字符串结果也缓存（命令成功但输出为空属于配置问题，没必要反复执行）。
   - 在 `module.exports` 中追加导出 `clearApiKeyCache`。
   - 第 238、443 行附近改成 `const apiKey = await resolveApiKey(apiKeyRaw);`。
   - **在保存 provider 时失效缓存**：在 `lib/models.js` 写入 `models.json` 的函数里（找写文件 / `atomicWrite` 的地方）调用 `clearApiKeyCache()`，这样用户改了 key 命令后会立即生效。注意 `fetch-models.js` 已经 require 了 `models.js`，反过来 require 会形成循环依赖。可以选择在 `models.js` 里**函数内部延迟 require**（`require('./fetch-models').clearApiKeyCache()`），或者把缓存放到一个新的小模块 `lib/api-key.js` 里，由两边分别引用。推荐后者：新建 `lib/api-key.js`，把 `resolveApiKey`、缓存和 `clearApiKeyCache` 都搬过去，`fetch-models.js` 再 re-export `resolveApiKey` 以保持兼容。

2. **`lib/chat-client.js`**：
   - `function resolveProviderAuth` 改为 `async function resolveProviderAuth`，内部 `const apiKey = await resolveApiKey(apiKeyRaw);`。
   - 三个调用点改成 `const auth = await resolveProviderAuth(providerId);`。
   - 用 `rg -n "resolveProviderAuth" lib test` 确认没有遗漏的调用方（包括测试）。

3. **`lib/ops.js` 的 `runHealth`**：把串行 for 循环中的 key 解析改成并发。推荐结构：
   - 第一遍循环保持同步部分（`add('provider_key:...')`、baseUrl 为空时的 `add`），把需要探测的 provider 收集到数组。
   - 然后对这些 provider 执行 `await Promise.all(list.map(async (p) => { let apiKey = ''; try { apiKey = (await resolveApiKey(full.apiKey)) || ''; } catch {} ...构造 headers... return plan; }))` 得到 `probePlans`。
   - 后续的 `Promise.allSettled(probePlans.map(headRequest))` 保持不变。
   - **结果中各项的顺序必须与原来一致**（按 providers 顺序）。`Promise.all` 本身会保序，不要用 push-on-resolve 的写法。

### 测试

新建 `test/api-key.test.js`（Windows 和类 Unix 都能跑的命令用 `node -e`）：

1. `await resolveApiKey('plain')` 返回 `'plain'`；`$` 环境变量分支正常；空值返回 `''`。
2. `await resolveApiKey('!node -e "console.log(\'abc\')"')` 返回 `'abc'`。
3. **缓存**：`!node -e "console.log(Date.now())"` 连续调用两次，结果相同；`clearApiKeyCache()` 之后再调用，结果不同（中间 `await` 一个 5ms 的 sleep）。
4. **并发去重**：同时发起两次调用（`Promise.all`），结果相同。
5. **失败不缓存**：`!node -e "process.exit(1)"` 两次调用都 reject。
6. **不阻塞事件循环**：调用 `!node -e "setTimeout(()=>console.log(1),300)"` 的同时启动一个 `setInterval(…, 20)` 计数，命令结束时计数应 ≥ 5。

另外，`test/fetch-models-probe.test.js` 和 `test/server-integration.test.js` 原有用例必须仍然通过。

---

## 任务 6（P1）：静态资源支持 ETag/304，修正 HEAD

### 问题

`server.js` 的 `serveStatic`：

- 只发 `Cache-Control: no-cache`，没有 `ETag`/`Last-Modified`，浏览器每次都完整重新下载。涉及的大文件有：`public/vendor/echarts.min.js` 1MB、`public/vendor/lucide.min.js` 358KB、`public/style.css` 172KB、`public/index.html` 83KB。
- 大于 512KB 的文件（echarts）不进内存缓存，每次都 `fs.readFileSync`，阻塞事件循环。
- 对 HEAD 请求也返回完整 body（HTTP 规范要求 HEAD 不带 body）。
- `index.html` 里手写了 `?v=nav-noscroll-1` 这类版本参数来做缓存失效。有了 ETag 之后就不需要了。

### 修复步骤

1. 将签名改为 `serveStatic(req, res, urlPath)`，同步修改 `server.js` 中的两处调用。
2. 根据 `st.size` 和 `st.mtimeMs` 生成弱 ETag：

   ```js
   const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
   ```

3. 在 `stat` 之后、读文件之前判断：

   ```js
   const inm = req.headers['if-none-match'];
   if (inm && inm.split(',').map((s) => s.trim()).includes(etag)) {
     res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl, ...securityHeaders() });
     res.end();
     return;
   }
   ```

4. 200 响应头增加 `ETag`、`Last-Modified: new Date(st.mtimeMs).toUTCString()`、`Content-Length`。
5. `Cache-Control` 策略：
   - `/vendor/` 下的文件（第三方库，基本不变）：`public, max-age=86400`。
   - 其他文件：保持 `no-cache`（配合 ETag 每次都会重新验证，变更能立即生效）。
6. HEAD：头部照常发送（包括 `Content-Length`），然后 `res.end()` 不带 body。
7. 内存缓存：把 `STATIC_CACHE_MAX_BYTES` 提到 `2 * 1024 * 1024`，让 echarts 也能被缓存（public 目录总量有限，现有条目数上限 80 可以保持不变）。
8. 删除 `index.html` 中的 `?v=nav-noscroll-1`、`?v=no-jump-1`、`?v=send-1` 查询参数。`safePublicPath` 只处理 pathname，带不带查询参数对服务端没有影响，这只是清理。
9. **可选**（如果时间允许再做）：对 `text/*`、`application/javascript`、`image/svg+xml` 且请求带 `Accept-Encoding: gzip` 的情况，用 `zlib.gzipSync` 生成压缩内容，并和原文一起缓存在 `staticCache` 条目中。响应加 `Content-Encoding: gzip` 和 `Vary: Accept-Encoding`。只对进入缓存的文件做，避免每次请求都压缩。

### 测试

在 `test/server-integration.test.js` 中（参考其中启动 server 的方式）增加：

- GET `/style.css` 返回 200，并带 `ETag`。
- 带 `If-None-Match: <上一步的 etag>` 再请求，返回 304 且 body 为空。
- HEAD `/style.css` 返回 200，有 `Content-Length`，body 长度为 0。
- GET `/vendor/lucide.min.js` 的 `Cache-Control` 包含 `max-age`。

---

## 任务 7（P2）：缓存 `install.status()` 中的 `where` 查询

### 问题

`lib/install.js` 的 `status()` 每次调用都会执行 `whichSync('npm.cmd')` 和 `whichSync('pi.cmd')`，`installOpenvl` 里还会再调用 2–3 次。`whichSync` 使用同步的 `execFileSync('where', ...)`，在 Windows 上单次约 100ms 甚至更久，会阻塞事件循环。

### 修复步骤

1. 新增一个模块级缓存 `const whichCache = new Map()`，值为 `{ value, expires }`，TTL 设为 60 秒。`whichSync(cmd)` 先查缓存，未命中才执行。
2. 在 `runJob` 的 `child.on('close', ...)` 回调里调用 `whichCache.clear()`，因为安装完成后 PATH 中可能出现新的命令。
3. 可选：改成异步的 `execFile` 加 `await`。但这样 `status()` 和调用它的路由都要改成 async，影响面更大。只做缓存即可。

### 测试

单元测试：连续两次调用 `status()`，第二次耗时明显更短。这个断言会受机器性能影响，可以改为把 `whichSync` 导出，并通过计数或 mock 验证 `execFileSync` 只被调用一次。如果做 mock 太麻烦，这一项可以只做人工验证。

---

## 任务 8（P2）：Origin 校验收紧端口

### 问题

`lib/http-security.js` 的 `checkRequestSecurity` 中，对于非 GET/HEAD/OPTIONS 请求，**只要 Origin 和 Host 都是 loopback，端口不同也放行**：

```js
if (String(port) && o.port && String(o.port) !== String(port) && o.port !== '') {
  if (!(isLoopbackHost(oHost) && isLoopbackHost(reqName))) {
    return 'Origin port mismatch';
  }
}
```

这意味着本机其他端口上的任何网页（比如 `http://localhost:3000` 的某个开发服务器，或者被注入了脚本的本地页面）都能向本控制台发起写操作。本控制台能修改 `models.json`，而 apiKey 支持 `!command` 形式（任务 5），这就构成了**本地网页 → 执行任意命令**的攻击链。

### 修复步骤

1. 默认要求 **Origin 端口与服务端口严格一致**。Origin 没有端口时按协议默认端口处理（http 为 80，https 为 443），一般不会等于 3001，因此会被拒绝。这是预期行为。
2. 增加环境变量逃生口 `PI_MANAGER_ALLOWED_ORIGINS`，逗号分隔的完整 origin 列表（如 `http://localhost:5173`）。列表中的 origin 直接放行，便于前端开发调试。
3. `PI_MANAGER_ALLOW_REMOTE=1` 的现有语义保持不变。
4. 在 README 的安全/配置章节补充 `PI_MANAGER_ALLOWED_ORIGINS` 的说明。

### 测试

在 `test/http-security.test.js` 中增加：

- POST，Host 为 `127.0.0.1:3001`，Origin 为 `http://localhost:3001`：放行（不同 loopback 主机名、同端口仍然允许）。
- POST，Host 为 `127.0.0.1:3001`，Origin 为 `http://localhost:3000`：**拒绝**。
- 同上，但设置了 `PI_MANAGER_ALLOWED_ORIGINS=http://localhost:3000`：放行。测试结束后恢复环境变量。
- 没有 Origin 的 POST：放行（curl 等非浏览器客户端）。

**同时确认** `test/server-integration.test.js` 中的请求没有因此失败。如果它带了不同端口的 Origin，需要修正测试数据，而不是放宽逻辑。

---

## 任务 9（P2）：统一错误到状态码的映射

### 问题

1. `lib/routes/helpers.js` 的 `mapError` 通过匹配 `e.message` 文案来决定状态码（`includes('must be')`、`includes('required')`、`'not found'` 等）。只要改了一句提示文案，状态码就可能变，非常脆弱。
2. 路由文件中大约有 **96 处** 重复写着：

   ```js
   if (e.status) sendError(res, e.status, e.message);
   else mapError(res, e);
   ```

### 修复步骤

1. 在 `mapError` 开头加入：

   ```js
   if (e && Number.isInteger(e.status) && e.status >= 400 && e.status < 600) {
     if (e.status >= 500) console.error(e);
     sendError(res, e.status, e.message || 'Error');
     return;
   }
   ```

2. 用 `rg -n "if \(e\.status\) sendError\(res, e\.status, e\.message\);" lib/routes` 找出所有重复片段，**逐处**确认下一行就是 `else mapError(res, e);` 后，把两行替换为 `mapError(res, e);`。不要用盲目的全局正则替换，有些地方的 else 分支可能不同（例如 `chat.js` 第 235 行是 `sendError(res, e.status || 400, ...)`，保持原样）。
3. **保留**现有的字符串匹配逻辑作为兜底，本次不删，避免行为回归。可选：在 `lib/` 中逐步给抛错的地方补上 `err.status`。这属于长期工作，本次不要求。

### 测试

- `npm test` 全绿即可。现有的 `server-integration.test.js` 覆盖了不少错误码。
- 新增一个针对 `mapError` 的单元测试：用一个假的 `res`（记录 `writeHead` 的 code），分别验证 `{status: 409}`、`{status: 400}`、无 status 的 `'not found'`、无 status 的未知错误，返回码依次为 409、400、404、500。

---

## 任务 10（P3）：杂项清理

逐项独立，做完一项跑一次测试。

1. **硬编码个人路径**：`lib/config.js` 中 `PI_CONFIG_DIR` 的默认值是 `path.resolve('E:/pi_agent/pi_config')`。改为 `path.join(HOME, '.pi', 'config')`（或与 README 中的说明保持一致），**但要先确认用户本机不依赖这个默认值**：检查 `start.bat`、`start-bg.ps1` 是否设置了 `PI_CONFIG_DIR`。如果没有设置，就在 `start.bat` / `start-bg.ps1` 中显式 `set PI_CONFIG_DIR=E:\pi_agent\pi_config`，保证用户自己的启动方式行为不变。README 中补充该环境变量的说明。
2. **测试脚本**：`package.json` 的 `test` 手动列出了 15 个文件，新增的测试很容易漏掉。改为 `"test": "node --test test/"`。改完后确认用例总数 ≥ 148 加上本次新增的数量，并且没有误把非测试文件当成测试执行（`test/` 下如果有 helper/fixture 文件，要确认不会因此报错）。
3. **重复和残留文件**（删除前先 `rg` 确认没有被引用）：
   - `docs/assets/hero.svg` 与 `docs/assets/hero-v2.svg` 内容完全相同（SHA256 一致）。检查 README 引用的是哪个，删除另一个。
   - `templates/workflow/AGENTS_SUBAGENT.md` 与 `public/templates/workflow/AGENTS_SUBAGENT.md` 内容相同。用 `rg -n "templates/workflow" lib public` 查看实际读取的是哪个。如果后端读 `templates/`、前端 fetch `public/templates/`，两份都要保留，就在 `test/` 中加一个断言两者内容一致的测试，防止以后改漂。如果只有一处被使用，就删除另一份。
   - `backups/fetch-models.js.20260924-164828.bak`：已经被 `.gitignore` 的 `*.bak` 忽略，属于本地残留，可以删除整个 `backups/` 目录（**先询问用户**，这可能是用户有意保留的备份）。
4. **SPA 路由**：`server.js` 中一长串 `pathname === '/models' || ...` 改为模块级 `const SPA_ROUTES = new Set([...])`，用 `SPA_ROUTES.has(pathname)` 判断。

---

## 收尾检查清单

- [ ] `npm test` 全绿，用例数 = 148 + 新增数量。
- [ ] `node server.js` 能正常启动，浏览器访问 `http://localhost:3001`：
  - [ ] 控制台没有 CSP 报错，切换主题后刷新不闪烁（任务 3）
  - [ ] Network 面板中第二次加载静态资源返回 304（任务 6）
  - [ ] 聊天发长消息时中途关闭标签页，上游请求被中止（任务 1）
  - [ ] 保存含大量中文的 AGENTS.md 后重新打开，内容完全一致（任务 2）
  - [ ] 引导/安装页显示的 agents 目录正确（任务 4）
- [ ] `git diff` 中没有误改用户原有的未提交改动。
- [ ] 没有引入任何 npm 依赖。
- [ ] 向用户汇报：每个任务做了什么、新增了哪些测试、哪些可选项没做以及原因。
