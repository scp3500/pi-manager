/* Claude Agent View–inspired session list */
(function () {
  const $ = (s, r) => (r || document).querySelector(s);
  let timer = null;
  let loading = false;
  let expandedId = null;
  let lastData = null;
  let lastFetchedAt = 0;
  /** Soft client TTL: skip network if last fetch was recent (aligned with 4s poll). */
  const RT_SOFT_TTL_MS = 6_000;

  const esc = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  function clip(s, n) {
    s = String(s || '')
      .replace(/\s+/g, ' ')
      .trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function toast(msg, ok) {
    if (typeof showToast === 'function') showToast(msg, ok !== false);
  }

  async function loadRuntime(force) {
    // soft enter: paint last snapshot immediately
    if (!force && lastData) {
      render(lastData);
      if (Date.now() - lastFetchedAt < RT_SOFT_TTL_MS) return;
    }
    if (loading) return;
    loading = true;
    $('#rt-refresh')?.classList.add('loading');
    try {
      // poll / refresh button may force; soft enter uses server short cache
      const res = await fetch(
        '/api/runtime?' + (force ? 'force=1&' : '') + 'limit=16'
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
      lastData = data;
      lastFetchedAt = Date.now();
      if (typeof state === 'undefined' || state.route === 'runtime') render(data);
    } catch (e) {
      const root = $('#runtime-root');
      if (!lastData && root) {
        root.innerHTML =
          '<div class="empty av2-empty"><p>加载失败：' +
          esc(e.message) +
          '</p></div>';
      }
      if (!lastData) toast(e.message, false);
    } finally {
      loading = false;
      $('#rt-refresh')?.classList.remove('loading');
    }
  }

  /**
   * UI state from backend phase:
   * tools | subagent | thinking | answering | stopped | idle
   */
  function stateOf(s) {
    if (!s) return { k: 'idle', label: '空闲', phase: 'idle' };
    const phase = s.phase || '';
    if (phase === 'exited') return { k: 'done', label: '已退出', phase: 'exited' };
    if (phase === 'tools') return { k: 'tools', label: '在干活', phase };
    if (phase === 'subagent') return { k: 'subagent', label: '子代理在跑', phase };
    if (phase === 'thinking') return { k: 'thinking', label: '在想', phase };
    if (phase === 'answering') return { k: 'answering', label: '在说', phase };
    if (s.status === 'running') return { k: 'working', label: '还在忙', phase: phase || 'working' };
    if (phase === 'stopped' || s.status === 'active') {
      return { k: 'stopped', label: '停了', phase: 'stopped' };
    }
    if (s.status === 'recent') return { k: 'done', label: '结束了', phase: phase || 'stopped' };
    return { k: 'idle', label: '空闲', phase: 'idle' };
  }

  function toolZh(name) {
    return (
      {
        bash: '命令',
        read: '读文件',
        edit: '改文件',
        write: '写文件',
        todo: 'Todo',
        subagent: '子代理',
      }[name] ||
      name ||
      '工具'
    );
  }

  function shortSum(name, summary) {
    let s = String(summary || '').trim();
    if (!s) return '';
    // legacy / raw todo dumps
    if (name === 'todo' || /"action"\s*:/.test(s)) {
      try {
        const j = JSON.parse(s);
        if (j && typeof j === 'object') {
          if (j.action === 'toggle') return '勾完 #' + (j.id != null ? j.id : '?');
          if (j.action === 'add') return '添加 · ' + clip(j.text || '', 36);
          if (j.action === 'list' || j.action === 'get') return '查看列表';
          if (j.action === 'clear') return '清空';
        }
      } catch (_) {
        /* not json */
      }
      if (/toggle/i.test(s)) {
        const m = s.match(/"?id"?\s*[:=]\s*(\d+)/i);
        if (m) return '勾完 #' + m[1];
      }
    }
    if (/^for pid in /i.test(s) || /netstat/i.test(s)) return '维护服务';
    if (name === 'bash') {
      const m = s.match(/([^/\\]+\.[a-z0-9]+)(?:\s|$|"|')/i);
      if (m) return m[1];
      return clip(s, 42);
    }
    if (name === 'read' || name === 'edit' || name === 'write') {
      return clip((s.split(/[/\\]/).pop() || s), 36);
    }
    if (name === 'subagent') return clip(s, 42);
    return clip(s, 42);
  }

  /** One-line: phase + tools */
  function rowSummary(s) {
    const open = s.openTools || [];
    const phase = s.phaseLabel || stateOf(s).label;
    if (open.length) {
      const names = open.map((t) => toolZh(t.name));
      const uniq = [...new Set(names)];
      const mode =
        s.concurrency === 'parallel' ? '并行 · ' : s.concurrency === 'serial' ? '串行 · ' : '';
      const t0 = open[0];
      const d = shortSum(t0.name, t0.summary);
      const more = open.length > 1 ? ' 等' + open.length + '个' : '';
      return (
        phase +
        ' · ' +
        mode +
        uniq.join('/') +
        (d ? ' · ' + d : '') +
        more
      );
    }
    if (s.phase === 'thinking' || s.phase === 'answering') {
      return phase + (s.lastAssistantText ? ' · ' + clip(s.lastAssistantText, 40) : '');
    }
    if (s.phase === 'exited') {
      return '已退出 · 本机没有 Pi 进程';
    }
    if (s.phase === 'stopped') {
      const last = (s.recentDone || [])[(s.recentDone || []).length - 1];
      if (last) {
        return (
          '停了 · 刚才用了 ' +
          toolZh(last.name) +
          (last.summary ? ' · ' + shortSum(last.name, last.summary) : '')
        );
      }
      return '停了 · 没有在跑的工具';
    }
    const todos = (s.todo && s.todo.items) || [];
    if (todos.length) return phase + ' · 下一步 ' + clip(todos[0].text, 40);
    return phase;
  }

  function sessionName(s) {
    const task = (s.currentTask || '').trim();
    // 批准执行 / 继续 / 整页粘贴 不当标题
    if (
      task &&
      !/^(批准执行|继续|继续吧|好|好的|行|可以|ok)$/i.test(task) &&
      !(task.includes('在干活') && task.includes('停了'))
    ) {
      return clip(task, 48);
    }
    const cwd = s.cwd || s.cwdKey || '';
    const base = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
    return base || (s.id || '').slice(0, 8) || 'session';
  }

  function progress(s) {
    const p = s.progress || {};
    const open = s.openCount || 0;
    if (p.kind === 'todo' && p.total) {
      return {
        pct: p.pct || 0,
        text: (p.done || 0) + '/' + p.total,
        hint: '还剩 ' + Math.max(0, p.total - p.done),
      };
    }
    if (open > 0) {
      return { pct: Math.min(99, p.pct || 50), text: open + ' 进行中', hint: '' };
    }
    if (p.kind === 'todo' && p.total && p.done >= p.total) {
      return { pct: 100, text: '完成', hint: '' };
    }
    return null;
  }

  function groupSessions(sessions) {
    const g = {
      tools: [],
      thinking: [],
      stopped: [],
      done: [],
      idle: [],
    };
    for (const s of sessions || []) {
      const st = stateOf(s);
      if (st.k === 'tools' || st.k === 'subagent' || st.k === 'working') g.tools.push(s);
      else if (st.k === 'thinking' || st.k === 'answering') g.thinking.push(s);
      else if (st.k === 'stopped') g.stopped.push(s);
      else if (st.k === 'done') g.done.push(s);
      else g.idle.push(s);
    }
    return g;
  }

  function render(data) {
    const root = $('#runtime-root');
    if (!root) return;

    // Prefer non-idle; if empty show recent few
    let all = data.sessions || [];
    let shown = all.filter(
      (s) =>
        s.status === 'running' ||
        s.status === 'active' ||
        (s.openCount || 0) > 0 ||
        s.phase === 'exited'
    );
    if (!shown.length) shown = all.slice(0, 5);

    const groups = groupSessions(shown);
    const counts = {
      tools: groups.tools.length,
      thinking: groups.thinking.length,
      stopped: groups.stopped.length,
      done: groups.done.length,
    };
    const piCount =
      (data.piProcesses && data.piProcesses.count) ??
      (data.totals && data.totals.piProcesses) ??
      null;

    let html = '';
    html +=
      '<div class="av2-top">' +
      '<div class="av2-brand">运行</div>' +
      '<div class="av2-counts">' +
      chip('在干活', counts.tools, 'working') +
      chip('在想/在说', counts.thinking, 'waiting') +
      chip('停了', counts.stopped + counts.done, 'done') +
      (piCount != null
        ? chip('Pi进程', piCount, piCount > 0 ? 'working' : 'done')
        : '') +
      '</div>' +
      '<div class="av2-clock">' +
      esc((data.scannedAt || '').replace('T', ' ').slice(11, 19)) +
      '</div></div>';

    if (!shown.length) {
      html +=
        '<div class="empty av2-empty">' +
        '<p class="av2-empty-title">当前没有活动会话</p>' +
        '<p class="av2-empty-sub">有任务在跑、在想、或刚停下来时会出现在这里</p>' +
        '</div>';
      root.innerHTML = html;
      return;
    }

    html += section('正在调工具', groups.tools, true);
    html += section('正在想 / 正在说', groups.thinking, true);
    html += section('停了，等你', groups.stopped, false);
    html += section('已退出 / 最近结束', groups.done, false);
    if (!counts.tools && !counts.thinking && !counts.stopped && !counts.done) {
      html += section('空闲', groups.idle.slice(0, 3), false);
    }

    root.innerHTML = html;
    root.querySelectorAll('[data-av-id]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-av-id');
        expandedId = expandedId === id ? null : id;
        render(data);
      });
    });
  }

  function chip(label, n, kind) {
    return (
      '<span class="av2-chip av2-chip-' +
      kind +
      '"><b>' +
      n +
      '</b> ' +
      label +
      '</span>'
    );
  }

  function section(title, list, openDefault) {
    if (!list || !list.length) return '';
    let html =
      '<div class="av2-sec"><div class="av2-sec-h">' +
      esc(title) +
      '<span class="av2-sec-n">' +
      list.length +
      '</span></div><div class="av2-rows">';
    for (const s of list) html += row(s, openDefault);
    html += '</div></div>';
    return html;
  }

  function peekSec(title, bodyHtml) {
    if (!bodyHtml) return '';
    return (
      '<div class="av2-peek-sec">' +
      '<div class="av2-peek-k">' +
      esc(title) +
      '</div>' +
      bodyHtml +
      '</div>'
    );
  }

  function row(s, preferExpand) {
    const st = stateOf(s);
    const id = s.relPath || s.id || s.fileName;
    const open = expandedId === id || (preferExpand && st.k === 'working' && !expandedId && false);
    const exp = expandedId === id;
    const sum = rowSummary(s);
    const name = sessionName(s);
    const pg = progress(s);
    const openTodo = ((s.todo && s.todo.items) || []).filter((t) => !t.done);
    const openToolList = s.openTools || [];

    let html =
      '<div class="av2-row av2-' +
      st.k +
      (exp ? ' open' : '') +
      '" data-av-id="' +
      esc(id) +
      '">';

    // left color rail · body: status · task · tools/time
    html += '<div class="av2-rail" aria-hidden="true"></div>';
    html += '<div class="av2-body">';

    // line 1: 左状态 · 中任务名 · 右工具/时间（一行扫完）
    html += '<div class="av2-line1">';
    html +=
      '<span class="av2-status">' +
      '<span class="av2-dot"></span>' +
      '<span class="av2-state">' +
      esc(s.phaseLabel || st.label) +
      '</span></span>';
    html += '<span class="av2-name" title="' + esc(name) + '">' + esc(name) + '</span>';
    html += '<div class="av2-right">';
    if (openToolList.length) {
      html += '<div class="av2-tool-list">';
      openToolList.forEach((t) => {
        const detail = shortSum(t.name, t.summary) || '';
        html +=
          '<span class="av2-tool-chip' +
          (t.batchSize > 1 ? ' batch' : '') +
          '" title="' +
          esc(t.summary || detail) +
          '">' +
          '<span class="av2-tool-chip-name">' +
          esc(toolZh(t.name)) +
          '</span>' +
          (t.batchSize > 1
            ? '<span class="av2-tool-chip-batch" title="并行批次">∥' + t.batchSize + '</span>'
            : '') +
          (detail ? '<em>' + esc(detail) + '</em>' : '') +
          '</span>';
      });
      if (s.concurrency === 'parallel') {
        html += '<span class="av2-tool-chip mode parallel">并行</span>';
      } else if (openToolList.length > 1) {
        html += '<span class="av2-tool-chip mode serial">串行</span>';
      }
      html += '</div>';
    }
    if (s.ageLabel) {
      html += '<span class="av2-age">' + esc(s.ageLabel) + '</span>';
    }
    html += '</div></div>'; // right + line1

    if (s.liveHint) {
      html += '<div class="av2-hint">' + esc(s.liveHint) + '</div>';
    }

    // secondary one-line summary（与工具行互补）
    if (sum) {
      html += '<div class="av2-sum">' + esc(sum) + '</div>';
    }

    if (pg) {
      html +=
        '<div class="av2-pg">' +
        '<div class="av2-pg-track"><div class="av2-pg-fill" style="width:' +
        pg.pct +
        '%"></div></div>' +
        '<span class="av2-pg-txt">' +
        esc(pg.text) +
        (pg.hint ? ' · ' + esc(pg.hint) : '') +
        '</span></div>';
    }

    // expanded peek — 分段清晰；无子代理不渲染空块
    if (exp) {
      html += '<div class="av2-peek">';
      if (s.currentTask) {
        html += peekSec('任务', '<div class="av2-peek-v">' + esc(s.currentTask) + '</div>');
      }
      const lastMap = {
        user: '你刚发了消息',
        thinking: '上次在想',
        toolCall: '上次在调工具',
        toolResult: '上次工具刚跑完',
        assistant: '上次助手说完了',
      };
      html += peekSec(
        '现在怎样',
        '<div class="av2-peek-v">' +
          esc(s.phaseLabel || st.label) +
          (s.lastEventKind
            ? ' · ' + esc(lastMap[s.lastEventKind] || s.lastEventKind)
            : '') +
          '</div>'
      );

      if (openToolList.length) {
        let steps = '';
        for (const t of openToolList) {
          steps +=
            '<div class="av2-peek-step"><span>' +
            esc(toolZh(t.name)) +
            (t.batchSize > 1 ? ' ∥' + t.batchSize : '') +
            '</span><span>' +
            esc(t.summary || shortSum(t.name, t.summary) || '') +
            '</span></div>';
        }
        html += peekSec('正在调用的工具（' + openToolList.length + '）', steps);
      } else if (s.phase === 'stopped' || s.phase === 'idle' || s.phase === 'exited') {
        let toolsBody =
          '<div class="av2-peek-v">' +
          (s.phase === 'exited' ? '进程已退出，没有在跑的工具' : '现在没有在跑的工具') +
          '</div>';
        if ((s.recentDone || []).length) {
          toolsBody += '<div class="av2-peek-k av2-peek-k-sub">刚才用过的工具</div>';
          s.recentDone
            .slice()
            .reverse()
            .slice(0, 5)
            .forEach((t) => {
              toolsBody +=
                '<div class="av2-peek-step"><span>' +
                esc(toolZh(t.name)) +
                (t.ok ? '' : '!') +
                '</span><span>' +
                esc(shortSum(t.name, t.summary) || t.summary || '') +
                '</span></div>';
            });
        }
        html += peekSec('工具', toolsBody);
      }

      if (openTodo.length) {
        let todoHtml = '<ul class="av2-peek-todo">';
        openTodo.slice(0, 8).forEach((t, i) => {
          todoHtml += '<li class="' + (i === 0 ? 'cur' : '') + '">' + esc(t.text) + '</li>';
        });
        todoHtml += '</ul>';
        html += peekSec('Todo 未完成', todoHtml);
      }

      // 子代理：只有真的用过 / 正在跑才显示整块
      const sub = s.subagents || {};
      const subOpen = sub.open || [];
      const subRecent = sub.recent || [];
      if (subOpen.length || subRecent.length) {
        let subBody = '';
        if (subOpen.length) {
          subBody +=
            '<div class="av2-peek-v">' +
            esc(sub.mode === 'parallel' ? '几个一起跑' : '正在跑') +
            '</div>';
          for (const x of subOpen) {
            subBody +=
              '<div class="av2-peek-step"><span>子代理</span><span>' +
              esc(shortSum('subagent', x.summary) || x.summary || '') +
              '</span></div>';
          }
        } else {
          const last = subRecent[subRecent.length - 1];
          const modeZh =
            last.mode === 'parallel' ? '并行' : last.mode === 'single' ? '单个' : last.mode || '';
          const stZh =
            last.status === 'done'
              ? '已结束'
              : last.status === 'error'
                ? '出错了'
                : last.status === 'running'
                  ? '还在跑'
                  : last.status || '';
          subBody +=
            '<div class="av2-peek-v">最近一次：' +
            esc([modeZh, stZh].filter(Boolean).join(' · ')) +
            (last.task ? ' · ' + esc(clip(last.task, 48)) : '') +
            (last.agent ? ' · ' + esc(last.agent) : '') +
            '</div>';
          if (last.results && last.results.length) {
            for (const r of last.results) {
              const rs =
                r.status === 'done' ? '完成' : r.status === 'error' ? '失败' : r.status || '';
              subBody +=
                '<div class="av2-peek-step"><span>' +
                esc(r.agent || '子代理') +
                '</span><span>' +
                esc(rs) +
                '</span></div>';
            }
          }
        }
        html += peekSec('子代理', subBody);
      }

      html +=
        '<div class="av2-peek-foot">' +
        esc(s.model || '') +
        (s.cwd ? ' · ' + esc(clip(s.cwd, 48)) : '') +
        '</div>';
      html += '</div>';
    }

    html += '</div></div>'; // body row
    return html;
  }

  function stopTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }
  function startTimer() {
    stopTimer();
    if ($('#rt-auto')?.checked) {
      timer = setInterval(() => {
        // soft poll every 4s; network at most ~every RT_SOFT_TTL (6s) + server MEM_TTL
        if (typeof state !== 'undefined' && state.route === 'runtime') loadRuntime(false);
      }, 4000);
    }
  }
  function enterRuntimeRoute() {
    // keep expandedId across soft re-enter if same session still shown
    loadRuntime(false);
    startTimer();
    if (typeof refreshIcons === 'function') refreshIcons();
  }
  function bind() {
    $('#rt-refresh')?.addEventListener('click', () => loadRuntime(true));
    $('#rt-auto')?.addEventListener('change', startTimer);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopTimer();
      else if (typeof state !== 'undefined' && state.route === 'runtime') startTimer();
    });
  }

  window.enterRuntimeRoute = enterRuntimeRoute;
  window.loadRuntime = loadRuntime;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
