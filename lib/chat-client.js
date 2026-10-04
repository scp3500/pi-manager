/**
 * Upstream OpenAI-compatible chat completions (stream + non-stream).
 */
const { getProvider, providerExists } = require('./models');
const { resolveApiKey, assertHeaderSafe } = require('./fetch-models');
const assertHeader = assertHeaderSafe;

function chatCompletionsEndpoint(baseUrl) {
  let endpoint = String(baseUrl || '')
    .trim()
    .replace(/\/+$/, '');
  if (!endpoint) throw new Error('Base URL 为空');
  if (!/^https?:\/\//i.test(endpoint)) endpoint = 'https://' + endpoint;
  if (/\/chat\/completions$/i.test(endpoint) || /\/responses$/i.test(endpoint)) {
    return endpoint;
  }
  if (/\/v1$/i.test(endpoint) || /\/v1\//i.test(endpoint)) {
    return endpoint.replace(/\/+$/, '') + '/chat/completions';
  }
  return endpoint.replace(/\/+$/, '') + '/v1/chat/completions';
}

async function resolveProviderAuth(providerId) {
  if (!providerId || !providerExists(providerId)) {
    const err = new Error('provider not found: ' + providerId);
    err.status = 400;
    throw err;
  }
  // 内部上游调用需要真实 Key；getProvider 默认脱敏为空字符串
  const p = getProvider(providerId, { revealKey: true });
  const baseUrl = String(p.baseUrl || '').trim();
  if (!baseUrl) {
    const err = new Error('Base URL 为空');
    err.status = 400;
    throw err;
  }
  if (/chatgpt\.com\/backend-api\/codex/i.test(baseUrl) || /codex-responses/i.test(String(p.api || ''))) {
    const err = new Error('Codex 类后端不支持标准 chat completions，请换其他模型');
    err.status = 400;
    throw err;
  }

  const isGemini = /google-generative-ai/i.test(String(p.api || ''));

  let apiKeyRaw = p.apiKey;
  if (typeof apiKeyRaw === 'string' && /^[•·.]+$/.test(apiKeyRaw.trim())) {
    const err = new Error('API Key 为掩码，无法调用。请在模型页重新填写真实 Key');
    err.status = 400;
    throw err;
  }
  const apiKey = await resolveApiKey(apiKeyRaw);
  if (!apiKey) {
    const err = new Error('API Key 未配置');
    err.status = 400;
    throw err;
  }
  assertHeader(apiKey, 'API Key');

  const headers = {
    Accept: 'text/event-stream, application/json',
    'Content-Type': 'application/json',
  };
  const extra = p.headers && typeof p.headers === 'object' ? p.headers : {};
  for (const [k, v] of Object.entries(extra)) {
    if (v != null) headers[k] = assertHeader(String(v), 'Header ' + k);
  }
  if (isGemini) {
    headers['x-goog-api-key'] = apiKey;
  } else if (p.authHeader !== false) {
    headers.Authorization = 'Bearer ' + apiKey;
  } else {
    headers['x-api-key'] = apiKey;
  }

  return {
    endpoint: isGemini ? baseUrl : chatCompletionsEndpoint(baseUrl),
    headers,
    apiType: p.api || 'openai-completions',
    apiKey,
    isGemini,
    provider: p,
  };
}

/**
 * Build OpenAI messages array from manager chat messages.
 * @param {Array} messages
 * @param {string} systemPrompt
 */
function buildOpenAIMessages(messages, systemPrompt) {
  const out = [];
  if (systemPrompt) {
    out.push({ role: 'system', content: systemPrompt });
  }
  for (const m of messages || []) {
    if (!m || !m.role) continue;
    if (m.role === 'system') continue;
    if (m.status === 'error' && !m.content && !(m.toolCalls && m.toolCalls.length)) continue;

    // OpenAI tool result messages
    if (m.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId || m.id || '',
        content: String(m.content || ''),
      });
      continue;
    }

    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = String(m.content || '');
    if (!content && role === 'user') continue;
    // Skip incomplete empty assistant placeholders
    if (
      role === 'assistant' &&
      !content &&
      m.status === 'streaming' &&
      !(m.toolCalls && m.toolCalls.length)
    ) {
      continue;
    }

    const msg = { role, content: content || (role === 'assistant' ? null : '') };
    if (role === 'assistant' && m.toolCalls && m.toolCalls.length) {
      msg.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments:
            typeof tc.arguments === 'string'
              ? tc.arguments
              : JSON.stringify(tc.arguments || {}),
        },
      }));
      // some providers want content string even with tool_calls
      if (msg.content == null) msg.content = '';
    }
    if (msg.content == null) delete msg.content;
    out.push(msg);
  }
  return out;
}

