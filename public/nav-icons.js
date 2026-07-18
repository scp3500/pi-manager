/* Lucide icons + compact "更多" menu */

function refreshIcons() {
  try {
    if (typeof lucide !== 'undefined' && typeof lucide.createIcons === 'function') {
      lucide.createIcons({
        attrs: {
          'stroke-width': '1.75',
          width: '16',
          height: '16',
        },
      });
    }
  } catch (e) {
    console.warn('lucide.createIcons failed', e);
  }
}

function closeNavMore() {
  const menu = document.getElementById('nav-more-menu');
  const btn = document.getElementById('nav-more-btn');
  if (menu) {
    menu.classList.add('hidden');
    menu.style.position = '';
    menu.style.top = '';
    menu.style.left = '';
    menu.style.right = '';
    menu.style.minWidth = '';
  }
  if (btn) {
    btn.setAttribute('aria-expanded', 'false');
    btn.classList.remove('open');
  }
}

function isNavMoreOpen() {
  const menu = document.getElementById('nav-more-menu');
  return !!(menu && !menu.classList.contains('hidden'));
}

function placeNavMoreMenu() {
  const menu = document.getElementById('nav-more-menu');
  const btn = document.getElementById('nav-more-btn');
  if (!menu || !btn) return;
  const r = btn.getBoundingClientRect();
  const menuWidth = Math.max(200, r.width + 40);
  // fixed，避免被 header/tabs overflow 裁切
  menu.style.position = 'fixed';
  menu.style.top = Math.round(r.bottom + 6) + 'px';
  menu.style.minWidth = menuWidth + 'px';
  // 尽量右对齐按钮，并保证不超出视口
  let left = Math.round(r.right - menuWidth);
  left = Math.max(8, Math.min(left, window.innerWidth - menuWidth - 8));
  menu.style.left = left + 'px';
  menu.style.right = 'auto';
  menu.style.zIndex = '1000';
}

function openNavMore() {
  const menu = document.getElementById('nav-more-menu');
  const btn = document.getElementById('nav-more-btn');
  if (!menu || !btn) return;
  menu.classList.remove('hidden');
  btn.setAttribute('aria-expanded', 'true');
  btn.classList.add('open');
  placeNavMoreMenu();
  refreshIcons();
}

function toggleNavMore() {
  if (isNavMoreOpen()) closeNavMore();
  else openNavMore();
}

function bindNavMore() {
  const btn = document.getElementById('nav-more-btn');
  const menu = document.getElementById('nav-more-menu');
  const wrap = document.getElementById('nav-more');
  if (!btn || !menu || !wrap) {
    console.warn('nav-more elements missing');
    return;
  }
  if (btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleNavMore();
  });

  menu.querySelectorAll('a.nav-more-item').forEach((a) => {
    a.addEventListener('click', () => {
      setTimeout(closeNavMore, 0);
    });
  });

  // 下一帧再监听外侧点击，避免「打开当次 click」立刻关闭
  setTimeout(() => {
    document.addEventListener('click', (e) => {
      if (!isNavMoreOpen()) return;
      if (btn.contains(e.target) || menu.contains(e.target)) return;
      closeNavMore();
    });
  }, 0);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeNavMore();
  });

  window.addEventListener(
    'resize',
    () => {
      if (isNavMoreOpen()) placeNavMoreMenu();
    },
    { passive: true }
  );
  window.addEventListener(
    'scroll',
    () => {
      if (isNavMoreOpen()) placeNavMoreMenu();
    },
    true
  );
}

function bootNavIcons() {
  bindNavMore();
  refreshIcons();
  setTimeout(refreshIcons, 30);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootNavIcons);
} else {
  bootNavIcons();
}
