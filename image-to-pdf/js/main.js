// image-to-pdf/js/main.js — boot + tool wiring. English-first; minimal chrome
// (no language picker / settings gear); shared privacy panel with this tool's
// disclosure. Flow: files -> ordered rows (thumb + Move up/down/Remove) ->
// page-size select -> Create PDF (jsPDF lazy-loaded on click) -> download.
// JPEG bytes are embedded unmodified (no re-encode) — EXCEPT JPEGs whose EXIF
// Orientation ≠ 1, which are rotated + re-encoded (PDF viewers ignore EXIF
// inside embedded images; the row says so); PNG embeds as PNG; WebP is
// re-encoded to JPEG 0.92 (the row says so); HEIC gets a refusal row that
// points at /heic-to-jpg/.
import { registerTranslations, initI18n } from '/shared/i18n.js';
import { injectTopbar } from '/shared/topbar.js';
import { injectFooter } from '/shared/footer.js';
import { initSettings } from '/shared/settings.js';
import { registerPrivacyRows, initPrivacy } from '/shared/privacy.js';
import { escapeHtml } from '/shared/escape.js';
import { loadJsPdf } from './pdf-loader.js';
import { jpegOrientation } from './jpeg-orientation.js';

registerTranslations({ en: {
  brandName: 'NoAdsTools', toolsMenu: 'Tools', allTools: 'All tools',
  themeToggle: 'Toggle theme', tip: 'Support this site', tipShort: 'Support',
  privacy: 'Privacy', source: 'Source', tipFooter: 'Support this site', close: 'Close',
  ipPrivacyTitle: 'Privacy',
  ipPrivacyLead: 'This tool combines your images into a PDF entirely in your browser. Your images never leave your device — no upload, no account, no tracking.',
  ipPrivacyFetchHeading: 'What this page loads',
  ipPrivacyFetchList: '<li>HTML, CSS, and JavaScript from this site only — no third-party CDN.</li><li>The jsPDF library (~420 KB, from this origin) — ONLY when you click "Create PDF". Used to assemble the PDF locally.</li>',
  ipPrivacyStorageHeading: 'Local storage',
  ipPrivacyStorageBody: 'Theme and chrome preferences only: <code>noadstools:settings:global</code> and <code>noadstools:settings:image-to-pdf</code>. No image data is ever stored.',
} });

injectTopbar({ toolId: 'image-to-pdf', lang: false, settings: false });
injectFooter({ toolId: 'image-to-pdf' });
initI18n();
initSettings({ toolId: 'image-to-pdf' });
registerPrivacyRows([
  { headingKey: 'ipPrivacyFetchHeading', bodyKey: 'ipPrivacyFetchList', kind: 'list' },
  { headingKey: 'ipPrivacyStorageHeading', bodyKey: 'ipPrivacyStorageBody', kind: 'text' },
]);
initPrivacy({ titleKey: 'ipPrivacyTitle', leadKey: 'ipPrivacyLead' });

// Named page sizes in PDF points (1 pt = 1/72 in). Fit-to-image is handled in
// code (px-unit page at the image's own dimensions).
const PAGE_PT = Object.freeze({
  a4:     { w: 595, h: 842 },  // 210 × 297 mm
  letter: { w: 612, h: 792 },  // 8.5 × 11 in
});
const PAGE_MARGIN_PT = 36;     // half inch on named sizes
const REENCODE_JPEG_QUALITY = 0.92;
const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heif', 'mif1', 'msf1'];

// Ordered list of rows. Ok rows: { id, name, kind, rotated, bytes, width,
// height, thumbUrl } — width/height are the EXIF-rotation-baked dims.
// Error rows: { id, name, error: 'heic'|'unsupported'|'unreadable' }.
let items = [];
let nextId = 1;

const dropzone = document.getElementById('dropzone');
const input = document.getElementById('file-input');
const builder = document.getElementById('builder');
const list = document.getElementById('page-list');
const sizeSelect = document.getElementById('page-size');
const createBtn = document.getElementById('create-pdf');
const pdfError = document.getElementById('pdf-error');

input.addEventListener('change', () => { handleFiles([...input.files]); input.value = ''; });
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('is-drag'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-drag'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault(); dropzone.classList.remove('is-drag');
  handleFiles([...e.dataTransfer.files]);
});
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) handleFiles(files);
});
// A drop that misses the dropzone must not navigate the tab away (which
// would destroy the assembled list). Swallow it at the document level.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

async function handleFiles(files) {
  for (const file of files) await addFile(file);
  render();
}