function mergeToolCallDeltas(targetMap, toolCallsDelta) {
  if (!Array.isArray(toolCallsDelta)) return;
  for (const tc of toolCallsDelta) {
    const idx = tc.index != null ? tc.index : 0;
    if (!targetMap.has(idx)) {
      targetMap.set(idx, {
        id: '',
        name: '',
        arguments: '',
      });
    }
    const cur = targetMap.get(idx);
    if (tc.id) cur.id = String(tc.id);
    const fn = tc.function || {};
    if (fn.name) cur.name = (cur.name || '') + String(fn.name);
    if (fn.arguments != null) cur.arguments = (cur.arguments || '') + String(fn.arguments);
  }
}

function toolCallsFromMap(map) {
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({
      id: v.id || 'call_' + Math.random().toString(36).slice(2, 10),
      name: v.name || '',
      arguments: v.arguments || '{}',
    }))
    .filter((t) => t.name);
}

function isGeminiApi(apiType) {
  return /google-generative-ai/i.test(String(apiType || ''));
}

function geminiEndpoint(auth, model, stream) {
  return (
    auth.endpoint +
    '/models/' +
    encodeURIComponent(model || 'test') +
    (stream ? ':streamGenerateContent?alt=sse' : ':generateContent')
  );
}

function toGeminiContents(messages, systemPrompt) {
  const contents = [];
  for (const m of messages || []) {
    if (!m || !m.role || m.status === 'error') continue;
    if (m.role === 'tool') {
      const err = new Error('Gemini 格式暂不支持工具消息');
      err.status = 400;
      throw err;
    }
    const role = m.role === 'assistant' ? 'model' : 'user';
    const text = String(m.content || '');
    if (!text && m.role !== 'user') continue;
    contents.push({ role, parts: [{ text }] });
  }
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: '' }] });
  const body = { contents };
  if (systemPrompt) body.systemInstruction = { parts: [{ text: String(systemPrompt) }] };
  return body;
}

function partsToTextAndReasoning(parts) {
  let text = '';
  let reasoning = '';
  for (const p of parts || []) {
    if (p == null || typeof p !== 'object') continue;
    const s = p.text != null ? String(p.text) : '';
    if (!s) continue;
    if (p.thought) reasoning += s;
    else text += s;
  }
  return { text, reasoning };
}

function normalizeGeminiUsage(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    promptTokens: Number(u.promptTokenCount || 0) || 0,
    completionTokens: Number(u.candidatesTokenCount || 0) || 0,
    totalTokens: Number(u.totalTokenCount || 0) || 0,
    cachedTokens: Number(u.cachedContentTokenCount || 0) || 0,
  };
}

function parseGeminiError(text, status) {
  if (!text) return '上游错误 HTTP ' + status;
  try {
    const j = JSON.parse(text);
    if (j.error) {
      const e = j.error;
      return String(e.message || e.status || e.type || JSON.stringify(e)).slice(0, 300);
    }
    if (j.message) return String(j.message).slice(0, 300);
  } catch {
    /* fallthrough */
  }
  return ('上游错误 HTTP ' + status + ': ' + String(text)).slice(0, 300);
}

