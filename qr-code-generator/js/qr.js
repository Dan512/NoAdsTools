// qr-code-generator/js/qr.js — pure helpers, no DOM. Node-tested.
//
// buildWifiPayload: the de-facto WIFI: payload format (as read by iOS and
// Android camera apps): WIFI:T:<WPA|WEP|nopass>;S:<ssid>;P:<password>;H:true;;
// The characters \ ; , " : are escaped with a backslash in SSID and password.
//
// renderToSvg: turns a qrcodegen QrCode (anything with .size + .getModule)
// into an SVG string. Only module geometry goes into the SVG — the encoded
// payload text is never embedded, so user input has no HTML/SVG injection
// surface here.

// Escape the five special characters of the WIFI: payload format. Backslash
// first (it is the escape character itself).
function escapeWifi(s) {
  return String(s).replace(/([\\;,":])/g, '\\$1');
}

/**
 * Build a WIFI: QR payload string.
 * @param {{ssid: string, password?: string, encryption?: string, hidden?: boolean}} opts
 *   encryption: 'WPA' (covers WPA/WPA2/WPA3-personal), 'WEP', or 'None'.
 * @returns {string|null} payload, or null when ssid is empty.
 */
export function buildWifiPayload({ ssid, password = '', encryption = 'WPA', hidden = false } = {}) {
  if (!ssid) return null;
  const type = encryption === 'None' ? 'nopass' : encryption;
  let out = `WIFI:T:${type};S:${escapeWifi(ssid)};`;
  if (type !== 'nopass' && password) out += `P:${escapeWifi(password)};`;
  if (hidden) out += 'H:true;';
  return `${out};`;
}

/**
 * Render a QR code to an SVG string. One <path> carries every dark module;
 * coordinates are in module units, offset by the quiet zone.
 * @param {{size: number, getModule: (x: number, y: number) => boolean}} qr
 * @param {number} borderModules quiet zone width in modules (spec minimum: 4)
 * @returns {string} standalone SVG markup
 */
export function renderToSvg(qr, borderModules = 4) {
  const total = qr.size + borderModules * 2;
  const parts = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) parts.push(`M${x + borderModules},${y + borderModules}h1v1h-1z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" stroke="none">` +
    `<rect width="100%" height="100%" fill="#FFFFFF"/>` +
    `<path d="${parts.join(' ')}" fill="#000000"/>` +
    `</svg>`;
}
