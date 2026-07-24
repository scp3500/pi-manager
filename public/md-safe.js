/**
 * Safe Markdown → HTML for Pi Manager previews/chat.
 * Strips raw HTML from Markdown source, then sanitizes the rendered HTML.
 */
(function (global) {
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Remove HTML tags from markdown source so marked cannot pass raw HTML through. */
  function stripHtmlFromMarkdown(src) {
    return String(src || '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, '');
  }

  const ALLOWED_TAGS = new Set([
    'a',
    'b',
    'blockquote',
    'br',
    'code',
    'del',
    'em',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'i',
    'li',
    'ol',
    'p',
    'pre',
    'strong',
    'table',
    'tbody',
    'td',
    'th',
    'thead',
    'tr',
    'ul',
    'span',
    'div',
  ]);

  const ALLOWED_ATTR = {
    a: new Set(['href', 'title']),
    code: new Set(['class']),
    span: new Set(['class']),
    div: new Set(['class']),
    th: new Set(['align']),
    td: new Set(['align']),
  };

  function isSafeUrl(url) {
    if (url == null || url === '') return false;
    const u = String(url).trim();
    if (/^#/i.test(u)) return true;
    if (/^https?:\/\//i.test(u)) return true;
    if (/^mailto:/i.test(u)) return true;
    // relative paths only
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) return false;
    if (/^\/\//.test(u)) return false;
    return true;
  }

  function sanitizeHtml(html) {
    if (typeof document === 'undefined') {
      // non-browser fallback: strip tags
      return escapeHtml(String(html || '').replace(/<[^>]+>/g, ''));
    }
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html || '');
    const walk = (node) => {
      const children = Array.from(node.childNodes);
      for (const child of children) {
        if (child.nodeType === 8 /* comment */) {
          child.remove();
          continue;
        }
        if (child.nodeType === 3 /* text */) continue;
        if (child.nodeType !== 1) {
          child.remove();
          continue;
        }
        const tag = child.tagName.toLowerCase();
        if (!ALLOWED_TAGS.has(tag)) {
          // unwrap text
          while (child.firstChild) node.insertBefore(child.firstChild, child);
          child.remove();
          continue;
        }
        // strip event handlers / unknown attrs
        const allowed = ALLOWED_ATTR[tag] || new Set();
        const attrs = Array.from(child.attributes || []);
        for (const attr of attrs) {
          const name = attr.name.toLowerCase();
          if (name.startsWith('on') || name === 'style') {
            child.removeAttribute(attr.name);
            continue;
          }
          if (!allowed.has(name)) {
            child.removeAttribute(attr.name);
            continue;
          }
          if (name === 'href' && !isSafeUrl(attr.value)) {
            child.removeAttribute(attr.name);
          }
        }
        if (tag === 'a') {
          child.setAttribute('rel', 'noopener noreferrer');
          child.setAttribute('target', '_blank');
        }
        walk(child);
      }
    };
    walk(tpl.content);
    return tpl.innerHTML;
  }

  function renderSafeMarkdown(raw, opts) {
    const streaming = opts && opts.streaming;
    const text = stripHtmlFromMarkdown(raw);
    if (!text.trim()) return '';
    try {
      if (typeof marked !== 'undefined') {
        if (marked.setOptions) {
          marked.setOptions({
            breaks: true,
            gfm: true,
            headerIds: false,
            mangle: false,
          });
        }
        // Prefer marked's built-in escape of HTML when available
        const html =
          typeof marked.parse === 'function'
            ? marked.parse(text, { async: false })
            : marked(text);
        return sanitizeHtml(html);
      }
    } catch (e) {
      console.warn('safe markdown failed', e);
    }
    return '<pre class="md-plain">' + escapeHtml(text) + '</pre>';
  }

  global.renderSafeMarkdown = renderSafeMarkdown;
  global.sanitizeHtml = sanitizeHtml;
  global.stripHtmlFromMarkdown = stripHtmlFromMarkdown;
})(typeof window !== 'undefined' ? window : globalThis);
