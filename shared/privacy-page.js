// shared/privacy-page.js — theme toggle + the visit-counter opt-out for the
// standalone /privacy page.
// Extracted from an inline <script> so the CSP can stay hash-based with a
// single allowed inline snippet (the pre-paint theme setter in <head>).
import { readOptOut, setOptOut } from './tally.js';
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

/* The visit-counter opt-out.

   It lives here rather than in the shared settings popover because the popover
   is deliberately absent from every tool page (each tool's spec asserts
   #settings-toggle has count 0), and /privacy is the one page the whole site
   links to. It is also the honest place for it: the control sits inside the
   paragraphs that explain what it turns off.

   The block starts hidden and is only revealed once this runs, so a reader
   without JavaScript is never shown a checkbox that could not save anything —
   the <noscript> paragraph next to it explains that nothing is counted in that
   case anyway. State is carried by WORDS in the status line and a bar on the
   block, never by colour alone. */
(function () {
  var box = document.getElementById('tally-optout');
  var input = document.getElementById('tally-optout-input');
  var status = document.getElementById('tally-optout-status');
  if (!box || !input || !status) return;

  var store = null;
  try { store = window.localStorage; } catch (e) { /* blocked */ }

  function paint(state) {
    if (!state.available) {
      input.checked = true;
      input.disabled = true;
      box.classList.add('is-unavailable');
      status.innerHTML = '<strong>This browser is blocking site storage</strong>, '
        + 'so a choice cannot be saved here. Visits from it still count as views, '
        + 'and never as unique visitors. A content blocker will stop the request itself.';
      return;
    }
    input.checked = !state.skipped;
    box.classList.toggle('is-off', state.skipped);
    status.innerHTML = state.skipped
      ? 'Counting is <strong>off</strong> in this browser. Nothing is sent from here, '
        + 'and the dates the counter had stored have been deleted.'
      : 'Counting is <strong>on</strong> in this browser. Each page you open here '
        + 'sends the message above, once per half hour.';
  }

  paint(readOptOut(store));

  input.addEventListener('change', function () {
    var wanted = !input.checked; // checked means "count me"
    if (!setOptOut(store, wanted)) {
      paint({ available: false, skipped: false });
      return;
    }
    paint(readOptOut(store));
  });

  box.hidden = false;
})();
