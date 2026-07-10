// color-palette-from-image/js/color.js — PURE color math + formatters. No DOM.
// The values (hex/RGB/HSL) are the accessible representation of every swatch
// (Dan is colorblind): a color block is never the only signal, so these
// conversions and the copy formatters are the heart of the tool's a11y story.

/** [r,g,b] (0–255 ints) → lowercase '#rrggbb', zero-padded per channel. */
export function rgbToHex([r, g, b]) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** [r,g,b] (0–255) → [h,s,l] with h 0–360, s/l 0–100, all rounded. */
export function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0, s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r: h = ((g - b) / d) % 6; break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

/** WCAG relative luminance 0–1 (sRGB): 0 for black, 1 for white. */
export function luminance([r, g, b]) {
  const lin = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Contrast-safe label color for text drawn ON a swatch. Picks black or white by
 * whichever gives the HIGHER WCAG contrast ratio against the swatch color — not
 * a luminance>0.5 guess, which mis-picks white on mid-tones (e.g. a mid green
 * gets ~3.95:1 white but ~5.3:1 black). Choosing the better of the two always
 * clears AA (≥4.58:1 even at the worst-case crossover luminance). Colorblind-
 * critical: the hex TEXT on every swatch must stay legible on any color.
 */
export function labelOn(rgb) {
  const L = luminance(rgb);
  const contrastWhite = 1.05 / (L + 0.05);
  const contrastBlack = (L + 0.05) / 0.05;
  return contrastBlack >= contrastWhite ? '#000000' : '#ffffff';
}

/** Colors → 'comma, space' joined hex list, e.g. '#1a2b3c, #ffffff'. */
export function hexList(colors) {
  return colors.map(rgbToHex).join(', ');
}

/** Colors → a :root{ --color-N: #..; } block (one variable per color). */
export function cssVars(colors) {
  const lines = colors.map((c, i) => `  --color-${i + 1}: ${rgbToHex(c)};`);
  return `:root {\n${lines.join('\n')}\n}`;
}

/** Colors → pretty JSON array of { hex, rgb, hsl }. */
export function toJson(colors) {
  const out = colors.map((c) => ({
    hex: rgbToHex(c),
    rgb: [c[0], c[1], c[2]],
    hsl: rgbToHsl(c),
  }));
  return JSON.stringify(out, null, 2);
}
