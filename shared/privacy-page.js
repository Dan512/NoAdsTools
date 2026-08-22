// shared/privacy-page.js — theme toggle for the standalone /privacy page.
// Extracted from an inline <script> so the CSP can stay hash-based with a
// single allowed inline snippet (the pre-paint theme setter in <head>).
/* Theme toggle. Mirrors bindThemeToggle() + applyThemeButtonIcon() in
   shared/settings.js, writing the same GLOBAL_KEY so the choice round-trips
   with the rest of the site. Inline rather than importing settings.js
   because that module also mounts a settings popover this page has no
   controls for. Read-modify-write: never clobber the other global keys. */
(function () {
  var KEY = 'noadstools:settings:global';
  var btn = document.getElementById('theme-toggle');
  if (!btn) return;

  function readGlobal() {
    try {
      var o = JSON.parse(localStorage.getItem(KEY) || '{}');
      return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
    } catch (e) { return {}; }
  }

  // The user can hide the theme button site-wide in settings.
  if (readGlobal().showThemeButton === false) { btn.hidden = true; return; }

  function displayed() {
    var attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'light' || attr === 'dark') return attr;
    try {
      if (window.matchMedia
          && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    } catch (e) { /* ignore */ }
    return 'light';
  }

  function paintIcon() { btn.textContent = displayed() === 'dark' ? '🌙' : '☀️'; }
  paintIcon();

  btn.addEventListener('click', function () {
    var next = displayed() === 'dark' ? 'light' : 'dark';
    var g = readGlobal();
    g.theme = next;
    try { localStorage.setItem(KEY, JSON.stringify(g)); } catch (e) { /* ignore */ }
    document.documentElement.setAttribute('data-theme', next);
    paintIcon();
  });

  // Keep the icon honest while the stored choice is "auto".
  try {
    var mql = window.matchMedia('(prefers-color-scheme: dark)');
    if (mql.addEventListener) mql.addEventListener('change', paintIcon);
    else if (mql.addListener) mql.addListener(paintIcon);
  } catch (e) { /* older browsers */ }
})();