async function geminiGenerate(auth, { model, messages, systemPrompt, signal, maxTokens }) {
  const body = toGeminiContents(messages, systemPrompt);
  if (maxTokens) body.generationConfig = { maxOutputTokens: maxTokens };
  const res = await fetch(geminiEndpoint(auth, model, false), {
    method: 'POST',
    headers: { ...auth.headers, Accept: 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(parseGeminiError(text, res.status));
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('上游返回非 JSON');
  }
  const cand = data.candidates && data.candidates[0];
  const { text: content, reasoning } = partsToTextAndReasoning(
    cand && cand.content && cand.content.parts
  );
  const usage = normalizeGeminiUsage(data.usageMetadata);
  return { content, reasoning, usage, raw: data };
}

async function geminiStream(auth, { model, messages, systemPrompt, signal, onEvent }) {
  const body = toGeminiContents(messages, systemPrompt);
  const res = await fetch(geminiEndpoint(auth, model, true), {
    method: 'POST',
    headers: auth.headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(parseGeminiError(await res.text().catch(() => ''), res.status));

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let fullText = '';
  let fullReasoning = '';
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr) continue;
      let payload;
      try {
        payload = JSON.parse(dataStr);
      } catch {
        continue;
      }
      if (payload.usageMetadata) usage = normalizeGeminiUsage(payload.usageMetadata);
      const cand = payload.candidates && payload.candidates[0];
      const parts = (cand && cand.content && cand.content.parts) || [];
      for (const part of parts) {
        if (part == null || part.text == null) continue;
        if (part.thought) {
          fullReasoning += part.text;
          if (onEvent) onEvent({ type: 'delta', reasoning: String(part.text) });
        } else {
          fullText += part.text;
          if (onEvent) onEvent({ type: 'delta', text: String(part.text) });
        }
      }
    }
  }
  if (buffer.trim().startsWith('data:')) {
    const dataStr = buffer.trim().slice(5).trim();
    if (dataStr) {
      try {
        const payload = JSON.parse(dataStr);
        if (payload.usageMetadata) usage = normalizeGeminiUsage(payload.usageMetadata);
      } catch {
        /* ignore */
      }
    }
  }
  if (onEvent) onEvent({ type: 'done', usage, toolCalls: [] });
  return { content: fullText, reasoning: fullReasoning, usage, toolCalls: [] };
}

/**
 * Non-streaming completion (for title etc.)
 */
async function completeChat({ providerId, model, messages, systemPrompt, signal, maxTokens }) {
  const auth = await resolveProviderAuth(providerId);
  if (auth.isGemini) {
    return geminiGenerate(auth, { model, messages, systemPrompt, signal, maxTokens });
  }
  const { endpoint, headers } = auth;
  const body = {
    model,
    messages: buildOpenAIMessages(messages, systemPrompt),
    stream: false,
  };
  if (maxTokens) body.max_tokens = maxTokens;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { ...headers, Accept: 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(parseErrorBody(text, res.status));
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('上游返回非 JSON');
  }
  const choice = data.choices && data.choices[0];
  const msg = choice && (choice.message || choice.delta);
  const content = msg && msg.content != null ? String(msg.content) : '';
  const reasoning =
    (msg && (msg.reasoning_content || msg.reasoning)) != null
      ? String(msg.reasoning_content || msg.reasoning)
      : '';
  const usage = normalizeUsage(data.usage);
  return { content, reasoning, usage, raw: data };
}

/**
 * Stream completion; calls onEvent({type, text?, reasoning?, usage?})
 * type: delta | usage | done
 */
async function streamChat({
  providerId,
  model,
  messages,
  systemPrompt,
  signal,
  onEvent,
  tools,
  toolChoice,
}) {
  const auth = await resolveProviderAuth(providerId);
  if (auth.isGemini) {
    return geminiStream(auth, { model, messages, systemPrompt, signal, onEvent });
  }
  const { endpoint, headers } = auth;
  const body = {
    model,
    messages: buildOpenAIMessages(messages, systemPrompt),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = toolChoice || 'auto';
  }

  async function doFetch(payload) {
    return fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    });
  }

  let res;
  try {
    res = await doFetch(body);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw e;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    // retry without stream_options
    if (res.status === 400 && /stream_options/i.test(errText)) {
      const b2 = { ...body };
      delete b2.stream_options;
      res = await doFetch(b2);
      if (!res.ok) throw new Error(parseErrorBody(await res.text().catch(() => ''), res.status));
    } else if (res.status === 400 && tools && tools.length && /tool/i.test(errText)) {
      // provider rejects tools — retry without tools
      const b2 = { ...body };
      delete b2.tools;
      delete b2.tool_choice;
      res = await doFetch(b2);
      if (!res.ok) throw new Error(parseErrorBody(await res.text().catch(() => ''), res.status));
    } else {
      throw new Error(parseErrorBody(errText, res.status));
    }
  }

  const ct = String(res.headers.get('content-type') || '');
  // Some proxies return full JSON even when stream:true
  if (ct.includes('application/json') && !ct.includes('event-stream')) {
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('上游返回无法解析的 JSON');
    }
    const choice = data.choices && data.choices[0];
    const msg = choice && (choice.message || choice.delta);
    const content = msg && msg.content != null ? String(msg.content) : '';
    const reasoning =
      msg && (msg.reasoning_content || msg.reasoning)
        ? String(msg.reasoning_content || msg.reasoning)
        : '';
    const toolCalls = normalizeToolCalls(msg && msg.tool_calls);
    if (reasoning && onEvent) onEvent({ type: 'delta', reasoning });
    if (content && onEvent) onEvent({ type: 'delta', text: content });
    const usage = normalizeUsage(data.usage);
    if (usage && onEvent) onEvent({ type: 'usage', usage });
    if (onEvent) onEvent({ type: 'done', usage, toolCalls });
    return { content, reasoning, usage, toolCalls };
  }

  let fullText = '';
  let fullReasoning = '';
  let usage = null;
  const toolMap = new Map();

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const handlePayload = (payload) => {
    if (payload.error) throw new Error(formatUpstreamError(payload.error));
    const choice = payload.choices && payload.choices[0];
    const delta = (choice && (choice.delta || choice.message)) || {};
    const t = delta.content != null ? String(delta.content) : '';
    const r =
      delta.reasoning_content != null
        ? String(delta.reasoning_content)
        : delta.reasoning != null
          ? String(delta.reasoning)
          : '';
    if (t) {
      fullText += t;
      if (onEvent) onEvent({ type: 'delta', text: t });
    }
    if (r) {
      fullReasoning += r;
      if (onEvent) onEvent({ type: 'delta', reasoning: r });
    }
    if (delta.tool_calls) mergeToolCallDeltas(toolMap, delta.tool_calls);
    // non-stream style full message in chunk
    if (delta.tool_calls == null && choice && choice.message && choice.message.tool_calls) {
      normalizeToolCalls(choice.message.tool_calls).forEach((tc, i) => {
        toolMap.set(i, {
          id: tc.id,
          name: tc.name,
          arguments:
            typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}),
        });
      });
    }
    if (payload.usage) {
      usage = normalizeUsage(payload.usage);
      if (onEvent) onEvent({ type: 'usage', usage });
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue;
      if (!trimmed.startsWith('data:')) continue;
      const dataStr = trimmed.slice(5).trim();
      if (dataStr === '[DONE]') {
        const toolCalls = toolCallsFromMap(toolMap);
        if (onEvent) onEvent({ type: 'done', usage, toolCalls });
        return { content: fullText, reasoning: fullReasoning, usage, toolCalls };
      }
      let payload;
      try {
        payload = JSON.parse(dataStr);
      } catch {
        continue;
      }
      handlePayload(payload);
    }
  }

  // flush remaining buffer
  if (buffer.trim().startsWith('data:')) {
    const dataStr = buffer.trim().slice(5).trim();
    if (dataStr && dataStr !== '[DONE]') {
      try {
        handlePayload(JSON.parse(dataStr));
      } catch {
        /* ignore */
      }
    }
  }

  const toolCalls = toolCallsFromMap(toolMap);
  if (onEvent) onEvent({ type: 'done', usage, toolCalls });
  return { content: fullText, reasoning: fullReasoning, usage, toolCalls };
}

