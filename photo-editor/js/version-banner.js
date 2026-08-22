// photo-editor/js/version-banner.js — build stamp logged to the console.
// Was an inline <script>; moved out so the CSP needs no script hash.
// Nothing reads these globals, they exist for eyeballing a deploy.
window.__NOADSTOOLS_VERSION__ = 'v1.2.10';
window.__NOADSTOOLS_BUILD__ = window.__NOADSTOOLS_VERSION__ + ' — 2026-07-01';
console.log('%c[NoAdsTools build] ' + window.__NOADSTOOLS_BUILD__, 'color:#4a9; font-weight:600;');
