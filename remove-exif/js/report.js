// remove-exif/js/report.js — extract the human-readable "what we found" report.
// Pure bytes -> { format, found:[], gps, make, model, software, dateTime }.
// Only the report fields are decoded (Make 0x010F, Model 0x0110, Software
// 0x0131, DateTime 0x0132, DateTimeOriginal 0x9003 via ExifIFD 0x8769, GPS
// presence via 0x8825). Not a general EXIF viewer — that's a future tool.

export function buildReport(bytes) {
  const rep = { format: 'unknown', found: [], gps: false, make: null, model: null, software: null, dateTime: null };
  if (bytes.length < 12) return rep;
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return jpegReport(bytes, rep);
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return pngReport(bytes, rep);
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return webpReport(bytes, rep);
  return rep;
}

function ascii(bytes, off, len) {
  let s = '';
  for (let i = off; i < off + len && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function jpegReport(bytes, rep) {
  rep.format = 'jpeg';
  let i = 2;
  while (i + 4 <= bytes.length && bytes[i] === 0xFF) {
    const marker = bytes[i + 1];
    if (marker === 0xDA || marker === 0xD9) break;
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2) break;
    const dataOff = i + 4, dataLen = len - 2;
    if (marker === 0xE1) {
      if (ascii(bytes, dataOff, 6) === 'Exif\0\0') {
        if (!rep.found.includes('EXIF')) rep.found.push('EXIF');
        parseTiff(bytes.subarray(dataOff + 6, dataOff + dataLen), rep);
      } else if (ascii(bytes, dataOff, 28) === 'http://ns.adobe.com/xap/1.0/') {
        if (!rep.found.includes('XMP')) rep.found.push('XMP');
      }
    } else if (marker === 0xED) {
      if (!rep.found.includes('IPTC')) rep.found.push('IPTC');
    } else if (marker === 0xFE) {
      if (!rep.found.includes('Comment')) rep.found.push('Comment');
    }
    i += 2 + len;
  }
  return rep;
}

function pngReport(bytes, rep) {
  rep.format = 'png';
  const META = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);
  let i = 8;
  while (i + 8 <= bytes.length) {
    const len = (bytes[i] << 24 | bytes[i + 1] << 16 | bytes[i + 2] << 8 | bytes[i + 3]) >>> 0;
    const type = ascii(bytes, i + 4, 4);
    if (META.has(type) && !rep.found.includes(type)) rep.found.push(type);
    if (type === 'eXIf') parseTiff(bytes.subarray(i + 8, i + 8 + len), rep);
    if (type === 'IEND') break;
    i += 8 + len + 4;
  }
  return rep;
}

function webpReport(bytes, rep) {
  rep.format = 'webp';
  let i = 12;
  while (i + 8 <= bytes.length) {
    const fourcc = ascii(bytes, i, 4);
    const len = (bytes[i + 4] | bytes[i + 5] << 8 | bytes[i + 6] << 16 | bytes[i + 7] << 24) >>> 0;
    if (fourcc === 'EXIF') {
      if (!rep.found.includes('EXIF')) rep.found.push('EXIF');
      parseTiff(bytes.subarray(i + 8, i + 8 + len), rep);
    }
    if (fourcc === 'XMP ' && !rep.found.includes('XMP')) rep.found.push('XMP');
    i += 8 + len + (len % 2);
  }
  return rep;
}

// Minimal TIFF/IFD reader for the report fields only.
function parseTiff(t, rep) {
  try {
    const le = ascii(t, 0, 2) === 'II';
    const u16 = (o) => le ? (t[o] | t[o + 1] << 8) : (t[o] << 8 | t[o + 1]);
    const u32 = (o) => (le ? (t[o] | t[o + 1] << 8 | t[o + 2] << 16 | t[o + 3] << 24) : (t[o] << 24 | t[o + 1] << 16 | t[o + 2] << 8 | t[o + 3])) >>> 0;
    if (u16(2) !== 0x2A) return;
    const str = (off, count) => {
      let s = '';
      for (let k = 0; k < count && off + k < t.length; k++) { const c = t[off + k]; if (c === 0) break; s += String.fromCharCode(c); }
      return s;
    };
    // sizeOf only needs to be correct for the types we actually decode
    // (ASCII=2, LONG=4); the other entries exist so the inline/offset rule
    // below doesn't misfire on tags we skip. Do not "fix" or extend it.
    const sizeOf = (type) => ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }[type] || 1);
    // An IFD entry is tag(2) type(2) count(4) value(4). The value field holds
    // the data inline when sizeOf(type)*count <= 4, else an offset (from TIFF
    // start) to the data. `valOff` below is always an offset INTO `t` where
    // the value bytes live, whichever case applies.
    const readIfd = (ifdOff, into) => {
      if (ifdOff + 2 > t.length) return;
      const n = u16(ifdOff);
      for (let e = 0; e < n; e++) {
        const o = ifdOff + 2 + e * 12;
        if (o + 12 > t.length) return;
        const tag = u16(o), type = u16(o + 2), count = u32(o + 4);
        const valOff = sizeOf(type) * count <= 4 ? o + 8 : u32(o + 8);
        into(tag, type, count, valOff);
      }
    };
    let exifIfdOff = 0, dateTime = null, dateTimeOriginal = null;
    readIfd(u32(4), (tag, type, count, valOff) => {
      if (tag === 0x010F && type === 2) rep.make = rep.make ?? str(valOff, count);
      if (tag === 0x0110 && type === 2) rep.model = rep.model ?? str(valOff, count);
      if (tag === 0x0131 && type === 2) rep.software = rep.software ?? str(valOff, count);
      if (tag === 0x0132 && type === 2) dateTime = str(valOff, count);
      if (tag === 0x8769 && type === 4 && count === 1) exifIfdOff = u32(valOff); // ExifIFD pointer (LONG, inline)
      if (tag === 0x8825) rep.gps = true;
    });
    if (exifIfdOff) readIfd(exifIfdOff, (tag, type, count, valOff) => {
      if (tag === 0x9003 && type === 2) dateTimeOriginal = str(valOff, count);
    });
    rep.dateTime = rep.dateTime ?? (dateTimeOriginal || dateTime);
  } catch { /* report stays partial — never throw */ }
}
