/* Minimal line diff for Pi Manager save preview */

function diffLines(oldText, newText) {
  const a = String(oldText ?? '').split(/\r?\n/);
  const b = String(newText ?? '').split(/\r?\n/);
  const MAX = 4000;
  if (a.length + b.length > MAX) {
    return {
      truncated: true,
      rows: [
        {
          type: 'meta',
          text:
            '内容过长，仅显示行数：旧 ' +
            a.length +
            ' 行 → 新 ' +
            b.length +
            ' 行（请确认后保存）',
        },
      ],
      summary: { add: Math.max(0, b.length - a.length), del: Math.max(0, a.length - b.length), same: 0, truncated: true },
    };
  }

  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows = [];
  let i = 0;
  let j = 0;
  let add = 0;
  let del = 0;
  let same = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: 'same', text: a[i] });
      same++;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: 'del', text: a[i] });
      del++;
      i++;
    } else {
      rows.push({ type: 'add', text: b[j] });
      add++;
      j++;
    }
  }
  while (i < n) {
    rows.push({ type: 'del', text: a[i++] });
    del++;
  }
  while (j < m) {
    rows.push({ type: 'add', text: b[j++] });
    add++;
  }
  return { truncated: false, rows, summary: { add, del, same, truncated: false } };
}

function renderDiffHtml(oldText, newText) {
  const escFn =
    typeof esc === 'function'
      ? esc
      : (s) =>
          String(s ?? '').replace(/[&<>"']/g, (c) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
          );
  const { rows, summary, truncated } = diffLines(oldText, newText);
  let html = '';
  if (truncated) html += '<div class="diff-meta">内容过长，已简化预览</div>';
  html +=
    '<div class="diff-summary">+' +
    summary.add +
    ' / −' +
    summary.del +
    (summary.same ? ' · 未改 ' + summary.same + ' 行' : '') +
    '</div>';

  const out = [];
  if (!truncated && rows.length > 100) {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.type === 'same') {
        const near =
          (rows[i - 1] && rows[i - 1].type !== 'same') ||
          (rows[i + 1] && rows[i + 1].type !== 'same');
        if (!near) continue;
      }
      out.push(r);
    }
  } else {
    out.push(...rows);
  }

  html += '<pre class="diff-view">';
  for (const r of out) {
    if (r.type === 'meta') {
      html += '<div class="diff-meta">' + escFn(r.text) + '</div>';
      continue;
    }
    const cls = r.type === 'add' ? 'diff-add' : r.type === 'del' ? 'diff-del' : 'diff-same';
    const pre = r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' ';
    html +=
      '<div class="' +
      cls +
      '"><span class="diff-mark">' +
      pre +
      '</span>' +
      escFn(r.text) +
      '</div>';
  }
  html += '</pre>';
  return { html, summary };
}

function ensureDiffModal() {
  let modal = document.getElementById('diff-modal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'diff-modal';
  modal.className = 'modal-overlay hidden';
  modal.innerHTML =
    '<div class="modal-card diff-modal-card" role="dialog" aria-modal="true">' +
    '<div class="modal-head">' +
    '<strong id="diff-modal-title">保存预览</strong>' +
    '<button type="button" class="btn ghost sm" id="diff-modal-close">关闭</button>' +
    '</div>' +
    '<div id="diff-modal-body" class="diff-modal-body"></div>' +
    '<div class="modal-actions">' +
    '<button type="button" class="btn ghost sm" id="diff-modal-cancel">取消</button>' +
    '<button type="button" class="btn primary sm" id="diff-modal-ok">确认保存</button>' +
    '</div></div>';
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) hideDiffModal(false);
  });
  document.getElementById('diff-modal-close').addEventListener('click', () => hideDiffModal(false));
  document.getElementById('diff-modal-cancel').addEventListener('click', () => hideDiffModal(false));
  return modal;
}

let _diffResolve = null;

function hideDiffModal(ok) {
  const modal = document.getElementById('diff-modal');
  if (modal) modal.classList.add('hidden');
  const r = _diffResolve;
  _diffResolve = null;
  if (r) r(!!ok);
}

/** @returns {Promise<boolean>} */
function confirmDiffSave(title, oldText, newText) {
  if (String(oldText ?? '') === String(newText ?? '')) return Promise.resolve(true);
  ensureDiffModal();
  const { html, summary } = renderDiffHtml(oldText, newText);
  if (summary.add === 0 && summary.del === 0 && !summary.truncated) return Promise.resolve(true);
  document.getElementById('diff-modal-title').textContent = title || '保存预览';
  document.getElementById('diff-modal-body').innerHTML = html;
  document.getElementById('diff-modal').classList.remove('hidden');
  return new Promise((resolve) => {
    _diffResolve = resolve;
    const okBtn = document.getElementById('diff-modal-ok');
    const onOk = () => {
      okBtn.removeEventListener('click', onOk);
      hideDiffModal(true);
    };
    okBtn.addEventListener('click', onOk);
  });
}