function normalizeToolCalls(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((tc) => {
      const fn = tc.function || {};
      return {
        id: tc.id || 'call_' + Math.random().toString(36).slice(2, 10),
        name: fn.name || tc.name || '',
        arguments: fn.arguments != null ? fn.arguments : tc.arguments || '{}',
      };
    })
    .filter((t) => t.name);
}

/**
 * Agent loop: stream → if tool_calls, execute → re-stream (maxSteps).
 * onEvent: delta | usage | tool_call | tool_result | done
 */
async function runChatWithTools({
  providerId,
  model,
  messages,
  systemPrompt,
  signal,
  onEvent,
  tools,
  executeTool,
  maxSteps = 4,
}) {
  // gemini 原生格式不支持 manager 工具循环，直接单轮流式
  const auth = await resolveProviderAuth(providerId);
  if (auth.isGemini) {
    return streamChat({
      providerId,
      model,
      messages,
      systemPrompt,
      signal,
      onEvent,
      tools: null,
      toolChoice: undefined,
    });
  }

  // working copy of OpenAI-oriented messages (manager format)
  let history = (messages || []).map((m) => ({ ...m }));
  let fullText = '';
  let fullReasoning = '';
  let usageAcc = null;
  const toolsUsed = [];
  const openaiTools = tools && tools.length ? tools : null;

  for (let step = 0; step < maxSteps; step++) {
    if (signal && signal.aborted) break;
    const stepTextParts = [];
    let stepReasoning = '';
    let stepUsage = null;
    let toolCalls = [];

    const result = await streamChat({
      providerId,
      model,
      messages: history,
      systemPrompt,
      signal,
      tools: openaiTools,
      toolChoice: openaiTools ? 'auto' : undefined,
      onEvent: (ev) => {
        if (ev.type === 'delta') {
          if (ev.text) {
            stepTextParts.push(ev.text);
            fullText += ev.text;
            if (onEvent) onEvent({ type: 'delta', text: ev.text });
          }
          if (ev.reasoning) {
            stepReasoning += ev.reasoning;
            fullReasoning += ev.reasoning;
            if (onEvent) onEvent({ type: 'delta', reasoning: ev.reasoning });
          }
        } else if (ev.type === 'usage' && ev.usage) {
          stepUsage = ev.usage;
          usageAcc = mergeUsage(usageAcc, ev.usage);
          if (onEvent) onEvent({ type: 'usage', usage: usageAcc });
        } else if (ev.type === 'done') {
          toolCalls = ev.toolCalls || [];
        }
      },
    });

    if (result.toolCalls && result.toolCalls.length) toolCalls = result.toolCalls;
    if (result.usage) {
      stepUsage = result.usage;
      usageAcc = mergeUsage(usageAcc, result.usage);
    }
    // if streamChat already appended via onEvent, fullText is set; ensure sync
    if (result.content && !stepTextParts.length) {
      fullText += result.content;
      if (onEvent) onEvent({ type: 'delta', text: result.content });
    }
    if (result.reasoning && !stepReasoning) {
      fullReasoning += result.reasoning;
      if (onEvent) onEvent({ type: 'delta', reasoning: result.reasoning });
    }

    if (!toolCalls.length) {
      if (onEvent) onEvent({ type: 'done', usage: usageAcc, toolCalls: [] });
      return {
        content: fullText,
        reasoning: fullReasoning,
        usage: usageAcc,
        tools: toolsUsed,
      };
    }

    if (typeof executeTool !== 'function') {
      // cannot execute — surface as text
      if (onEvent) onEvent({ type: 'done', usage: usageAcc, toolCalls });
      return {
        content: fullText,
        reasoning: fullReasoning,
        usage: usageAcc,
        tools: toolsUsed,
        toolCalls,
      };
    }

    // push assistant message with tool_calls into history (content may be empty)
    const asstContent = stepTextParts.join('') || result.content || '';
    history.push({
      role: 'assistant',
      content: asstContent,
      toolCalls: toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      })),
      status: 'done',
    });

    for (const tc of toolCalls) {
      if (signal && signal.aborted) break;
      let args = {};
      try {
        args =
          typeof tc.arguments === 'string'
            ? tc.arguments.trim()
              ? JSON.parse(tc.arguments)
              : {}
            : tc.arguments || {};
      } catch {
        args = { _raw: String(tc.arguments || '') };
      }
      if (onEvent) {
        onEvent({
          type: 'tool_call',
          id: tc.id,
          name: tc.name,
          args,
        });
      }
      let toolResult;
      try {
        toolResult = await executeTool(tc.name, args);
      } catch (e) {
        toolResult = {
          ok: false,
          name: tc.name,
          args,
          error: e.message || String(e),
          text: '工具失败: ' + (e.message || e),
          data: null,
          ms: 0,
        };
      }
      toolsUsed.push({
        id: tc.id,
        name: tc.name,
        input: args,
        output: toolResult.data != null ? toolResult.data : null,
        approval: 'auto',
        status: toolResult.ok ? 'done' : 'error',
        ms: toolResult.ms,
        error: toolResult.error || null,
        text: toolResult.text,
      });
      if (onEvent) {
        onEvent({
          type: 'tool_result',
          id: tc.id,
          name: tc.name,
          ok: !!toolResult.ok,
          ms: toolResult.ms,
          args,
          data: toolResult.data,
          error: toolResult.error || null,
          text: toolResult.text,
        });
      }
      const toolContent =
        toolResult.text ||
        (toolResult.data != null ? JSON.stringify(toolResult.data) : toolResult.error || '');
      history.push({
        role: 'tool',
        toolCallId: tc.id,
        content: String(toolContent).slice(0, 12000),
        status: 'done',
      });
    }
    // continue loop for model to produce final answer
  }

  if (onEvent) onEvent({ type: 'done', usage: usageAcc, toolCalls: [] });
  return {
    content: fullText,
    reasoning: fullReasoning,
    usage: usageAcc,
    tools: toolsUsed,
  };
}