// Sniff the container from magic bytes; the filename/MIME is only a fallback
// for HEIC (so a mislabeled file can't dodge the refusal row).
function sniff(bytes, file) {
  if (bytes.length >= 12) {
    const tag = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (tag === 'ftyp' && HEIC_BRANDS.includes(brand)) return 'heic';
  }
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 12
      && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === 'RIFF'
      && String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === 'WEBP') return 'webp';
  if (/\.hei[cf]$/i.test(file.name) || /image\/hei[cf]/.test(file.type)) return 'heic';
  return null;
}

async function addFile(file) {
  const id = nextId++;
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    items.push({ id, name: file.name, error: 'unreadable' });
    return;
  }
  const kind = sniff(bytes, file);
  if (kind === 'heic' || kind === null) {
    items.push({ id, name: file.name, error: kind === 'heic' ? 'heic' : 'unsupported' });
    return;
  }
  try {
    // createImageBitmap bakes EXIF rotation into the bitmap (and therefore
    // into these dims + the thumbnail). A rotation-tagged JPEG can't use the
    // byte-passthrough — PDF viewers ignore EXIF inside embedded JPEGs and
    // the page would come out sideways — so it takes the re-encode path.
    const rotated = kind === 'jpeg' && jpegOrientation(bytes) !== 1;
    const bmp = await createImageBitmap(new Blob([bytes]));
    const thumbUrl = makeThumb(bmp);
    items.push({ id, name: file.name, kind, rotated, bytes, width: bmp.width, height: bmp.height, thumbUrl });
    bmp.close();
  } catch {
    items.push({ id, name: file.name, error: 'unreadable' });
  }
}

// Small data-URL thumbnail (≤ 96 px on the long side) — no object-URL
// lifecycle to manage, and the full bitmap is released right after.
function makeThumb(bmp) {
  const scale = Math.min(1, 96 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * scale));
  c.height = Math.max(1, Math.round(bmp.height * scale));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

function noteFor(it) {
  if (it.kind === 'jpeg') {
    return it.rotated
      ? 'JPEG — rotated + re-encoded (92% quality)'
      : 'JPEG — embedded without re-encoding';
  }
  if (it.kind === 'png') return 'PNG — embedded losslessly';
  return 'WebP — will be re-encoded as JPEG (92% quality)';
}
const ERROR_HTML = {
  heic: 'HEIC needs converting first — use our free <a href="/heic-to-jpg/">HEIC to JPG</a> tool, then add the JPG here.',
  unsupported: "This file isn't a supported image (JPG, PNG, WebP).",
  unreadable: "This image couldn't be read.",
};

// Re-render the whole list from state. focusSpec {id, act} restores keyboard
// focus after a Move re-render so keyboard users don't lose their place.
function render(focusSpec) {
  list.innerHTML = items.map((it, i) => {
    const name = escapeHtml(it.name);
    if (it.error) {
      return `<li class="pdf-row" data-id="${it.id}">
        <div class="result-error"><strong>${name}</strong> — ${ERROR_HTML[it.error]}</div>
        <div class="row-controls">
          <button type="button" data-act="remove" aria-label="Remove ${name}">✕ Remove</button>
        </div></li>`;
    }
    return `<li class="pdf-row" data-id="${it.id}">
      <img class="row-thumb" alt="" src="${it.thumbUrl}">
      <div class="row-body">
        <div class="row-name">${name}</div>
        <div class="row-meta">${it.width} × ${it.height} · ${noteFor(it)}</div>
      </div>
      <div class="row-controls">
        <button type="button" data-act="up" aria-label="Move ${name} up"${i === 0 ? ' disabled' : ''}>↑ Up</button>
        <button type="button" data-act="down" aria-label="Move ${name} down"${i === items.length - 1 ? ' disabled' : ''}>↓ Down</button>
        <button type="button" data-act="remove" aria-label="Remove ${name}">✕ Remove</button>
      </div></li>`;
  }).join('');
  builder.hidden = items.length === 0;
  createBtn.disabled = !items.some((it) => !it.error);
  if (focusSpec) {
    const row = list.querySelector(`li[data-id="${focusSpec.id}"]`);
    const btn = row?.querySelector(`button[data-act="${focusSpec.act}"]`);
    if (btn && !btn.disabled) btn.focus();
    else row?.querySelector('button:not([disabled])')?.focus();
  }
}

list.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const li = btn.closest('li[data-id]');
  const idx = items.findIndex((it) => it.id === Number(li.dataset.id));
  if (idx < 0) return;
  const act = btn.dataset.act;
  if (act === 'up' && idx > 0) {
    [items[idx - 1], items[idx]] = [items[idx], items[idx - 1]];
    render({ id: items[idx - 1].id, act: 'up' });
  } else if (act === 'down' && idx < items.length - 1) {
    [items[idx], items[idx + 1]] = [items[idx + 1], items[idx]];
    render({ id: items[idx + 1].id, act: 'down' });
  } else if (act === 'remove') {
    items.splice(idx, 1);
    render();
  }
});

