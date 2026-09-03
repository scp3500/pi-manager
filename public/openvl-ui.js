/* OpenVL & Ollama UI — extracted from app.js */
(function () {
  const {
    state,
    $,
    $$,
    esc,
    maskDots,
    isKeyMaskValue,
    api,
    showToast,
    setDirty,
    updateGlobalSaveUI,
    parseJsonField,
  } = window.PiManagerCore || window;

  // ── openvl UI ───────────────────────────────────────────────────────────────

  async function loadOpenvl() {
    try {
      const data = await api('/api/openvl/profiles');
      state.openvlAvailable = data.available !== false;
      state.openvlProfiles = data.profiles || [];
      state.openvlActive = data.active || null;
      state.openvlOllama = data.ollama || { url: '', model: '', backend: 'ollama' };
      state.openvlPaths = data.paths || {};
      state.openvlHint = data.hint || '';
    } catch (e) {
      state.openvlAvailable = false;
      state.openvlProfiles = [];
      state.openvlHint = e.message || String(e);
      console.warn('loadOpenvl failed', e);
    }
    if (typeof updateCapabilityHints === 'function') updateCapabilityHints();
  }

  function bindOpenvlUI() {
    $('#openvl-new')?.addEventListener('click', () => createOpenvlProfile());
    $('#openvl-clone')?.addEventListener('click', () => cloneOpenvlProfile());
    $('#openvl-save')?.addEventListener('click', () => saveOpenvlProfile());
    $('#openvl-delete')?.addEventListener('click', () => deleteOpenvlProfile());
    $('#openvl-activate')?.addEventListener('click', () => activateOpenvlProfile());
    $('#openvl-test')?.addEventListener('click', () => testOpenvlApi());
    $('#ov-toggle-key')?.addEventListener('click', () => toggleOpenvlKey());
    $('#ov-model-add')?.addEventListener('click', () => addOpenvlModel());
    $('#ov-model-detect')?.addEventListener('click', () => fetchOpenvlModels());
    $('#ov-remote-close')?.addEventListener('click', () => {
      $('#ov-remote-models-panel')?.classList.add('hidden');
    });
    $('#ov-remote-import-new')?.addEventListener('click', () => importOpenvlRemoteModels('new'));
    $('#ov-remote-import-sel')?.addEventListener('click', () => importOpenvlRemoteModels('selected'));
    $('#ov-remote-select-new')?.addEventListener('click', () => selectOpenvlRemote('new'));
    $('#ov-remote-select-none')?.addEventListener('click', () => selectOpenvlRemote('none'));
    $('#ov-remote-filter')?.addEventListener('input', (e) => {
      state.openvlRemoteFilter = e.target.value || '';
      renderOpenvlRemoteModelsList();
    });
    $('#ov-remote-hide-local')?.addEventListener('change', (e) => {
      state.openvlRemoteHideLocal = !!e.target.checked;
      renderOpenvlRemoteModelsList();
    });
    $('#ov-model')?.addEventListener('change', () => setDirty('openvl', true));
    $('#openvl-form')?.addEventListener('input', (e) => {
      if (e.target && e.target.id === 'ov-apiKey') {
        state.openvlKeepKey = false;
        state.openvlKeyPlaceholder = false;
      }
      setDirty('openvl', true);
    });
    $('#ov-apiKey')?.addEventListener('focus', () => {
      if (state.openvlKeyPlaceholder && !state.openvlKeyVisible) {
        $('#ov-apiKey').value = '';
        state.openvlKeyPlaceholder = false;
        state.openvlKeepKey = false;
      }
    });
    $('#openvl-form')?.addEventListener('change', () => setDirty('openvl', true));
    $('#openvl-ollama-item')?.addEventListener('click', () => selectOpenvlOllama(true));
    $('#openvl-ollama-save')?.addEventListener('click', () => saveOpenvlOllama());
    $('#openvl-ollama-check')?.addEventListener('click', () => checkOpenvlOllama());
    $('#openvl-ollama-form')?.addEventListener('input', () => setDirty('openvl', true));
    $('#ov-backend')?.addEventListener('change', () => {
      const v = $('#ov-backend').value;
      if (v === 'llamacpp') {
        if (!$('#ov-ollama-url').value || $('#ov-ollama-url').value.includes('11434')) {
          $('#ov-ollama-url').value = 'http://127.0.0.1:8080';
        }
        if (!$('#ov-ollama-model').value || $('#ov-ollama-model').value.includes('minicpm')) {
          $('#ov-ollama-model').value = 'MiniCPM-V-4.6-Q4_K_M.gguf';
        }
      } else if (!$('#ov-ollama-url').value || $('#ov-ollama-url').value.includes('8080')) {
        $('#ov-ollama-url').value = 'http://127.0.0.1:11434';
      }
      setDirty('openvl', true);
    });
  }

  function renderOpenvlList() {
    const box = $('#openvl-list');
    if (!box) return;
    box.innerHTML = '';
    if (state.openvlAvailable === false) {
      const empty = document.createElement('div');
      empty.className = 'side-list-empty';
      empty.textContent = '未安装识图组件';
      box.appendChild(empty);
    } else if (!state.openvlProfiles.length) {
      const empty = document.createElement('div');
      empty.className = 'side-list-empty';
      empty.textContent = '暂无配置';
      box.appendChild(empty);
    }
    state.openvlProfiles.forEach((p) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className =
        'side-item' +
        (state.openvlView === 'profile' && state.currentOpenvlId === p.id ? ' active' : '');
      btn.innerHTML =
        '<div class="si-title">' +
        esc(p.name || p.id) +
        '</div>' +
        '<div class="si-sub">' +
        esc(p.model || p.api_base || '未配置模型') +
        '</div>' +
        '<div class="si-tags">' +
        (p.active ? '<span class="badge ok">当前</span>' : '') +
        (p.hasKey ? '<span class="badge accent">key</span>' : '<span class="badge warn">无 key</span>') +
        '</div>';
      btn.addEventListener('click', () => selectOpenvlProfile(p.id, true));
      box.appendChild(btn);
    });
    const oItem = $('#openvl-ollama-item');
    if (oItem) oItem.classList.toggle('active', state.openvlView === 'ollama');
  }

  function showOpenvlEmpty() {
    state.currentOpenvlId = null;
    state.openvlDetail = null;
    state.openvlView = 'profile';
    $('#openvl-empty')?.classList.remove('hidden');
    $('#openvl-editor')?.classList.add('hidden');
    $('#openvl-ollama-editor')?.classList.add('hidden');
    const msg = $('#openvl-empty-msg');
    if (msg) {
      if (state.openvlAvailable === false) {
        msg.innerHTML =
          '<div class="empty-fallback">' +
          '<p class="empty-kicker">本页需要额外组件</p>' +
          '<p class="empty-title">还不能用识图</p>' +
          '<p class="empty-desc"><strong>原因：</strong>本机没找到 OpenVL（识图工具）。</p>' +
          '<p class="empty-desc"><strong>影响：</strong>只有本页不可用；模型、子代理、提示词等照常。</p>' +
          '<p class="empty-desc"><strong>若要启用：</strong>' +
          esc(state.openvlHint || '终端执行 npm install -g @scp3500/openvl，或设置 OPENVL_PKG_DIR 指向安装目录，然后刷新本页。') +
          '</p>' +
          '<div class="empty-actions">' +
          '<a class="btn primary sm" href="#/guides?topic=openvl">查看识图教程</a>' +
          '<a class="btn ghost sm" href="https://www.npmjs.com/package/@scp3500/openvl" target="_blank" rel="noopener noreferrer">npm 安装</a>' +
          '<a class="btn ghost sm" href="#/models">去模型</a>' +
          '</div></div>';
      } else {
        msg.innerHTML =
          '<p>选择左侧配置，或新建一个</p>' +
          '<p class="page-hint-inline">日常用云端 profile；本地备用已折叠在侧栏高级区</p>' +
          '<div class="empty-actions">' +
          '<a class="btn primary sm" href="#/guides?topic=openvl">查看识图教程</a>' +
          '</div>';
      }
    }
    // 未安装时禁用写操作按钮
    const disabled = state.openvlAvailable === false;
    ['openvl-new', 'openvl-clone', 'openvl-save', 'openvl-delete', 'openvl-activate', 'openvl-test'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = disabled;
    });
    renderOpenvlList();
  }

  async function selectOpenvlProfile(id, confirmLeave) {
    if (
      confirmLeave &&
      state.openvlDirty &&
      ((state.openvlView === 'profile' && state.currentOpenvlId && state.currentOpenvlId !== id) ||
        state.openvlView === 'ollama') &&
      !confirm('有未保存修改，切换？')
    ) {
      return;
    }
    try {
      const p = state.openvlProfiles.find((x) => x.id === id);
      if (!p) throw new Error('not found');
      state.openvlView = 'profile';
      state.currentOpenvlId = id;
      state.openvlDetail = p;
      state.openvlModels = Array.isArray(p.models) ? p.models.slice() : [];
      if (p.model && !state.openvlModels.includes(p.model)) state.openvlModels.unshift(p.model);
      fillOpenvlProfileForm(p);
      $('#openvl-empty')?.classList.add('hidden');
      $('#openvl-editor')?.classList.remove('hidden');
      $('#openvl-ollama-editor')?.classList.add('hidden');
      $('#ov-title').textContent = p.name || id;
      ['openvl-new', 'openvl-clone', 'openvl-save', 'openvl-delete', 'openvl-activate', 'openvl-test'].forEach((id2) => {
        const el = document.getElementById(id2);
        if (el) el.disabled = false;
      });
      setDirty('openvl', false);
      renderOpenvlList();
    } catch (e) {
      showToast('读取识图配置失败: ' + e.message, false);
    }
  }

  function selectOpenvlOllama(confirmLeave) {
    if (
      confirmLeave &&
      state.openvlDirty &&
      state.openvlView !== 'ollama' &&
      !confirm('有未保存修改，切换？')
    ) {
      return;
    }
    state.openvlView = 'ollama';
    state.currentOpenvlId = null;
    $('#openvl-empty')?.classList.add('hidden');
    $('#openvl-editor')?.classList.add('hidden');
    $('#openvl-ollama-editor')?.classList.remove('hidden');
    const o = state.openvlOllama || {};
    $('#ov-backend').value = o.backend || 'ollama';
    $('#ov-ollama-url').value = o.url || 'http://127.0.0.1:11434';
    $('#ov-ollama-model').value = o.model || 'openbmb/minicpm-v4.6';
    const st = $('#ov-ollama-status');
    if (st) {
      st.textContent = '未检查';
      st.className = 'hint-block';
    }
    setDirty('openvl', false);
    renderOpenvlList();
  }

  function fillOpenvlProfileForm(p) {
    const hasKey = !!(p.hasKey || (p.apiKey && String(p.apiKey).length));
    state.openvlKeepKey = hasKey;
    state.openvlKeyVisible = false;
    state.openvlKeyPlaceholder = hasKey;
    state.openvlStoredKey = hasKey ? String(p.apiKey || '') : '';
    $('#ov-name').value = p.name || '';
    $('#ov-active-label').value = p.active ? '当前生效（已同步 config.env）' : '未激活';
    $('#ov-apiKey').type = 'password';
    if (hasKey) {
      const len = state.openvlStoredKey ? state.openvlStoredKey.length : 12;
      $('#ov-apiKey').value = maskDots(len);
      $('#ov-apiKey').placeholder = '';
    } else {
      $('#ov-apiKey').value = '';
      $('#ov-apiKey').placeholder = 'sk-…';
    }
    $('#ov-toggle-key').textContent = '显示';
    $('#ov-apiBase').value = p.api_base || '';
    $('#ov-api-type').value = p.apiType || '';
    renderOpenvlModels(p.model || '');
    const paths = state.openvlPaths || {};
    $('#ov-paths').textContent =
      'profiles: ' +
      (paths.profilesFile || state.meta.openvlProfilesFile || '') +
      '\nenv: ' +
      (paths.envFile || state.meta.openvlEnvFile || '') +
      (paths.mirrors && paths.mirrors.length
        ? '\nmirrors:\n  ' + paths.mirrors.join('\n  ')
        : '');
    const st = $('#openvl-status');
    if (st) {
      st.className = 'hint-block' + (p.active ? ' ok' : '');
      st.textContent = p.active
        ? '此配置当前生效，保存后会同步到 config.env'
        : '此配置未激活。保存只改 profiles；点「设为当前」才会写 config.env';
    }
  }

  /** @deprecated alias — app.js historically used fillOpenvlForm */
  const fillOpenvlForm = fillOpenvlProfileForm;

  function renderOpenvlModels(current) {
    const sel = $('#ov-model');
    const tags = $('#ov-model-tags');
    const models = state.openvlModels || [];
    if (sel) {
      sel.innerHTML = '';
      if (!models.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '(无模型)';
        sel.appendChild(opt);
      } else {
        models.forEach((m) => {
          const opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m;
          if (m === current) opt.selected = true;
          sel.appendChild(opt);
        });
        if (current && !models.includes(current) && models.length) sel.value = models[0];
      }
    }
    if (tags) {
      tags.innerHTML = '';
      const cur = current || (sel && sel.value) || '';
      models.forEach((m) => {
        const span = document.createElement('span');
        span.className = 'ov-tag' + (m === cur ? ' active' : '');
        span.appendChild(document.createTextNode(m + ' '));
        span.addEventListener('click', () => {
          if (sel) sel.value = m;
          renderOpenvlModels(m);
          setDirty('openvl', true);
        });
        const x = document.createElement('span');
        x.className = 'x';
        x.textContent = '×';
        x.title = '删除 ' + m;
        x.addEventListener('click', (e) => {
          e.stopPropagation();
          removeOpenvlModel(m);
        });
        span.appendChild(x);
        tags.appendChild(span);
      });
    }
    const cnt = $('#ov-models-count');
    if (cnt) cnt.textContent = String(models.length);
  }

  function addOpenvlModel() {
    const input = $('#ov-model-new');
    const m = (input?.value || '').trim();
    if (!m) {
      showToast('输入模型名', false);
      return;
    }
    if (!state.openvlModels.includes(m)) state.openvlModels.push(m);
    if (input) input.value = '';
    renderOpenvlModels(m);
    setDirty('openvl', true);
  }

  function removeOpenvlModel(modelName) {
    const m = modelName;
    if (state.openvlModels.length <= 1) {
      showToast('至少保留一个模型', false);
      return;
    }
    state.openvlModels = state.openvlModels.filter((x) => x !== m);
    const cur = $('#ov-model')?.value;
    renderOpenvlModels(cur === m ? state.openvlModels[0] : cur);
    setDirty('openvl', true);
  }

  function toggleOpenvlKey() {
    const inp = $('#ov-apiKey');
    if (!inp) return;
    if (!state.openvlKeyVisible) {
      state.openvlKeyVisible = true;
      inp.type = 'text';
      $('#ov-toggle-key').textContent = '隐藏';
      if (state.openvlKeyPlaceholder) {
        inp.value = state.openvlStoredKey || '';
        state.openvlKeyPlaceholder = false;
        state.openvlKeepKey = true;
      }
    } else {
      state.openvlKeyVisible = false;
      inp.type = 'password';
      $('#ov-toggle-key').textContent = '显示';
      if (
        state.openvlKeepKey &&
        state.openvlStoredKey &&
        inp.value === state.openvlStoredKey
      ) {
        inp.value = maskDots(state.openvlStoredKey ? state.openvlStoredKey.length : 12);
        state.openvlKeyPlaceholder = true;
      } else if (state.openvlKeepKey && !inp.value && state.openvlStoredKey) {
        inp.value = maskDots(state.openvlStoredKey.length);
        state.openvlKeyPlaceholder = true;
      }
    }
  }

  async function saveOpenvlProfile() {
    if (!state.currentOpenvlId) {
      showToast('没有选中的配置', false);
      return;
    }
    try {
      const body = {
        name: ($('#ov-name').value || '').trim(),
        api_base: ($('#ov-apiBase').value || '').trim(),
        api_type: ($('#ov-api-type').value || '').trim(),
        model: ($('#ov-model').value || '').trim(),
        models: state.openvlModels.slice(),
      };
      const keyVal = ($('#ov-apiKey').value || '').trim();
      if (
        state.openvlKeyPlaceholder ||
        isKeyMaskValue(keyVal) ||
        (state.openvlKeepKey &&
          (keyVal === '' || keyVal === state.openvlStoredKey))
      ) {
        body.api_key = '__KEEP__';
      } else {
        body.api_key = keyVal;
      }

      await api('/api/openvl/profiles/' + encodeURIComponent(state.currentOpenvlId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await loadOpenvl();
      await selectOpenvlProfile(state.currentOpenvlId, false);
      setDirty('openvl', false);
      showToast('识图配置已保存');
    } catch (e) {
      showToast('保存失败: ' + e.message, false);
      throw e;
    }
  }

  async function createOpenvlProfile(body) {
    if (state.openvlDirty && !confirm('有未保存修改，继续新建？')) return;
    const name =
      (body && body.name) ||
      prompt('新配置名称:', '新配置');
    if (!name) return;
    try {
      const payload = body && typeof body === 'object' ? { ...body, name } : { name };
      const p = await api('/api/openvl/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      await loadOpenvl();
      await selectOpenvlProfile(p.id, false);
      showToast('已创建: ' + name);
      return p;
    } catch (e) {
      showToast('创建失败: ' + e.message, false);
    }
  }

  /** Planned alias for createOpenvlProfile */
  function openNewOpenvlProfile() {
    return createOpenvlProfile();
  }

  async function cloneOpenvlProfile(id) {
    const targetId = id || state.currentOpenvlId;
    if (!targetId) {
      showToast('先选择一个配置', false);
      return;
    }
    const src = state.openvlProfiles.find((x) => x.id === targetId);
    if (!src) return;
    const name = prompt('复制为:', (src.name || src.id) + ' (复制)');
    if (!name) return;
    try {
      let key = '';
      try {
        const full = await api(
          '/api/openvl/profiles/' + encodeURIComponent(src.id) + '?reveal=1'
        );
        key = full.apiKey || '';
      } catch {
        /* ignore */
      }
      const p = await api('/api/openvl/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          api_key: key,
          api_base: src.api_base || '',
          model: src.model || '',
          models: src.models || [],
        }),
      });
      await loadOpenvl();
      await selectOpenvlProfile(p.id, false);
      showToast('已复制: ' + name);
    } catch (e) {
      showToast('复制失败: ' + e.message, false);
    }
  }

  async function activateOpenvlProfile(id) {
    const targetId = id || state.currentOpenvlId;
    if (!targetId) return;
    if (!state.currentOpenvlId) state.currentOpenvlId = targetId;
    if (state.openvlDirty) {
      const ok = confirm('有未保存修改。先保存再设为当前？');
      if (ok) await saveOpenvlProfile();
    }
    try {
      await api('/api/openvl/profiles/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: targetId }),
      });
      await loadOpenvl();
      await selectOpenvlProfile(targetId, false);
      showToast('已设为当前配置并同步 config.env');
    } catch (e) {
      showToast('切换失败: ' + e.message, false);
    }
  }

  async function deleteOpenvlProfile() {
    if (!state.currentOpenvlId) return;
    if (state.openvlProfiles.length <= 1) {
      showToast('至少保留一个配置', false);
      return;
    }
    const p = state.openvlProfiles.find((x) => x.id === state.currentOpenvlId);
    if (!confirm('删除配置 "' + (p?.name || state.currentOpenvlId) + '"？')) return;
    try {
      const data = await api('/api/openvl/profiles/' + encodeURIComponent(state.currentOpenvlId), {
        method: 'DELETE',
      });
      await loadOpenvl();
      const next = data.active || (state.openvlProfiles[0] && state.openvlProfiles[0].id);
      if (next) await selectOpenvlProfile(next, false);
      else showOpenvlEmpty();
      showToast('已删除');
    } catch (e) {
      showToast('删除失败: ' + e.message, false);
    }
  }

  async function testOpenvlApi() {
    const st = $('#openvl-status');
    const btn = $('#openvl-test');
    if (!state.currentOpenvlId) return showToast('请先选择配置', false);
    if (btn) {
      btn.disabled = true;
      btn.textContent = '检测中…';
    }
    if (st) {
      st.className = 'hint-block warn';
      st.textContent = '正在检测…（使用当前表单里的地址 / Key / 模型）';
    }
    try {
      let apiKey = ($('#ov-apiKey')?.value || '').trim();
      if (state.openvlKeyPlaceholder || isKeyMaskValue(apiKey) || (state.openvlKeepKey && !apiKey)) {
        apiKey = '__KEEP__';
      }
      const body = {
        id: state.currentOpenvlId,
        api_base: ($('#ov-apiBase')?.value || '').trim() || undefined,
        api_key: apiKey || undefined,
        model: ($('#ov-model')?.value || '').trim() || undefined,
      };
      const r = await api('/api/openvl/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (st) {
        st.className = 'hint-block ' + (r.ok ? 'ok' : 'err');
        const ep = r.endpoint ? ' · ' + r.endpoint : '';
        st.textContent = r.ok
          ? '检测通过 ✓ ' + (r.message || ('HTTP ' + (r.status || ''))) + ep
          : '检测失败: ' + (r.error || r.message || 'unknown') + ep;
      }
      showToast(
        r.ok ? '检测通过' : '检测失败: ' + (r.error || r.message || ''),
        r.ok
      );
    } catch (e) {
      if (st) {
        st.className = 'hint-block err';
        st.textContent = '检测失败: ' + e.message;
      }
      showToast('检测失败: ' + e.message, false);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '检测';
      }
    }
  }

  function filteredOpenvlRemoteModels() {
    let list = state.openvlRemoteModels || [];
    if (state.openvlRemoteHideLocal) list = list.filter((m) => !m.local);
    const q = (state.openvlRemoteFilter || '').trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (m) =>
        m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q)
    );
  }

  function renderOpenvlRemoteModelsList() {
    const box = $('#ov-remote-models-list');
    if (!box) return;
    const list = filteredOpenvlRemoteModels();
    if (!list.length) {
      box.innerHTML =
        '<div class="remote-empty">' +
        ((state.openvlRemoteModels || []).length ? '无匹配项' : '暂无结果，点「获取模型」') +
        '</div>';
      return;
    }
    box.innerHTML = list
      .map((m) => {
        const checked = state.openvlRemoteSelected?.has(m.id) ? ' checked' : '';
        return (
          '<label class="ov-fetch-item' +
          (m.local ? ' is-local' : '') +
          '">' +
          '<input type="checkbox" class="ov-remote-check" data-id="' +
          esc(m.id) +
          '"' +
          checked +
          (m.local ? ' disabled' : '') +
          '>' +
          '<div class="ov-fetch-main">' +
          '<div class="ov-fetch-id mono">' +
          esc(m.id) +
          '</div>' +
          (m.name && m.name !== m.id
            ? '<div class="ov-fetch-sub">' + esc(m.name) + '</div>'
            : '') +
          '</div>' +
          (m.local
            ? '<span class="badge ok">已有</span>'
            : '<span class="badge accent">新</span>') +
          '</label>'
        );
      })
      .join('');
    box.querySelectorAll('.ov-remote-check').forEach((el) => {
      el.addEventListener('change', () => {
        if (!state.openvlRemoteSelected) state.openvlRemoteSelected = new Set();
        if (el.checked) state.openvlRemoteSelected.add(el.dataset.id);
        else state.openvlRemoteSelected.delete(el.dataset.id);
      });
    });
  }

  function selectOpenvlRemote(mode) {
    const list = state.openvlRemoteModels || [];
    if (!state.openvlRemoteSelected) state.openvlRemoteSelected = new Set();
    if (mode === 'none') state.openvlRemoteSelected = new Set();
    else if (mode === 'new') {
      state.openvlRemoteSelected = new Set(list.filter((m) => !m.local).map((m) => m.id));
    }
    renderOpenvlRemoteModelsList();
  }

  async function fetchOpenvlModels() {
    if (!state.currentOpenvlId) return showToast('请先选择配置', false);
    const btn = $('#ov-model-detect');
    const st = $('#openvl-status');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '获取中…';
    }
    if (st) {
      st.className = 'hint-block warn';
      st.textContent = '正在获取模型列表…';
    }
    try {
      let apiKey = ($('#ov-apiKey')?.value || '').trim();
      if (state.openvlKeyPlaceholder || isKeyMaskValue(apiKey)) apiKey = '__KEEP__';
      if (!apiKey && state.openvlKeepKey) apiKey = '__KEEP__';
      const body = {
        id: state.currentOpenvlId,
        api_base: ($('#ov-apiBase')?.value || '').trim() || undefined,
        api_key: apiKey || undefined,
      };
      const data = await api('/api/openvl/remote-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      state.openvlRemoteModels = data.models || [];
      state.openvlRemoteFilter = '';
      state.openvlRemoteHideLocal = false;
      if ($('#ov-remote-filter')) $('#ov-remote-filter').value = '';
      if ($('#ov-remote-hide-local')) $('#ov-remote-hide-local').checked = false;
      // 默认全不选，避免误导入
      state.openvlRemoteSelected = new Set();
      const panel = $('#ov-remote-models-panel');
      panel?.classList.remove('hidden');
      const meta = $('#ov-remote-meta');
      if (meta) {
        const localN = state.openvlRemoteModels.filter((m) => m.local).length;
        const newN = state.openvlRemoteModels.length - localN;
        meta.textContent =
          state.openvlRemoteModels.length +
          ' 个 · 新 ' +
          newN +
          (localN ? ' · 已有 ' + localN : '') +
          (data.url ? ' · ' + data.url : '');
      }
      renderOpenvlRemoteModelsList();
      if (st) {
        st.className = 'hint-block ok';
        st.textContent =
          '已获取 ' +
          state.openvlRemoteModels.length +
          ' 个模型' +
          (data.url ? '（' + data.url + '）' : '') +
          '。勾选后点「导入勾选」，再保存配置。';
      }
      showToast('获取到 ' + state.openvlRemoteModels.length + ' 个模型');
    } catch (e) {
      if (st) {
        st.className = 'hint-block err';
        st.textContent = '获取模型失败: ' + e.message;
      }
      showToast('获取失败: ' + e.message, false);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '获取模型';
      }
    }
  }

  function importOpenvlRemoteModels(mode) {
    const list = state.openvlRemoteModels || [];
    if (!list.length) return showToast('没有可导入的模型', false);
    let ids = [];
    if (mode === 'new') {
      ids = list.filter((m) => !m.local).map((m) => m.id);
    } else {
      // selected
      ids = list
        .filter((m) => state.openvlRemoteSelected?.has(m.id) && !m.local)
        .map((m) => m.id);
    }
    if (!ids.length) {
      return showToast(
        mode === 'new' ? '没有新的模型可导入' : '请先勾选要导入的新模型',
        false
      );
    }
    const set = new Set(state.openvlModels || []);
    let added = 0;
    ids.forEach((id) => {
      if (!set.has(id)) {
        set.add(id);
        added++;
      }
    });
    state.openvlModels = [...set];
    renderOpenvlModels();
    setDirty('openvl', true);
    state.openvlRemoteModels = list.map((m) => ({
      ...m,
      local: set.has(m.id),
    }));
    state.openvlRemoteSelected = new Set(
      state.openvlRemoteModels.filter((m) => !m.local).map((m) => m.id)
    );
    renderOpenvlRemoteModelsList();
    const st = $('#openvl-status');
    if (st) {
      st.className = 'hint-block ' + (added ? 'ok' : 'warn');
      st.textContent = added
        ? '已加入 ' + added + ' 个模型到列表，请点右上角「保存」写入配置。'
        : '没有新增（可能都已在列表中）。';
    }
    showToast(added ? '已加入 ' + added + ' 个，记得保存' : '没有新增');
  }

  async function saveOpenvlOllama() {
    try {
      const body = {
        backend: $('#ov-backend').value,
        url: ($('#ov-ollama-url').value || '').trim(),
        model: ($('#ov-ollama-model').value || '').trim(),
      };
      state.openvlOllama = await api('/api/openvl/ollama', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setDirty('openvl', false);
      showToast('本地备用配置已保存');
    } catch (e) {
      showToast('保存失败: ' + e.message, false);
      throw e;
    }
  }

  async function checkOpenvlOllama() {
    const st = $('#ov-ollama-status');
    if (st) st.textContent = '检查中…';
    try {
      const r = await api('/api/openvl/ollama/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: ($('#ov-ollama-url').value || '').trim(),
          backend: $('#ov-backend').value,
        }),
      });
      if (st) {
        st.textContent = r.ok
          ? '连接正常 · ' + (r.version || '') + (r.models && r.models[0] ? ' · ' + r.models[0] : '')
          : '失败: ' + (r.error || 'unknown');
        st.className = 'hint-block ' + (r.ok ? 'ok' : 'err');
      }
      showToast(r.ok ? '本地服务在线' : '本地服务离线', r.ok);
    } catch (e) {
      if (st) {
        st.textContent = '请求失败: ' + e.message;
        st.className = 'hint-block err';
      }
    }
  }

  async function runOpenvlDoctor() {
    const st = $('#openvl-status') || $('#ov-ollama-status');
    try {
      if (st) {
        st.className = 'hint-block warn';
        st.textContent = '正在运行 OpenVL doctor…';
      }
      // Backend route is GET /api/openvl/doctor
      const r = await api('/api/openvl/doctor');
      const ok = r && (r.ok === true || r.status === 'ok' || !r.error);
      const msg =
        (r && (r.message || r.summary || r.output || r.hint)) ||
        (ok ? 'doctor 完成' : 'doctor 失败');
      if (st) {
        st.className = 'hint-block ' + (ok ? 'ok' : 'err');
        st.textContent = typeof msg === 'string' ? msg : JSON.stringify(msg);
      }
      showToast(ok ? 'OpenVL doctor 完成' : 'OpenVL doctor 失败', ok);
      return r;
    } catch (e) {
      if (st) {
        st.className = 'hint-block err';
        st.textContent = 'doctor 失败: ' + e.message;
      }
      showToast('doctor 失败: ' + e.message, false);
      throw e;
    }
  }

  // Silence unused-destructure lint in some bundlers (kept for API parity)
  void ($$ || updateGlobalSaveUI || parseJsonField || fillOpenvlForm);

  window.PiManager = window.PiManager || {};
  window.PiManager.openvl = {
    loadOpenvl,
    bindOpenvlUI,
    showOpenvlEmpty,
    renderOpenvlList,
    selectOpenvlProfile,
    openNewOpenvlProfile,
    fillOpenvlProfileForm,
    saveOpenvlProfile,
    createOpenvlProfile,
    cloneOpenvlProfile,
    activateOpenvlProfile,
    deleteOpenvlProfile,
    renderOpenvlModels,
    addOpenvlModel,
    removeOpenvlModel,
    fetchOpenvlModels,
    renderOpenvlRemoteModelsList,
    selectOpenvlRemote,
    importOpenvlRemoteModels,
    filteredOpenvlRemoteModels,
    testOpenvlApi,
    selectOpenvlOllama,
    saveOpenvlOllama,
    checkOpenvlOllama,
    runOpenvlDoctor,
    toggleOpenvlKey,
  };
  // 挂载旧式 window.* 兼容导出供 app.js 路由分发及 console-ui 等调用
  Object.assign(window, window.PiManager.openvl);
})();
