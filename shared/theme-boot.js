// shared/theme-boot.js — applies the stored theme BEFORE first paint.
//
// Loaded as a plain blocking <script src> in <head>: no defer, no async, no
// type="module". All three of those would postpone it past first paint, which
// is the whole problem it exists to solve. The chrome boots from a module
// script, so without this a user who chose light mode sees a flash of the
// browser's dark default on every cold load.
//
// Why a separate file rather than an inline snippet: the CSP would then need a
// 'sha256-...' hash of the exact script bytes, and those bytes are not stable.
// Git rewrites line endings on checkout, and the published mirror is a second
// repo that can normalise differently again, so the same source produced three
// different hashes across this tree. A stale hash fails silently in production
// while passing locally. An external file needs only 'self'.
//
// Kept in sync with applyThemeFromState() in shared/settings.js.
(function () {
  try {
    var raw = localStorage.getItem('noadstools:settings:global');
    if (!raw) return;
    var theme = JSON.parse(raw).theme;
    // Allowlist: never write an arbitrary stored string into the DOM.
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.setAttribute('data-theme', theme);
    }
  } catch (e) { /* corrupt or unavailable storage: fall back to auto */ }
})();
