# Pi Manager

本地 Web 控制台，用于管理 [Pi Coding Agent](https://github.com/badlogic/pi-mono) 的本机配置与资源。

浏览器打开即可编辑模型、子代理、提示词、会话与用量；配合终端里的 Pi 一起使用。

![Node ≥18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![npm deps](https://img.shields.io/badge/npm%20deps-0-lightgrey)
![port](https://img.shields.io/badge/default%20port-3001-blue)

---

## 功能

| 模块 | 说明 |
|------|------|
| **总览** | 默认模型、就绪状态、今日用量、缓存命中、临时文件清理 |
| **运行** | 从 session jsonl 推断当前任务 / 工具 / 子代理状态 |
| **模型** | 编辑 `models.json`、默认模型、拉取远程模型列表 |
| **子代理** | 管理 `agents/*.md`，工具权限与 Prompt |
| **用量** | 汇总 sessions 费用与 token（`usage.cost.total` 原值累加，显示 ¥） |
| **会话** | 浏览 / 搜索 / 清理 `sessions/**/*.jsonl` |
| **提示词 · Skills · 插件** | `AGENTS.md`、skills 开关、packages / extensions |
| **工作区** | 映射本机目录为记忆 / 知识库等内容根 |
| **识图** | 管理 [OpenVL](https://github.com/scp3500/openvl) 配置（可选） |
| **教程** | 安装说明、外链，以及白名单一键安装 |
| **内嵌助手** | 控制台内聊天与管理类工具（写操作需确认） |
| **搜索 · 健康检查 · 导出** | 跨资源检索、配置体检、脱敏 JSON 备份 |

设计要点：

- 零框架：Node 内置 `http` + 静态前端，无需打包
- 读写本机 `~/.pi/agent`（可用环境变量覆盖）
- 可选组件缺失时降级，核心页仍可用
- 路径使用 `~/` 展开，避免写死用户名绝对路径

---

## 相关项目与依赖

```
        Pi Manager (本仓库)  ·  localhost:3001
                 │
     ┌───────────┼───────────┐
     ▼           ▼           ▼
 Pi Coding    工作区目录    OpenVL（可选）
 Agent 配置   memory/kb    @scp3500/openvl
```

| 组件 | 关系 | 缺失时 |
|------|------|--------|
| **[Pi Coding Agent](https://github.com/badlogic/pi-mono)** | 数据面依赖：读写 `models.json`、`settings.json`、`agents/`、`sessions/` 等 | 页面可开，几乎无配置可管 |
| **Node.js ≥ 18** | 运行面依赖 | 无法启动 |
| **[OpenVL](https://github.com/scp3500/openvl)**（`@scp3500/openvl`） | 可选识图 | 识图页提示安装，其它功能正常 |
| **工作区映射** | 可选：记忆 / 知识库 / 工作流文档 | 对应页为空状态，核心仍可用 |
| **Pi packages / extensions / skills** | 由 Pi 安装；本控制台提供列表编辑与教程一键装 npm 包 | 列表为空或仅显示已有项 |

控制台自身 **npm dependencies 为 0**。界面中的「插件 / Skills」对应 Pi 的 `settings.json` 配置，以及本机已安装的扩展。

---

## 快速开始

### 1. 准备 Pi

确保本机可运行 Pi，并存在配置目录（默认）：

```text
~/.pi/agent/          # Windows: %USERPROFILE%\.pi\agent\
  models.json
  settings.json
  agents/
  sessions/
```

### 2. 启动

```bash
git clone https://github.com/scp3500/pi-manager.git
cd pi-manager
npm start
# Windows 也可双击 start.bat（默认后台，日志在 logs/）
```

打开：http://localhost:3001  

停止：`stop.bat`，或结束占用端口的进程。

### 3. 可选：OpenVL 识图

```bash
npm install -g @scp3500/openvl
```

或在控制台 **教程 → 识图** 使用一键安装。

### 4. 可选：记忆 / 知识库

1. **工作区** → 添加本机根目录  
2. 映射示例：`{ "memory": "memory", "knowledge": "knowledge" }`  
3. 打开「记忆 / 知识库」页  

更细的操作说明见应用内 **更多 → 教程**。

---

## 环境变量

| 变量 | 默认 | 含义 |
|------|------|------|
| `PORT` | `3001` | HTTP 端口 |
| `PI_AGENT_DIR` | `~/.pi/agent` | Pi 配置根 |
| `PI_MANAGER_CONFIG` | `$PI_AGENT_DIR/pi-manager.json` | 本控制台配置（工作区等） |
| `OPENVL_PKG_DIR` | 自动探测 | OpenVL 安装目录 |

---

## 安全

- 默认本机访问；请勿将端口裸暴露到公网
- 导出配置会脱敏 API Key；不要把含密钥的 `models.json` / `.env` 提交到 Git
- 写操作会修改本机 Pi 配置；重要文件有滚动 `.bak`，仍建议自行备份
- 教程页一键安装仅允许白名单命令（如 `npm i -g @scp3500/openvl`、`pi install npm:…`）
- 第三方 Pi 包拥有本机完整权限，安装前请阅读来源与源码

---

## 项目结构

```text
pi-manager/
├── server.js          # HTTP + /api/*
├── lib/               # 业务模块
├── public/            # 静态前端（hash 路由）
├── start.bat          # Windows 启动（默认后台）
├── stop.bat
├── package.json       # 无 dependencies
├── docs/
│   ├── DEVELOPMENT.md # 开发 / API / 约束（原长 README）
│   └── UI.md          # UI 交接说明
└── test/
```

---

## 开发

```bash
npm start          # 启动
npm test           # node --test
```

静态资源改完刷新浏览器（建议 Ctrl+F5）；改 `server.js` / `lib/*` 需重启进程。

完整 API 列表、路由表与行为约束见 [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)。

---

## 已知限制

- **运行页**基于 jsonl 推断；进程退出后会尽量标为已退出，多窗口时无法精确对应 PID↔session
- **用量**首次全量扫描 sessions 可能较慢，之后有磁盘/内存缓存
- **内嵌助手**会话与 Pi 主 session 隔离，不计入 Pi sessions 用量文件

---

## 致谢

- [Pi Coding Agent](https://github.com/badlogic/pi-mono)
- [OpenVL](https://github.com/scp3500/openvl)
- 用量解析参考社区 session 统计工具（见 `lib/usage.js` 文件头）

---

## License

[MIT](./LICENSE)