document.getElementById('clear-all').addEventListener('click', () => {
  items = [];
  pdfError.hidden = true;
  render();
});

// Page math. Fit-to-image: the page IS the image (px unit, image edge-to-edge).
// A4/Letter: pt unit, page orientation follows the image aspect, image centered
// inside the 36 pt margin and never upscaled past natural size (1 px = 1 pt).
function layoutFor(pageSize, imgW, imgH) {
  if (!PAGE_PT[pageSize]) {
    return { unit: 'px', pageW: imgW, pageH: imgH, x: 0, y: 0, w: imgW, h: imgH };
  }
  const base = PAGE_PT[pageSize];
  const landscape = imgW > imgH;
  const pageW = landscape ? Math.max(base.w, base.h) : Math.min(base.w, base.h);
  const pageH = landscape ? Math.min(base.w, base.h) : Math.max(base.w, base.h);
  const innerW = pageW - 2 * PAGE_MARGIN_PT;
  const innerH = pageH - 2 * PAGE_MARGIN_PT;
  const scale = Math.min(innerW / imgW, innerH / imgH, 1);
  const w = imgW * scale;
  const h = imgH * scale;
  return { unit: 'pt', pageW, pageH, x: (pageW - w) / 2, y: (pageH - h) / 2, w, h };
}

// Canvas re-encode path — used for WebP (PDFs can't hold WebP) and for
// rotation-tagged JPEGs (createImageBitmap bakes the EXIF rotation in).
// White background: JPEG has no alpha, and white matches the page.
async function reencodeToJpeg(bytes) {
  const bmp = await createImageBitmap(new Blob([bytes]));
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', REENCODE_JPEG_QUALITY));
  if (!blob) throw new Error('re-encode failed');
  return new Uint8Array(await blob.arrayBuffer());
}

createBtn.addEventListener('click', async () => {
  const pages = items.filter((it) => !it.error);
  if (!pages.length) return;
  const label = createBtn.textContent;
  createBtn.disabled = true;
  createBtn.textContent = 'Creating…';
  pdfError.hidden = true;
  try {
    // Honest failure beats silence — and the two failure modes deserve
    // different advice, so they're caught separately.
    let jsPDF;
    try {
      jsPDF = await loadJsPdf();
    } catch {
      // pdf-loader resets its cache on rejection, so clicking again retries.
      pdfError.textContent = "Couldn't load the PDF builder — check your connection and try again.";
      pdfError.hidden = false;
      return;
    }
    try {
      const pageSize = sizeSelect.value;
      let pdf = null;
      for (const it of pages) {
        const p = layoutFor(pageSize, it.width, it.height);
        const orientation = p.pageW > p.pageH ? 'landscape' : 'portrait';
        if (!pdf) {
          // Unit is fixed per document; the page-size mode applies to every page,
          // so 'fit' documents are px throughout and A4/Letter pt throughout.
          // px_scaling: the modern px mapping (96 dpi) instead of jsPDF's legacy
          // back-compat scale.
          pdf = new jsPDF({
            unit: p.unit, format: [p.pageW, p.pageH], orientation,
            compress: true, hotfixes: ['px_scaling'],
          });
        } else {
          pdf.addPage([p.pageW, p.pageH], orientation);
        }
        // JPEG passthrough: the original bytes go in unmodified — unless the
        // EXIF said "rotate me", in which case the canvas path bakes the
        // rotation in. PNG embeds as PNG (jsPDF flattens transparency onto
        // the page). WebP always re-encodes.
        const reencode = it.kind === 'webp' || (it.kind === 'jpeg' && it.rotated);
        const data = reencode ? await reencodeToJpeg(it.bytes) : it.bytes;
        const fmt = it.kind === 'png' ? 'PNG' : 'JPEG';
        // Explicit per-row alias: jsPDF's auto-alias hashes only HALF the
        // image bytes (sHashCode), and two same-camera/same-encoder images
        // can collide — silently reusing page 1's picture on page 2. Unique
        // aliases make wrong-image reuse impossible (duplicate files simply
        // embed twice, which is benign).
        pdf.addImage(data, fmt, p.x, p.y, p.w, p.h, `row-${it.id}`);
      }
      const url = URL.createObjectURL(pdf.output('blob'));
      const a = document.createElement('a');
      a.href = url; a.download = 'noadstools-images.pdf';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      pdfError.textContent = "Couldn't build the PDF from these images — try removing the last-added file.";
      pdfError.hidden = false;
    }
  } finally {
    createBtn.textContent = label;
    createBtn.disabled = !items.some((it) => !it.error);
  }
});

document.documentElement.dataset.bootReady = '1';
