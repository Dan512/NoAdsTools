// favicon-generator/js/manifest.js — PURE. Build the two text artifacts of the
// package: the site.webmanifest JSON and the paste-in HTML snippet. No DOM.
//
// A hostile site name is made inert by JSON.stringify (manifest) — it can only
// ever land as a JSON string value, never as markup. The colors are validated
// against a strict hex allowlist before they land anywhere (the snippet
// interpolates the theme color raw into an attribute value, so a non-hex value
// must never reach it — it falls back to the default instead).

const DEFAULT_NAME = 'My Site';
const DEFAULT_THEME = '#0f1410'; // matches the page/input default (shell green)
const DEFAULT_BG = '#ffffff';

// #RGB … #RRGGBBAA. Anything else (empty, undefined, or an injection attempt
// like `#fff" onload=x`) is rejected and the default is used.
const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
function validHex(value, fallback) {
  return HEX_RE.test(value) ? value : fallback;
}

/**
 * Build the site.webmanifest JSON string.
 * @param {{name?:string, shortName?:string, themeColor?:string, bgColor?:string}} opts
 * @returns {string} pretty-printed JSON (trailing newline).
 */
export function buildManifest({ name, shortName, themeColor, bgColor } = {}) {
  const displayName = (name && String(name)) || DEFAULT_NAME;
  const manifest = {
    name: displayName,
    short_name: (shortName && String(shortName)) || displayName,
    icons: [
      { src: 'favicon-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: 'favicon-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
    theme_color: validHex(themeColor, DEFAULT_THEME),
    background_color: validHex(bgColor, DEFAULT_BG),
    display: 'standalone',
  };
  return JSON.stringify(manifest, null, 2) + '\n';
}

/**
 * Build the <head> snippet the user pastes into their site.
 * @param {{themeColor?:string}} opts
 * @returns {string} newline-joined tags (trailing newline).
 */
export function buildHtmlSnippet({ themeColor } = {}) {
  const tc = validHex(themeColor, DEFAULT_THEME);
  return [
    '<link rel="icon" href="/favicon.ico" sizes="any">',
    '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">',
    '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    '<link rel="manifest" href="/site.webmanifest">',
    `<meta name="theme-color" content="${tc}">`,
  ].join('\n') + '\n';
}
