/**
 * 子进程里把 pi 扩展"跑"一遍，只为捕获 registerTool 的真实工具定义。
 *
 * 为什么必须跑：扩展的工具 schema 由 typebox 在运行时生成，静态读源码拿不到尺寸。
 * 安全性：整个探测在独立子进程内完成，pi API 用 mock 顶掉，扩展的顶层副作用随
 *         进程结束；解析失败或超时都返回空数组，调用方退化成"只列工具名"。
 *
 * 入口：node --import ./register-hooks.mjs extension-tools.mjs
 * 入参：环境变量 PI_PROBE_PKG（pi 包目录）、PI_PROBE_FILES（扩展入口文件 JSON 数组）
 * 输出：stdout 一行 JSON —— [{ name, chars, hasSchema }]
 */
import { pathToFileURL } from 'node:url';

const files = JSON.parse(process.env.PI_PROBE_FILES || '[]');
const tools = [];

const noop = () => {};
const pi = new Proxy(
  {},
  {
    get(_target, key) {
      if (key === 'registerTool') {
        return (def) => {
          if (def && def.name) tools.push(def);
        };
      }
      if (key === 'getAllTools' || key === 'getCommands' || key === 'getAgentDir') return () => [];
      return noop;
    },
  }
);

for (const file of files) {
  try {
    const mod = await import(pathToFileURL(file).href);
    const factory = mod && (mod.default || mod.extension);
    if (typeof factory === 'function') await factory(pi);
  } catch (error) {
    process.stderr.write('[skip] ' + file + ': ' + ((error && error.message) || error) + '\n');
  }
}

const out = tools.map((t) => {
  let schema = '';
  try {
    schema = JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters });
  } catch {
    schema = JSON.stringify({ name: t.name, description: t.description });
  }
  return {
    name: t.name,
    chars: schema.length,
    hasSchema: !!t.parameters,
    guidelines: Array.isArray(t.promptGuidelines) ? t.promptGuidelines.length : 0,
  };
});

process.stdout.write(JSON.stringify(out));