function mergeUsage(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return {
    promptTokens: (a.promptTokens || 0) + (b.promptTokens || 0),
    completionTokens: (a.completionTokens || 0) + (b.completionTokens || 0),
    totalTokens: (a.totalTokens || 0) + (b.totalTokens || 0),
    cachedTokens: (a.cachedTokens || 0) + (b.cachedTokens || 0),
  };
}

function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    promptTokens: Number(u.prompt_tokens || u.input_tokens || 0) || 0,
    completionTokens: Number(u.completion_tokens || u.output_tokens || 0) || 0,
    totalTokens: Number(u.total_tokens || 0) || 0,
    cachedTokens:
      Number(
        (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) ||
          u.cached_tokens ||
          0
      ) || 0,
  };
}

function parseErrorBody(text, status) {
  if (!text) return '上游错误 HTTP ' + status;
  try {
    const j = JSON.parse(text);
    if (j.error) return formatUpstreamError(j.error);
    if (j.message) return String(j.message).slice(0, 300);
  } catch {
    /* fallthrough */
  }
  return ('上游错误 HTTP ' + status + ': ' + String(text)).slice(0, 300);
}

function formatUpstreamError(err) {
  if (typeof err === 'string') return err.slice(0, 300);
  if (err && typeof err === 'object') {
    return String(err.message || err.code || JSON.stringify(err)).slice(0, 300);
  }
  return '上游错误';
}

