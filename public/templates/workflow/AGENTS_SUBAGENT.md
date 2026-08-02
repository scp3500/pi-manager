# 子代理工作流（内置只读模板）

> 这是 Pi Manager 内置的说明模板。配置工作区 `map.workflows` 并在该目录下放置同名文件后，可在「子代理 → 工作流」中编辑你自己的版本。

## 几套流程（速查）

| 类型 | 流程 |
|------|------|
| 开发 | planner → 确认计划 → worker → reviewer 闭环 |
| 研究 | planner → 确认方向 → researcher 并行搜到饱和 → 主 Agent 综合 |
| 调试 | investigator 根因 → 确认 → planner → worker → reviewer → 验证 |

## 并行

- 互不依赖用 subagent **`tasks` 数组**并行
- 共享文件（index/log/manifest）禁止并发写，改由主 Agent 汇总写入

## 停 / 不停

- **要停**：planner 出计划后；信息死角无法判断
- **不停**：researcher 补搜、reviewer 打回（有轮次上限）

## 指令模板

- `/plan-and-implement`
- `/implement-and-review`
- `/debug`
- `/deep-research`
- `/verify`

## 记忆

平台经验写入工作区 `memory/`（按 learnings / projects / tools / archive 分类）。完整规则在用户自己的 `AGENTS_SUBAGENT.md` 中维护。
