/* Pi Manager embedded chat drawer */
(function () {
  const state = {
    open: false,
    listOpen: false,
    models: [],
    defaults: { provider: '', model: '' },
    sessions: [],
    session: null,
    generating: false,
    abortController: null,
    stickBottom: true,
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function toast(msg, ok) {
    if (typeof showToast === 'function') showToast(msg, ok !== false);
    else console.log(msg);
  }

  async function api(path, opts) {
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    return data;
  }

  function modelKey(p, m) {
    return (p || '') + '/' + (m || '');
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Close unclosed fenced code blocks so streaming MD still renders. */
  function prepareMarkdownSource(text, streaming) {
    let raw = String(text || '');
    if (!streaming) return raw;
    // count fence lines starting with ```
    const fences = raw.match(/^```/gm);
    if (fences && fences.length % 2 === 1) {
      raw += '\n```';
    }
    // incomplete table: if last non-empty line looks like a table row without following separator, leave as-is (marked handles partial poorly but better than raw)
    return raw;
  }

  function renderMarkdown(text, streaming) {
    const raw = prepareMarkdownSource(text, streaming);
    if (!raw) return '';
    try {
      if (typeof marked !== 'undefined') {
        if (marked.setOptions) marked.setOptions({ breaks: true, gfm: true });
        const html = typeof marked.parse === 'function' ? marked.parse(raw) : marked(raw);
        return html;
      }
    } catch (e) {
      console.warn('marked failed', e);
    }
    return '<pre class="chat-pre">' + esc(raw) + '</pre>';
  }

  function ensureDom() {
    if ($('#chat-root')) return;
    const root = document.createElement('div');
    root.id = 'chat-root';
    root.innerHTML = `
      <div id="chat-backdrop" class="chat-backdrop hidden" aria-hidden="true"></div>
      <aside id="chat-drawer" class="chat-drawer" aria-hidden="true" aria-label="Pi Manager 助手">
        <header class="chat-head">
          <div class="chat-head-left">
            <label class="sr-only" for="chat-model-select">模型</label>
            <select id="chat-model-select" class="chat-model-select" title="选择模型"></select>
            <button type="button" id="chat-title-btn" class="chat-title-btn" title="当前会话">新对话</button>
          </div>
          <div class="chat-head-actions">
            <button type="button" id="chat-new-btn" class="btn ghost sm icon-btn" title="新建会话" aria-label="新建会话">
              <i data-lucide="plus"></i>
            </button>
            <button type="button" id="chat-list-btn" class="btn ghost sm icon-btn" title="会话列表" aria-label="会话列表">
              <i data-lucide="list"></i>
            </button>
            <button type="button" id="chat-close-btn" class="btn ghost sm icon-btn" title="关闭" aria-label="关闭">
              <i data-lucide="x"></i>
            </button>
          </div>
        </header>
        <div id="chat-session-sheet" class="chat-session-sheet hidden">
          <div class="chat-session-sheet-head">
            <strong>会话</strong>
            <button type="button" id="chat-sheet-close" class="btn ghost sm">关闭</button>
          </div>
          <input type="search" id="chat-session-filter" class="chat-session-filter" placeholder="过滤标题…" />
          <div id="chat-session-list" class="chat-session-list"></div>
        </div>
        <div id="chat-messages" class="chat-messages" role="log" aria-live="polite"></div>
        <button type="button" id="chat-jump-bottom" class="chat-jump-bottom hidden" title="回到底部">↓</button>
        <div id="chat-error" class="chat-error hidden"></div>
        <footer class="chat-input-wrap">
          <div id="chat-chips" class="chat-chips"></div>
          <div class="chat-composer" id="chat-composer">
            <textarea id="chat-input" rows="1" placeholder="问配置、用量、记忆… Enter 发送，Shift+Enter 换行"></textarea>
            <button type="button" id="chat-send-btn" class="chat-send-btn" title="发送" aria-label="发送" disabled>
              <i data-lucide="arrow-up"></i>
            </button>
          </div>
        </footer>
      </aside>
    `;
    document.body.appendChild(root);

    // header button
    const headerRight = $('.header-right');
    if (headerRight && !$('#chat-toggle-btn')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'chat-toggle-btn';
      btn.className = 'btn ghost sm icon-btn';
      btn.title = '助手 (Ctrl+/)';
      btn.setAttribute('aria-label', '打开助手');
      btn.innerHTML = '<i data-lucide="message-square"></i>';
      const help = $('#help-btn');
      if (help) headerRight.insertBefore(btn, help);
      else headerRight.insertBefore(btn, headerRight.firstChild);
    }
  }

  function refreshIcons() {
    if (typeof window.refreshIcons === 'function') window.refreshIcons();
    else if (typeof lucide !== 'undefined' && lucide.createIcons) {
      try {
        lucide.createIcons({ attrs: { 'stroke-width': '1.75', width: '16', height: '16' } });
      } catch {
        /* ignore */
      }
    }
  }

  function setOpen(open) {
    state.open = !!open;
    document.body.classList.toggle('chat-open', state.open);
    const drawer = $('#chat-drawer');
    const backdrop = $('#chat-backdrop');
    const toggle = $('#chat-toggle-btn');
    if (drawer) {
      drawer.classList.toggle('open', state.open);
      drawer.setAttribute('aria-hidden', state.open ? 'false' : 'true');
    }
    if (backdrop) {
      backdrop.classList.toggle('hidden', !state.open || window.innerWidth >= 900);
    }
    if (toggle) toggle.classList.toggle('active', state.open);
    if (state.open) {
      loadModels().then(() => {
        if (!state.session) return ensureSession();
        renderMessages();
      });
      setTimeout(() => $('#chat-input')?.focus(), 80);
    } else {
      setListOpen(false);
    }
    refreshIcons();
  }

  function setListOpen(open) {
    state.listOpen = !!open;
    const sheet = $('#chat-session-sheet');
    if (sheet) sheet.classList.toggle('hidden', !state.listOpen);
    if (state.listOpen) {
      loadSessions().then(renderSessionList);
      $('#chat-session-filter')?.focus();
    }
  }

  async function loadModels() {
    try {
      const data = await api('/api/chat/models');
      state.models = data.models || [];
      state.defaults = data.defaults || { provider: '', model: '' };
      state.lastUsed = data.lastUsed || { provider: '', model: '' };
      state.preferred = data.preferred || state.defaults;
      fillModelSelect();
    } catch (e) {
      toast('加载模型失败: ' + e.message, false);
    }
  }

  function preferredModelKey() {
    if (state.session && state.session.provider && state.session.model) {
      return modelKey(state.session.provider, state.session.model);
    }
    const pref = state.preferred || state.lastUsed || state.defaults || {};
    if (pref.provider && pref.model) return modelKey(pref.provider, pref.model);
    if (state.lastUsed && state.lastUsed.provider && state.lastUsed.model) {
      return modelKey(state.lastUsed.provider, state.lastUsed.model);
    }
    return modelKey(state.defaults.provider, state.defaults.model);
  }

  function fillModelSelect() {
    const sel = $('#chat-model-select');
    if (!sel) return;
    const cur = preferredModelKey();
    sel.innerHTML = '';
    if (!state.models.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = '（无可用模型）';
      sel.appendChild(o);
      return;
    }
    for (const m of state.models) {
      const o = document.createElement('option');
      o.value = m.id; // provider/modelId
      const modelId =
        m.modelId || m.name || (m.id.includes('/') ? m.id.slice(m.id.indexOf('/') + 1) : m.id);
      const providerId = m.providerId || (m.id.includes('/') ? m.id.slice(0, m.id.indexOf('/')) : '');
      // 列表与选中态都显示：模型 · 供应商（原生 select 无法内外两套文案）
      o.textContent = providerId ? modelId + ' · ' + providerId : modelId;
      o.title = m.id + (m.reasoning ? ' · think' : '');
      sel.appendChild(o);
    }
    if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
    else sel.selectedIndex = 0;
  }

  function readSelectedModel() {
    const sel = $('#chat-model-select');
    if (sel && sel.value && sel.value.includes('/')) {
      const i = sel.value.indexOf('/');
      return { provider: sel.value.slice(0, i), model: sel.value.slice(i + 1) };
    }
    if (state.session && state.session.provider && state.session.model) {
      return { provider: state.session.provider, model: state.session.model };
    }
    const pref = state.preferred || state.defaults || {};
    return { provider: pref.provider || '', model: pref.model || '' };
  }

  async function persistSessionModel(provider, model) {
    if (!state.session || !provider || !model) return state.session;
    if (state.session.provider === provider && state.session.model === model) {
      return state.session;
    }
    state.session = await api('/api/chat/sessions/' + encodeURIComponent(state.session.id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model }),
    });
    state.lastUsed = { provider, model };
    state.preferred = { provider, model };
    fillModelSelect();
    return state.session;
  }

  async function loadSessions() {
    try {
      const data = await api('/api/chat/sessions');
      state.sessions = data.sessions || [];
    } catch (e) {
      toast('加载会话失败: ' + e.message, false);
    }
  }

  async function ensureSession() {
    if (state.session) return state.session;
    await loadSessions();
    if (state.sessions[0]) {
      return selectSession(state.sessions[0].id);
    }
    return newSession();
  }

  async function newSession() {
    try {
      const picked = readSelectedModel();
      const session = await api('/api/chat/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: picked.provider, model: picked.model }),
      });
      state.session = session;
      if (session.provider && session.model) {
        state.lastUsed = { provider: session.provider, model: session.model };
        state.preferred = { provider: session.provider, model: session.model };
      }
      updateTitleBtn();
      fillModelSelect();
      renderMessages();
      await loadSessions();
      if (state.listOpen) renderSessionList();
      return session;
    } catch (e) {
      toast('新建会话失败: ' + e.message, false);
      throw e;
    }
  }

  async function selectSession(id) {
    try {
      const session = await api('/api/chat/sessions/' + encodeURIComponent(id));
      state.session = session;
      updateTitleBtn();
      fillModelSelect();
      renderMessages();
      setListOpen(false);
      return session;
    } catch (e) {
      toast('打开会话失败: ' + e.message, false);
      throw e;
    }
  }

  async function deleteSession(id) {
    if (!confirm('删除该会话？不可恢复。')) return;
    try {
      await api('/api/chat/sessions/' + encodeURIComponent(id), { method: 'DELETE' });
      if (state.session && state.session.id === id) {
        state.session = null;
        await ensureSession();
      }
      await loadSessions();
      renderSessionList();
    } catch (e) {
      toast('删除失败: ' + e.message, false);
    }
  }

  function updateTitleBtn() {
    const btn = $('#chat-title-btn');
    if (!btn) return;
    btn.textContent = (state.session && state.session.title) || '新对话';
  }

  function dateLabel(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '更早';
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yday = new Date(today);
    yday.setDate(yday.getDate() - 1);
    const day = new Date(d);
    day.setHours(0, 0, 0, 0);
    if (day.getTime() === today.getTime()) return '今天';
    if (day.getTime() === yday.getTime()) return '昨天';
    return d.toLocaleDateString();
  }

  function renderSessionList() {
    const box = $('#chat-session-list');
    if (!box) return;
    const q = String($('#chat-session-filter')?.value || '')
      .trim()
      .toLowerCase();
    let list = state.sessions || [];
    if (q) list = list.filter((s) => String(s.title || '').toLowerCase().includes(q));

    if (!list.length) {
      box.innerHTML = '<div class="chat-empty-inline">暂无会话</div>';
      return;
    }

    const groups = [];
    let last = null;
    for (const s of list) {
      const label = dateLabel(s.updatedAt || s.createdAt);
      if (label !== last) {
        groups.push({ type: 'h', label });
        last = label;
      }
      groups.push({ type: 's', s });
    }

    box.innerHTML = groups
      .map((g) => {
        if (g.type === 'h') return `<div class="chat-session-date">${esc(g.label)}</div>`;
        const active = state.session && state.session.id === g.s.id ? ' active' : '';
        return `<div class="chat-session-item${active}" data-id="${esc(g.s.id)}">
          <button type="button" class="chat-session-open" title="${esc(g.s.title || '新对话')}">${esc(g.s.title || '新对话')}</button>
          <button type="button" class="chat-session-del btn ghost sm" title="删除" aria-label="删除会话" data-del="${esc(g.s.id)}">×</button>
        </div>`;
      })
      .join('');

    box.querySelectorAll('.chat-session-item').forEach((row) => {
      const id = row.getAttribute('data-id');
      row.querySelector('.chat-session-open')?.addEventListener('click', () => selectSession(id));
      row.querySelector('[data-del]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteSession(id);
      });
    });
  }

  function renderChips() {
    const box = $('#chat-chips');
    if (!box) return;
    if (state.session && state.session.messages && state.session.messages.length) {
      box.innerHTML = '';
      return;
    }
    const chips = [
      { t: '/usage today', label: '今日用量', send: true },
      { t: '/defaults', label: '默认模型', send: true },
      { t: '/health', label: '健康检查', send: true },
      { t: '/help', label: '命令帮助', send: true },
      { t: '怎么理解 models.json 里的费用数字？', label: '费用说明', send: false },
    ];
    box.innerHTML = chips
      .map(
        (c) =>
          `<button type="button" class="chat-chip" data-fill="${esc(c.t)}" data-send="${c.send ? '1' : '0'}">${esc(c.label)}</button>`
      )
      .join('');
    box.querySelectorAll('.chat-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = $('#chat-input');
        if (!input) return;
        input.value = btn.getAttribute('data-fill') || '';
        autosize();
        updateSendEnabled();
        if (btn.getAttribute('data-send') === '1' && !state.generating) {
          sendOrStop();
        } else {
          input.focus();
        }
      });
    });
  }

  function renderMessages() {
    const box = $('#chat-messages');
    if (!box) return;
    const msgs = (state.session && state.session.messages) || [];
    if (!msgs.length) {
      box.innerHTML = `<div class="chat-empty">
        <div class="chat-empty-title">Pi Manager 助手</div>
        <p class="chat-empty-lead">正常聊天会自动调工具；也可用 <code>/usage</code> <code>/health</code> <code>/set-default 供应商/模型</code> <code>/help</code></p>
        <p class="chat-empty-sub">写操作需点确认；复杂编码请用终端 Pi。</p>
      </div>`;
      renderChips();
      return;
    }
    renderChips();
    box.innerHTML = msgs
      .map((m) => {
        const role = m.role === 'user' ? 'user' : 'assistant';
        const loading = m.status === 'streaming' ? ' data-loading="1"' : '';
        let body = '';
        if (Array.isArray(m.tools) && m.tools.length) {
          body += m.tools
            .map((t) => {
              const ok = t.status !== 'error';
              const name = esc(t.name || 'tool');
              const ms = t.ms != null ? ` · ${t.ms}ms` : '';
              const status =
                t.status === 'running' ? '调用中…' : ok ? '完成' : '失败';
              let detail = '';
              if (t.output != null) {
                try {
                  detail = esc(JSON.stringify(t.output, null, 2));
                } catch {
                  detail = esc(String(t.output));
                }
              } else if (t.error) {
                detail = esc(t.error);
              }
              const needsConfirm =
                t.output &&
                t.output.needsConfirm &&
                t.output.confirmId &&
                t.status !== 'confirmed' &&
                t.status !== 'cancelled';
              const preview =
                needsConfirm && t.output.diffOld != null
                  ? `<div class="chat-tool-preview"><div class="chat-tool-preview-label">变更预览</div>${
                      typeof renderDiffHtml === 'function'
                        ? renderDiffHtml(t.output.diffOld || '', t.output.diffNew || '').html
                        : `<pre class="chat-tool-json">${esc(
                            (t.output.diffOld || '') + '\n---\n' + (t.output.diffNew || '')
                          )}</pre>`
                    }</div>`
                  : '';
              const confirmBtns = needsConfirm
                ? `<div class="chat-tool-confirm">
                    <button type="button" class="btn primary sm chat-confirm-yes" data-confirm="${esc(t.output.confirmId)}" data-msg="${esc(m.id)}">确认执行</button>
                    <button type="button" class="btn ghost sm chat-confirm-no" data-confirm="${esc(t.output.confirmId)}" data-msg="${esc(m.id)}">取消</button>
                  </div>`
                : '';
              return `<details class="chat-tool ${ok ? 'ok' : 'err'}${needsConfirm ? ' pending' : ''}" ${needsConfirm ? 'open' : ''}>
                <summary><span class="chat-tool-ico" aria-hidden="true">⚙</span><span class="chat-tool-name">${name}</span><span class="chat-tool-meta">${status}${ms}</span></summary>
                ${t.output && t.output.summary ? `<div class="chat-tool-summary">${esc(t.output.summary)}</div>` : ''}
                ${preview}
                ${!preview && detail ? `<pre class="chat-tool-json">${detail}</pre>` : ''}
                ${confirmBtns}
              </details>`;
            })
            .join('');
        }
        if (m.reasoning) {
          const open = m.status === 'streaming' ? ' open' : '';
          body += `<details class="chat-reasoning"${open ? ' open' : ''}>
            <summary>思考${m.status === 'streaming' ? '中…' : ''}</summary>
            <div class="chat-reasoning-body">${renderMarkdown(m.reasoning)}</div>
          </details>`;
        }
        if (m.content) {
          if (role === 'user') {
            body += `<div class="chat-text">${esc(m.content).replace(/\n/g, '<br>')}</div>`;
          } else {
            const streaming = m.status === 'streaming';
            body += `<div class="chat-text chat-md${streaming ? ' chat-md-stream' : ''}">${renderMarkdown(m.content, streaming)}${streaming ? '<span class="chat-caret"></span>' : ''}</div>`;
          }
        } else if (m.status === 'streaming') {
          body += `<div class="chat-typing" aria-label="生成中"><span></span><span></span><span></span></div>`;
        }
        if (m.status === 'error' && m.error) {
          body += `<div class="chat-msg-error">${esc(m.error)}</div>`;
        }
        let nerd = '';
        if (m.usage && (m.usage.promptTokens || m.usage.completionTokens)) {
          nerd = `<div class="chat-nerd">↑${m.usage.promptTokens || 0} ↓${m.usage.completionTokens || 0}</div>`;
        }
        let actions = '';
        if (m.status !== 'streaming' && m.content) {
          if (role === 'assistant') {
            const isLast =
              msgs.filter((x) => x.role === 'assistant').slice(-1)[0]?.id === m.id;
            actions = `<div class="chat-actions">
              <button type="button" class="btn ghost sm chat-copy" data-copy="${esc(m.id)}">复制</button>
              ${isLast && !state.generating ? `<button type="button" class="btn ghost sm chat-regen" data-regen="${esc(m.id)}">重新生成</button>` : ''}
            </div>`;
          } else if (role === 'user') {
            actions = `<div class="chat-actions">
              <button type="button" class="btn ghost sm chat-copy" data-copy="${esc(m.id)}">复制</button>
              ${!state.generating ? `<button type="button" class="btn ghost sm chat-edit" data-edit="${esc(m.id)}">编辑</button>` : ''}
            </div>`;
          }
        }
        return `<div class="chat-msg chat-msg-${role}" data-id="${esc(m.id)}"${loading}>
          <div class="chat-bubble">${body}</div>
          ${actions}${nerd}
        </div>`;
      })
      .join('');

    // enhance code blocks
    box.querySelectorAll('.chat-md pre').forEach((pre) => {
      if (pre.parentElement?.classList.contains('chat-code-wrap')) return;
      const wrap = document.createElement('div');
      wrap.className = 'chat-code-wrap';
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-code-copy';
      btn.textContent = '复制';
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(pre.innerText);
          btn.textContent = '已复制';
          setTimeout(() => (btn.textContent = '复制'), 1200);
        } catch {
          /* ignore */
        }
      });
      wrap.appendChild(btn);
    });

    box.querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-copy');
        const m = msgs.find((x) => x.id === id);
        if (!m) return;
        try {
          await navigator.clipboard.writeText(m.content || '');
          toast('已复制');
        } catch {
          toast('复制失败', false);
        }
      });
    });

    box.querySelectorAll('[data-regen]').forEach((btn) => {
      btn.addEventListener('click', () => regenerateFromAssistant(btn.getAttribute('data-regen')));
    });
    box.querySelectorAll('[data-edit]').forEach((btn) => {
      btn.addEventListener('click', () => editUserMessage(btn.getAttribute('data-edit')));
    });
    box.querySelectorAll('.chat-confirm-yes').forEach((btn) => {
      btn.addEventListener('click', () =>
        confirmTool(btn.getAttribute('data-confirm'), btn.getAttribute('data-msg'), true)
      );
    });
    box.querySelectorAll('.chat-confirm-no').forEach((btn) => {
      btn.addEventListener('click', () =>
        confirmTool(btn.getAttribute('data-confirm'), btn.getAttribute('data-msg'), false)
      );
    });

    if (state.stickBottom) scrollBottom();
  }

  async function regenerateFromAssistant(assistantId) {
    if (!state.session || state.generating) return;
    const msgs = state.session.messages || [];
    const idx = msgs.findIndex((m) => m.id === assistantId);
    if (idx < 0) return;
    // find previous user message
    let userMsg = null;
    for (let i = idx - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        userMsg = msgs[i];
        break;
      }
    }
    if (!userMsg) {
      toast('找不到对应的用户消息', false);
      return;
    }
    try {
      // drop from the user turn so resend does not duplicate the user message
      state.session = await api(
        '/api/chat/sessions/' + encodeURIComponent(state.session.id) + '/truncate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageId: userMsg.id, mode: 'from' }),
        }
      );
      renderMessages();
      await resendContent(userMsg.content);
    } catch (e) {
      toast('重新生成失败: ' + e.message, false);
    }
  }

  async function editUserMessage(userId) {
    if (!state.session || state.generating) return;
    const msgs = state.session.messages || [];
    const m = msgs.find((x) => x.id === userId);
    if (!m || m.role !== 'user') return;
    const next = window.prompt('编辑消息后将截断后续并重新发送：', m.content || '');
    if (next == null) return;
    const content = String(next).trim();
    if (!content) {
      toast('内容不能为空', false);
      return;
    }
    try {
      state.session = await api(
        '/api/chat/sessions/' +
          encodeURIComponent(state.session.id) +
          '/message/' +
          encodeURIComponent(userId),
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        }
      );
      // remove the edited user message too so resend creates a fresh pair
      state.session = await api(
        '/api/chat/sessions/' + encodeURIComponent(state.session.id) + '/truncate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageId: userId, mode: 'from' }),
        }
      );
      renderMessages();
      await resendContent(content);
    } catch (e) {
      toast('编辑失败: ' + e.message, false);
    }
  }

  function findPendingTool(msgId, confirmId) {
    const m = (state.session && state.session.messages || []).find((x) => x.id === msgId);
    if (!m || !Array.isArray(m.tools)) return null;
    return m.tools.find((t) => t.output && t.output.confirmId === confirmId) || null;
  }

  async function confirmTool(confirmId, msgId, yes) {
    if (!confirmId) return;
    try {
      if (!yes) {
        await api('/api/chat/tools/reject', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmId }),
        });
        toast('已取消');
        markToolConfirmed(msgId, confirmId, false, '已取消');
        return;
      }

      // Diff / 清单预览（复用 diff-util）
      const tool = findPendingTool(msgId, confirmId);
      const out = tool && tool.output;
      if (out && (out.diffOld != null || out.diffNew != null)) {
        if (typeof confirmDiffSave === 'function') {
          const title =
            out.action === 'set_default_model'
              ? '确认修改默认模型'
              : out.action === 'cleanup_junk'
                ? '确认清理垃圾文件'
                : out.action === 'restore_trash'
                  ? '确认还原回收站'
                  : out.summary || '确认写操作';
          const ok = await confirmDiffSave(title, out.diffOld || '', out.diffNew || '');
          if (!ok) {
            toast('已取消');
            return;
          }
        } else {
          const ok = window.confirm((out.summary || '确认执行写操作？') + '\n\n' + (out.diffNew || ''));
          if (!ok) return;
        }
      } else if (out && out.summary) {
        if (!window.confirm(out.summary + '\n\n确认执行？')) return;
      }

      const result = await api('/api/chat/tools/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmId }),
      });
      toast(result.text || '已执行');
      markToolConfirmed(msgId, confirmId, true, result.text || '已执行', result.data);
    } catch (e) {
      toast('确认失败: ' + e.message, false);
    }
  }

  function markToolConfirmed(msgId, confirmId, ok, text, data) {
    if (!state.session) return;
    const m = (state.session.messages || []).find((x) => x.id === msgId);
    if (m && Array.isArray(m.tools)) {
      for (const t of m.tools) {
        if (t.output && t.output.confirmId === confirmId) {
          t.status = ok ? 'confirmed' : 'cancelled';
          t.output = {
            ...(t.output || {}),
            needsConfirm: false,
            confirmed: ok,
            result: data || null,
            resultText: text,
          };
          if (text) m.content = (m.content ? m.content + '\n\n' : '') + text;
        }
      }
    }
    renderMessages();
  }

  /** Resend a user content without going through the input box (for regen/edit). */
  async function resendContent(content) {
    const ta = $('#chat-input');
    if (ta) ta.value = content;
    autosize();
    updateSendEnabled();
    await sendOrStop();
  }

  function scrollBottom() {
    const box = $('#chat-messages');
    if (!box) return;
    box.scrollTop = box.scrollHeight;
  }

  function onMessagesScroll() {
    const box = $('#chat-messages');
    if (!box) return;
    const dist = box.scrollHeight - box.scrollTop - box.clientHeight;
    state.stickBottom = dist < 80;
    const jump = $('#chat-jump-bottom');
    if (jump) jump.classList.toggle('hidden', state.stickBottom);
  }

  function autosize() {
    const ta = $('#chat-input');
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }

  function updateSendEnabled() {
    const btn = $('#chat-send-btn');
    const ta = $('#chat-input');
    if (!btn || !ta) return;
    if (state.generating) {
      btn.disabled = false;
      btn.title = '停止';
      btn.setAttribute('aria-label', '停止');
      btn.innerHTML = '<i data-lucide="square"></i>';
      btn.classList.add('stop');
      btn.classList.add('is-ready');
    } else {
      const empty = !ta.value.trim();
      btn.disabled = empty;
      btn.title = '发送';
      btn.setAttribute('aria-label', '发送');
      btn.innerHTML = '<i data-lucide="arrow-up"></i>';
      btn.classList.remove('stop');
      btn.classList.toggle('is-ready', !empty);
    }
    refreshIcons();
  }

  function showError(msg) {
    const el = $('#chat-error');
    if (!el) return;
    if (!msg) {
      el.classList.add('hidden');
      el.textContent = '';
      return;
    }
    el.classList.remove('hidden');
    el.textContent = msg;
  }

  async function sendOrStop() {
    if (state.generating) {
      await stopGeneration();
      return;
    }
    const ta = $('#chat-input');
    const content = String(ta?.value || '').trim();
    if (!content) return;
    showError('');
    await ensureSession();
    if (!state.session) return;

    // apply + persist model from select before sending
    const picked = readSelectedModel();
    try {
      await persistSessionModel(picked.provider, picked.model);
    } catch (e) {
      // still set local so request body carries it
      state.session.provider = picked.provider;
      state.session.model = picked.model;
    }

    ta.value = '';
    autosize();
    updateSendEnabled();

    // optimistic UI
    const userMsg = {
      id: 'local-user-' + Date.now(),
      role: 'user',
      content,
      status: 'done',
      reasoning: '',
    };
    const asstMsg = {
      id: 'local-asst-' + Date.now(),
      role: 'assistant',
      content: '',
      reasoning: '',
      status: 'streaming',
    };
    state.session.messages = state.session.messages || [];
    state.session.messages.push(userMsg, asstMsg);
    state.stickBottom = true;
    renderMessages();

    state.generating = true;
    updateSendEnabled();
    state.abortController = new AbortController();

    try {
      const res = await fetch(
        '/api/chat/sessions/' + encodeURIComponent(state.session.id) + '/messages',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content,
            provider: state.session.provider,
            model: state.session.model,
          }),
          signal: state.abortController.signal,
        }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'HTTP ' + res.status);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let realAsstId = asstMsg.id;
      let eventName = 'message';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split(/\n\n/);
        buffer = chunks.pop() || '';
        for (const chunk of chunks) {
          const lines = chunk.split(/\r?\n/);
          let dataLine = '';
          eventName = 'message';
          for (const line of lines) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
          }
          if (!dataLine) continue;
          let data;
          try {
            data = JSON.parse(dataLine);
          } catch {
            continue;
          }
          handleSseEvent(eventName, data, userMsg, asstMsg, (id) => {
            realAsstId = id;
          });
        }
      }
      // finalize local assistant
      const a = state.session.messages.find((m) => m.id === asstMsg.id || m.id === realAsstId);
      if (a && a.status === 'streaming') {
        a.status = 'done';
        renderMessages();
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        const a = state.session.messages.find((m) => m.status === 'streaming');
        if (a) {
          a.status = a.content ? 'partial' : 'error';
          a.error = a.content ? null : '已停止';
        }
        renderMessages();
      } else {
        showError(e.message || String(e));
        const a = state.session.messages.find((m) => m.status === 'streaming');
        if (a) {
          a.status = 'error';
          a.error = e.message || String(e);
        }
        // remove empty optimistic assistant if nothing came
        toast(e.message || '发送失败', false);
        renderMessages();
      }
    } finally {
      state.generating = false;
      state.abortController = null;
      updateSendEnabled();
      // refresh session from server for ids/title
      try {
        if (state.session?.id) {
          const fresh = await api('/api/chat/sessions/' + encodeURIComponent(state.session.id));
          state.session = fresh;
          updateTitleBtn();
          renderMessages();
          await loadSessions();
        }
      } catch {
        /* ignore */
      }
    }
  }

  function handleSseEvent(eventName, data, userMsg, asstMsg, setRealId) {
    if (eventName === 'meta') {
      if (data.userMessageId) userMsg.id = data.userMessageId;
      if (data.messageId) {
        asstMsg.id = data.messageId;
        setRealId(data.messageId);
      }
      if (data.provider) state.session.provider = data.provider;
      if (data.model) state.session.model = data.model;
      return;
    }
    if (eventName === 'tool') {
      if (!Array.isArray(asstMsg.tools)) asstMsg.tools = [];
      const phase = data.phase || 'result';
      if (phase === 'call') {
        asstMsg.tools.push({
          id: data.id,
          name: data.name,
          input: data.args,
          output: null,
          status: 'running',
          ms: null,
          error: null,
        });
      } else {
        // update existing running tool or push
        let t = asstMsg.tools.find(
          (x) => (data.id && x.id === data.id) || (x.name === data.name && x.status === 'running')
        );
        if (!t) {
          t = { name: data.name, id: data.id };
          asstMsg.tools.push(t);
        }
        t.name = data.name || t.name;
        t.input = data.args != null ? data.args : t.input;
        t.output = data.data != null ? data.data : null;
        t.status = data.ok === false ? 'error' : 'done';
        t.ms = data.ms;
        t.error = data.error || null;
        // slash-only path may send full text via tool event
        if (data.text && !asstMsg.content) asstMsg.content = data.text;
      }
      renderMessages();
      return;
    }
    if (eventName === 'delta') {
      if (data.text) asstMsg.content = (asstMsg.content || '') + data.text;
      if (data.reasoning) asstMsg.reasoning = (asstMsg.reasoning || '') + data.reasoning;
      // throttle re-render lightly
      renderMessages();
      return;
    }
    if (eventName === 'usage') {
      asstMsg.usage = data;
      return;
    }
    if (eventName === 'done') {
      if (data.content != null) asstMsg.content = data.content;
      if (data.reasoning != null) asstMsg.reasoning = data.reasoning;
      if (data.usage) asstMsg.usage = data.usage;
      asstMsg.status = data.status || 'done';
      if (data.title) {
        state.session.title = data.title;
        updateTitleBtn();
      }
      renderMessages();
      return;
    }
    if (eventName === 'error') {
      asstMsg.status = 'error';
      asstMsg.error = data.message || '错误';
      showError(asstMsg.error);
      renderMessages();
    }
  }

  async function stopGeneration() {
    if (!state.session) return;
    try {
      await api('/api/chat/sessions/' + encodeURIComponent(state.session.id) + '/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    } catch {
      /* ignore */
    }
    try {
      state.abortController?.abort();
    } catch {
      /* ignore */
    }
  }

  function bind() {
    ensureDom();
    $('#chat-toggle-btn')?.addEventListener('click', () => setOpen(!state.open));
    $('#chat-close-btn')?.addEventListener('click', () => setOpen(false));
    $('#chat-backdrop')?.addEventListener('click', () => setOpen(false));
    $('#chat-new-btn')?.addEventListener('click', () => newSession());
    $('#chat-list-btn')?.addEventListener('click', () => setListOpen(!state.listOpen));
    $('#chat-sheet-close')?.addEventListener('click', () => setListOpen(false));
    $('#chat-session-filter')?.addEventListener('input', () => renderSessionList());
    $('#chat-send-btn')?.addEventListener('click', () => sendOrStop());
    $('#chat-jump-bottom')?.addEventListener('click', () => {
      state.stickBottom = true;
      scrollBottom();
      onMessagesScroll();
    });
    $('#chat-messages')?.addEventListener('scroll', onMessagesScroll, { passive: true });

    const ta = $('#chat-input');
    ta?.addEventListener('input', () => {
      autosize();
      updateSendEnabled();
    });
    ta?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!state.generating) sendOrStop();
      }
    });

    $('#chat-model-select')?.addEventListener('change', async (e) => {
      const v = e.target.value;
      if (!v || !v.includes('/')) return;
      const i = v.indexOf('/');
      const provider = v.slice(0, i);
      const model = v.slice(i + 1);
      state.lastUsed = { provider, model };
      state.preferred = { provider, model };
      if (!state.session) return;
      try {
        await persistSessionModel(provider, model);
      } catch (err) {
        toast('切换模型失败: ' + err.message, false);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (state.listOpen) {
          setListOpen(false);
          e.preventDefault();
          return;
        }
        if (state.open) {
          setOpen(false);
          e.preventDefault();
        }
        return;
      }
      // Ctrl+/ or Ctrl+Shift+/
      if (e.ctrlKey && (e.key === '/' || e.code === 'Slash')) {
        e.preventDefault();
        setOpen(!state.open);
      }
    });

    window.addEventListener(
      'resize',
      () => {
        const backdrop = $('#chat-backdrop');
        if (backdrop && state.open) {
          backdrop.classList.toggle('hidden', window.innerWidth >= 900);
        }
      },
      { passive: true }
    );

    refreshIcons();
    updateSendEnabled();
  }

  function bootChat() {
    bind();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootChat);
  } else {
    bootChat();
  }

  window.bootChat = bootChat;
  window.openManagerChat = () => setOpen(true);
})();
