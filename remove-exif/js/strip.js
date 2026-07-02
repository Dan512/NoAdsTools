// remove-exif/js/strip.js — surgical, lossless metadata removal (pure bytes).
//
// Philosophy: DROP-LIST, copy everything else verbatim. Image payload bytes are
// never touched, so output pixels are byte-identical to input. Formats: JPEG,
// PNG, WebP. HEIC is detected and refused (the heic-to-jpg tool is the answer).
// Anything else -> { ok:false, reason:'unrecognized' } and the caller may fall
// back to canvas re-encode (lossy; labeled honestly in the UI).
//
// Drop lists (everything not listed is kept — incl. ICC profiles (APP2/iCCP),
// JFIF (APP0), Adobe color transform (APP14), and all PNG rendering chunks):
//   JPEG: APP1 (Exif + XMP), APP13 (IPTC/Photoshop), COM
//   PNG:  eXIf, tEXt, zTXt, iTXt, tIME
//   WebP: EXIF, 'XMP ' chunks (+ clear the VP8X EXIF/XMP flag bits, fix RIFF size)

const JPEG_DROP = new Set([0xE1, 0xED, 0xFE]); // APP1, APP13, COM (marker low byte)
const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);
const WEBP_DROP = new Set(['EXIF', 'XMP ']);

export function stripImage(bytes) {
  if (bytes.length >= 12) {
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) return stripJpeg(bytes);
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return stripPng(bytes);
    if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return stripWebp(bytes);
    if (ascii(bytes, 4, 4) === 'ftyp') {
      const brand = ascii(bytes, 8, 4);
      if (/^(heic|heix|hevc|heim|heis|hevm|hevs|mif1|msf1)$/.test(brand)) return { ok: false, reason: 'heic' };
    }
  }
  return { ok: false, reason: 'unrecognized' };
}

function ascii(bytes, off, len) {
  let s = '';
  for (let i = off; i < off + len && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function stripJpeg(bytes) {
  const out = [bytes.subarray(0, 2)]; // SOI
  let i = 2;
  let trailing = 0;
  try {
    while (i < bytes.length) {
      // The JPEG standard permits 0xFF fill bytes before any marker. Skip
      // them exactly like the shared/exif.js oracle does; fill bytes are
      // padding and are NOT copied to the output.
      while (bytes[i] === 0xFF && bytes[i + 1] === 0xFF) i++;
      if (bytes[i] !== 0xFF) return { ok: false, reason: 'parse-error' };
      const marker = bytes[i + 1];
      if (marker === 0xDA) { // SOS: keep header + scan data through EOI, verbatim
        // Scan forward for the EOI marker (FF D9). Safe inside entropy-coded
        // data: literal 0xFF bytes are stuffed as FF 00 and restart markers
        // are FF D0..D7, so a raw FF D9 is the real end of image. (Inter-scan
        // marker segments in progressive JPEGs are DHT/DNL/SOS — none is D9;
        // an APPn/COM between scans could in theory contain FF D9, but no
        // real encoder emits those, and the failure mode would be early
        // truncation, not corruption.) Anything
        // after EOI (Samsung/Google "motion photo" video trailers — which
        // carry their own GPS) is DROPPED and counted in `trailing`. If no
        // EOI is found (truncated file), copy to the end with trailing 0.
        let end = bytes.length;
        for (let j = i + 2; j + 1 < bytes.length; j++) {
          if (bytes[j] === 0xFF && bytes[j + 1] === 0xD9) { end = j + 2; break; }
        }
        trailing = bytes.length - end;
        out.push(bytes.subarray(i, end));
        return { ok: true, format: 'jpeg', bytes: concat(out), trailing };
      }
      if (marker === 0xD9) { // EOI before SOS (degenerate): keep EOI, drop + count any trailer
        out.push(bytes.subarray(i, i + 2));
        trailing = bytes.length - (i + 2);
        break;
      }
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (len < 2 || i + 2 + len > bytes.length) return { ok: false, reason: 'parse-error' };
      if (!JPEG_DROP.has(marker)) out.push(bytes.subarray(i, i + 2 + len));
      i += 2 + len;
    }
    return { ok: true, format: 'jpeg', bytes: concat(out), trailing };
  } catch { return { ok: false, reason: 'parse-error' }; }
}

function stripPng(bytes) {
  const out = [bytes.subarray(0, 8)]; // signature
  let i = 8;
  let trailing = 0;
  try {
    while (i + 8 <= bytes.length) {
      const len = (bytes[i] << 24 | bytes[i + 1] << 16 | bytes[i + 2] << 8 | bytes[i + 3]) >>> 0;
      const type = ascii(bytes, i + 4, 4);
      const total = 8 + len + 4; // len+type+data+crc (CRC copied verbatim, never recomputed)
      if (i + total > bytes.length) return { ok: false, reason: 'parse-error' };
      if (!PNG_DROP.has(type)) out.push(bytes.subarray(i, i + total));
      i += total;
      if (type === 'IEND') { trailing = bytes.length - i; break; } // post-IEND trailer: dropped + counted
    }
    // Truncated-tail behavior: a chunk whose declared length overruns the
    // buffer is a parse-error above; a buffer that simply ends after a
    // complete chunk (no IEND) passes through as a valid prefix — intentional.
    return { ok: true, format: 'png', bytes: concat(out), trailing };
  } catch { return { ok: false, reason: 'parse-error' }; }
}

function stripWebp(bytes) {
  try {
    const chunks = [];
    let i = 12;
    while (i + 8 <= bytes.length) {
      const fourcc = ascii(bytes, i, 4);
      const len = (bytes[i + 4] | bytes[i + 5] << 8 | bytes[i + 6] << 16 | bytes[i + 7] << 24) >>> 0;
      const padded = len + (len % 2); // chunks are even-padded
      if (i + 8 + padded > bytes.length) return { ok: false, reason: 'parse-error' };
      if (!WEBP_DROP.has(fourcc)) {
        const chunk = bytes.slice(i, i + 8 + padded); // slice (copy) — we may mutate VP8X flags
        if (fourcc === 'VP8X' && chunk.length >= 9) chunk[8] &= ~0x0C; // clear EXIF(0x08)|XMP(0x04)
        chunks.push(chunk);
      }
      i += 8 + padded;
    }
    const bodyLen = 4 + chunks.reduce((n, c) => n + c.length, 0); // 'WEBP' + chunks
    const head = new Uint8Array(12);
    head.set([0x52, 0x49, 0x46, 0x46]); // RIFF
    head[4] = bodyLen & 0xFF; head[5] = bodyLen >>> 8 & 0xFF; head[6] = bodyLen >>> 16 & 0xFF; head[7] = bodyLen >>> 24 & 0xFF;
    head.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
    // End-of-buffer behavior: the walker stops when fewer than 8 bytes remain
    // (a dangling partial chunk header is not copied); a chunk whose declared
    // length overruns the buffer is a parse-error. Valid-prefix pass-through
    // is intentional. Post-container trailers (motion photos) are a JPEG
    // phenomenon, so nothing is counted as trailing here.
    return { ok: true, format: 'webp', bytes: concat([head, ...chunks]), trailing: 0 };
  } catch { return { ok: false, reason: 'parse-error' }; }
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
