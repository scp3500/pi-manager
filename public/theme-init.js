(function () {
  try {
    var t = localStorage.getItem('pi-manager-theme');
    var ok = {
      default: 1, midnight: 1, aurora: 1, orchid: 1, amber: 1, miku: 1,
      light: 1, paper: 1, rose: 1, 'miku-light': 1
    };
    if (ok[t]) document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
})();