async function generateTitle({ providerId, model, userText, assistantText, signal }) {
  const content = [
    '根据下列对话写一个短标题。',
    '1. 语言与用户一致',
    '2. 不要标点或特殊符号',
    '3. 直接输出标题',
    '4. 不超过 16 个字',
    '',
    '<content>',
    '用户: ' + String(userText || '').slice(0, 500),
    '助手: ' + String(assistantText || '').slice(0, 500),
    '</content>',
  ].join('\n');

  try {
    const r = await completeChat({
      providerId,
      model,
      messages: [{ role: 'user', content }],
      systemPrompt: '你只输出短标题，不要解释。',
      signal,
      maxTokens: 32,
    });
    let title = String(r.content || '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/["""'']/g, '')
      .replace(/[。！？.!?，,、:：;；]/g, '')
      .trim();
    if (title.length > 24) title = title.slice(0, 24);
    return title || fallbackTitle(userText);
  } catch {
    return fallbackTitle(userText);
  }
}

function fallbackTitle(userText) {
  const t = String(userText || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '新对话';
  return t.length > 16 ? t.slice(0, 16) + '…' : t;
}

module.exports = {
  resolveProviderAuth,
  buildOpenAIMessages,
  completeChat,
  streamChat,
  runChatWithTools,
  generateTitle,
  fallbackTitle,
  chatCompletionsEndpoint,
};
