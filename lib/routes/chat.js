const chatApi = require('../chat');
const chatClient = require('../chat-client');
const chatTools = require('../chat-tools');
const {
  sendJson,
  sendError,
  readBody,
  decodeSeg,
  mapError,
  writeSse,
} = require('./helpers');

/** @type {Map<string, AbortController>} */
const chatAbortMap = new Map();

async function handleChatApi(req, res, pathname, method) {
  if (!pathname.startsWith('/api/chat')) return false;

  // GET /api/chat/models
  if (method === 'GET' && pathname === '/api/chat/models') {
    try {
      sendJson(res, 200, chatApi.listChatModels());
    } catch (e) {
      mapError(res, e);
    }
    return true;
  }

  // GET /api/chat/tools
  if (method === 'GET' && pathname === '/api/chat/tools') {
    try {
      sendJson(res, 200, { tools: chatTools.listTools() });
    } catch (e) {
      mapError(res, e);
    }
    return true;
  }

  // POST /api/chat/tools/run  { name, args }
  if (method === 'POST' && pathname === '/api/chat/tools/run') {
    try {
      const body = await readBody(req);
      const name = body && body.name;
      if (!name) {
        sendError(res, 400, 'name required');
        return true;
      }
      const result = await chatTools.runTool(String(name), body.args || {});
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (e) {
      if (e.status) sendError(res, e.status, e.message);
      else mapError(res, e);
    }
    return true;
  }

  // POST /api/chat/tools/confirm  { confirmId }
  if (method === 'POST' && pathname === '/api/chat/tools/confirm') {
    try {
      const body = await readBody(req);
      const confirmId = body && body.confirmId;
      if (!confirmId) {
        sendError(res, 400, 'confirmId required');
        return true;
      }
      const result = await chatTools.confirmWrite(String(confirmId));
      sendJson(res, 200, result);
    } catch (e) {
      if (e.status) sendError(res, e.status, e.message);
      else mapError(res, e);
    }
    return true;
  }

  // POST /api/chat/tools/reject  { confirmId }
  if (method === 'POST' && pathname === '/api/chat/tools/reject') {
    try {
      const body = await readBody(req);
      sendJson(res, 200, chatTools.rejectWrite(body && body.confirmId));
    } catch (e) {
      if (e.status) sendError(res, e.status, e.message);
      else mapError(res, e);
    }
    return true;
  }

  // GET /api/chat/sessions
  if (method === 'GET' && pathname === '/api/chat/sessions') {
    try {
      sendJson(res, 200, chatApi.listSessions());
    } catch (e) {
      mapError(res, e);
    }
    return true;
  }

  // POST /api/chat/sessions
  if (method === 'POST' && pathname === '/api/chat/sessions') {
    try {
      const body = await readBody(req);
      const session = chatApi.createSession(body || {});
      sendJson(res, 200, session);
    } catch (e) {
      if (e.status) sendError(res, e.status, e.message);
      else mapError(res, e);
    }
    return true;
  }

  // /api/chat/sessions/:id[...]
  if (pathname.startsWith('/api/chat/sessions/')) {
    const rest = pathname.slice('/api/chat/sessions/'.length);
    const parts = rest.split('/').filter(Boolean);
    const id = decodeSeg(parts[0]);
    if (!id) {
      sendError(res, 400, 'invalid session id');
      return true;
    }
    const action = parts[1] || '';

    // GET session
    if (method === 'GET' && !action) {
      try {
        sendJson(res, 200, chatApi.getSession(id));
      } catch (e) {
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
      }
      return true;
    }

    // PATCH session meta
    if ((method === 'PATCH' || method === 'PUT') && !action) {
      try {
        const body = await readBody(req);
        sendJson(res, 200, chatApi.patchSession(id, body || {}));
      } catch (e) {
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
      }
      return true;
    }

    // DELETE session
    if (method === 'DELETE' && !action) {
      try {
        // abort any in-flight generation
        const ac = chatAbortMap.get(id);
        if (ac) {
          try {
            ac.abort();
          } catch {
            /* ignore */
          }
          chatAbortMap.delete(id);
        }
        sendJson(res, 200, chatApi.deleteSession(id));
      } catch (e) {
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
      }
      return true;
    }

    // POST truncate  { messageId, mode: 'from'|'after' }
    if (method === 'POST' && action === 'truncate') {
      try {
        const body = await readBody(req);
        const messageId = body && body.messageId;
        if (!messageId) {
          sendError(res, 400, 'messageId required');
          return true;
        }
        let session = chatApi.getSession(id);
        const mode = body.mode === 'after' ? 'after' : 'from';
        if (mode === 'after') session = chatApi.truncateAfter(session, messageId);
        else session = chatApi.truncateFrom(session, messageId);
        sendJson(res, 200, session);
      } catch (e) {
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
      }
      return true;
    }

    // PATCH message content  /sessions/:id/message/:mid
    if (method === 'PATCH' && action === 'message') {
      try {
        const mid = decodeSeg(parts[2] || '');
        if (!mid) {
          sendError(res, 400, 'message id required');
          return true;
        }
        const body = await readBody(req);
        let session = chatApi.getSession(id);
        const content = body && body.content != null ? String(body.content) : null;
        if (content == null) {
          sendError(res, 400, 'content required');
          return true;
        }
        session = chatApi.updateMessage(session, mid, { content, status: 'done', error: null });
        // drop everything after this message
        session = chatApi.truncateAfter(session, mid);
        sendJson(res, 200, session);
      } catch (e) {
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
      }
      return true;
    }

    // POST stop
    if (method === 'POST' && action === 'stop') {
      const ac = chatAbortMap.get(id);
      if (ac) {
        try {
          ac.abort();
        } catch {
          /* ignore */
        }
        chatAbortMap.delete(id);
        sendJson(res, 200, { ok: true, stopped: true });
      } else {
        sendJson(res, 200, { ok: true, stopped: false });
      }
      return true;
    }

    // POST messages → SSE stream
    if (method === 'POST' && action === 'messages') {
      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        sendError(res, e.status || 400, e.message || 'bad body');
        return true;
      }
      const content = body && body.content != null ? String(body.content).trim() : '';
      if (!content) {
        sendError(res, 400, 'content required');
        return true;
      }

      let session;
      try {
        session = chatApi.getSession(id);
      } catch (e) {
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
        return true;
      }

      // persist model selection for this session (and last-used global)
      let modelDirty = false;
      if (body.provider != null && String(body.provider).trim()) {
        const p = String(body.provider).trim();
        if (p !== session.provider) modelDirty = true;
        session.provider = p;
      }
      if (body.model != null && String(body.model).trim()) {
        const m = String(body.model).trim();
        if (m !== session.model) modelDirty = true;
        session.model = m;
      }
      if (!session.provider || !session.model) {
        const d = chatApi.resolveDefaultModel(session.provider, session.model);
        if (d.provider !== session.provider || d.model !== session.model) modelDirty = true;
        session.provider = d.provider;
        session.model = d.model;
      }
      if (modelDirty || (session.provider && session.model)) {
        // always save model onto session before generation so reload keeps it
        chatApi.saveSession(session);
      }

      // slash tools: no upstream model required
      const slash = chatTools.parseSlash(content);
      if (slash) {
        const userMsg = chatApi.makeMessage('user', content, { status: 'done' });
        const toolResult = await chatTools.runTool(slash.name, slash.args || {});
        const assistantMsg = chatApi.makeMessage('assistant', toolResult.text || '', {
          status: toolResult.ok ? 'done' : 'error',
          error: toolResult.ok ? null : toolResult.error,
          finishedAt: chatApi.nowIso(),
          tools: [
            {
              id: chatApi.newId(),
              name: toolResult.name,
              input: toolResult.args || {},
              output: toolResult.data != null ? toolResult.data : null,
              approval: 'auto',
              status: toolResult.ok ? 'done' : 'error',
              ms: toolResult.ms,
              error: toolResult.error || null,
            },
          ],
        });
        session.messages = session.messages || [];
        session.messages.push(userMsg, assistantMsg);
        if ((session.messages.filter((m) => m.role === 'user').length === 1) &&
            (!session.title || session.title === '新对话')) {
          session.title = slash.name === 'unknown' ? content.slice(0, 16) : slash.name;
        }
        chatApi.saveSession(session);

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        writeSse(res, 'meta', {
          sessionId: session.id,
          userMessageId: userMsg.id,
          messageId: assistantMsg.id,
          provider: session.provider,
          model: session.model,
          tool: true,
        });
        writeSse(res, 'tool', {
          name: toolResult.name,
          ok: toolResult.ok,
          ms: toolResult.ms,
          args: toolResult.args,
          data: toolResult.data,
          error: toolResult.error || null,
          text: toolResult.text,
        });
        if (toolResult.text) writeSse(res, 'delta', { text: toolResult.text });
        writeSse(res, 'done', {
          messageId: assistantMsg.id,
          content: toolResult.text || '',
          reasoning: '',
          usage: null,
          title: session.title,
          status: toolResult.ok ? 'done' : 'error',
          tool: true,
        });
        res.end();
        return true;
      }

      if (!session.provider || !session.model) {
        sendError(res, 400, '未配置模型，请先在「模型」页添加并设置默认');
        return true;
      }

      // abort previous for same session
      const prev = chatAbortMap.get(id);
      if (prev) {
        try {
          prev.abort();
        } catch {
          /* ignore */
        }
      }
      const ac = new AbortController();
      chatAbortMap.set(id, ac);

      const userMsg = chatApi.makeMessage('user', content, { status: 'done' });
      session.messages = session.messages || [];
      session.messages.push(userMsg);

      const assistantMsg = chatApi.makeMessage('assistant', '', {
        status: 'streaming',
        finishedAt: null,
      });
      session.messages.push(assistantMsg);
      chatApi.saveSession(session);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      if (typeof res.flushHeaders === 'function') res.flushHeaders();

      writeSse(res, 'meta', {
        sessionId: session.id,
        userMessageId: userMsg.id,
        messageId: assistantMsg.id,
        provider: session.provider,
        model: session.model,
      });

      const systemPrompt = session.systemPrompt || chatApi.DEFAULT_SYSTEM_PROMPT();
      // history without the empty streaming assistant placeholder
      const history = session.messages.filter((m) => m.id !== assistantMsg.id);

      let fullText = '';
      let fullReasoning = '';
      let usage = null;
      let aborted = false;

      const onAbort = () => {
        aborted = true;
      };
      ac.signal.addEventListener('abort', onAbort);
      req.on('close', () => {
        if (!ac.signal.aborted) {
          try {
            ac.abort();
          } catch {
            /* ignore */
          }
        }
      });

      const collectedTools = [];
      try {
        const openaiTools = chatTools.openAITools();
        const result = await chatClient.runChatWithTools({
          providerId: session.provider,
          model: session.model,
          messages: history,
          systemPrompt,
          signal: ac.signal,
          tools: openaiTools,
          maxSteps: 4,
          executeTool: async (name, args) => {
            if (!chatTools.isCallableTool(name)) {
              return {
                ok: false,
                name,
                args,
                error: '工具不可用或不允许: ' + name,
                text: '工具不可用或不允许: ' + name,
                data: null,
                ms: 0,
              };
            }
            return chatTools.runTool(name, args || {});
          },
          onEvent: (ev) => {
            if (aborted || res.writableEnded) return;
            if (ev.type === 'delta') {
              if (ev.text) {
                fullText += ev.text;
                writeSse(res, 'delta', { text: ev.text });
              }
              if (ev.reasoning) {
                fullReasoning += ev.reasoning;
                writeSse(res, 'delta', { reasoning: ev.reasoning });
              }
            } else if (ev.type === 'usage' && ev.usage) {
              usage = ev.usage;
              writeSse(res, 'usage', ev.usage);
            } else if (ev.type === 'tool_call') {
              writeSse(res, 'tool', {
                phase: 'call',
                id: ev.id,
                name: ev.name,
                args: ev.args,
                ok: true,
              });
            } else if (ev.type === 'tool_result') {
              collectedTools.push({
                id: ev.id,
                name: ev.name,
                input: ev.args,
                output: ev.data != null ? ev.data : null,
                approval: 'auto',
                status: ev.ok ? 'done' : 'error',
                ms: ev.ms,
                error: ev.error || null,
              });
              writeSse(res, 'tool', {
                phase: 'result',
                id: ev.id,
                name: ev.name,
                ok: ev.ok,
                ms: ev.ms,
                args: ev.args,
                data: ev.data,
                error: ev.error || null,
                text: ev.text,
              });
            }
          },
        });
        if (result) {
          // fullText/reasoning already accumulated via onEvent deltas; prefer final
          if (result.content != null && result.content !== '') fullText = result.content;
          if (result.reasoning) fullReasoning = result.reasoning;
          if (result.usage) usage = result.usage;
          if (result.tools && result.tools.length && !collectedTools.length) {
            for (const t of result.tools) collectedTools.push(t);
          }
        }

        // reload & persist (keep provider/model from this request)
        const keepProvider = session.provider;
        const keepModel = session.model;
        session = chatApi.getSession(id);
        if (keepProvider) session.provider = keepProvider;
        if (keepModel) session.model = keepModel;
        const a = (session.messages || []).find((m) => m.id === assistantMsg.id);
        if (a) {
          a.content = fullText;
          a.reasoning = fullReasoning;
          a.usage = usage;
          a.tools = collectedTools;
          a.status = aborted && !fullText ? 'partial' : 'done';
          a.finishedAt = chatApi.nowIso();
          if (aborted && fullText) a.status = 'partial';
        }
        // auto title on first exchange
        let newTitle = null;
        const userCount = (session.messages || []).filter((m) => m.role === 'user').length;
        if (userCount === 1 && (!session.title || session.title === '新对话')) {
          try {
            newTitle = await chatClient.generateTitle({
              providerId: session.provider,
              model: session.model,
              userText: content,
              assistantText: fullText,
              signal: undefined,
            });
            if (newTitle) session.title = newTitle;
          } catch {
            session.title = chatClient.fallbackTitle(content);
            newTitle = session.title;
          }
        }
        chatApi.saveSession(session);

        if (!res.writableEnded) {
          writeSse(res, 'done', {
            messageId: assistantMsg.id,
            content: fullText,
            reasoning: fullReasoning,
            usage,
            title: session.title,
            status: aborted ? 'partial' : 'done',
          });
          res.end();
        }
      } catch (e) {
        const isAbort = e && (e.name === 'AbortError' || /aborted|canceled/i.test(String(e.message || '')));
        try {
          const keepProvider = session.provider;
          const keepModel = session.model;
          session = chatApi.getSession(id);
          if (keepProvider) session.provider = keepProvider;
          if (keepModel) session.model = keepModel;
          const a = (session.messages || []).find((m) => m.id === assistantMsg.id);
          if (a) {
            a.content = fullText;
            a.reasoning = fullReasoning;
            a.usage = usage;
            a.status = isAbort ? 'partial' : 'error';
            a.error = isAbort ? (fullText ? null : 'stopped') : String(e.message || e).slice(0, 300);
            a.finishedAt = chatApi.nowIso();
          }
          chatApi.saveSession(session);
        } catch {
          /* ignore save error */
        }
        if (!res.writableEnded) {
          if (isAbort) {
            writeSse(res, 'done', {
              messageId: assistantMsg.id,
              content: fullText,
              reasoning: fullReasoning,
              usage,
              status: 'partial',
              stopped: true,
            });
          } else {
            writeSse(res, 'error', { message: String(e.message || e).slice(0, 300) });
          }
          res.end();
        }
      } finally {
        ac.signal.removeEventListener('abort', onAbort);
        if (chatAbortMap.get(id) === ac) chatAbortMap.delete(id);
      }
      return true;
    }

    sendError(res, 404, 'Not Found');
    return true;
  }

  sendError(res, 404, 'Not Found');
  return true;
}

module.exports = { handleChatApi };
