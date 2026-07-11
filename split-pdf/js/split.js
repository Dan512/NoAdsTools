// split-pdf/js/split.js — coordinator between the UI and the vendored pdf-lib +
// JSZip. Loads one PDF (classifying encrypted → 'locked', unreadable → 'error'),
// then builds output documents from page groups via copyPages into fresh docs
// with minimal metadata (source metadata is NOT carried). pdf-lib loads lazily
// through the shared loader, so nothing is fetched until the first PDF is added;
// JSZip loads only when the output is multiple files. PdfEngineError is shared
// across the PDF cluster — one class, one message.
import { loadPdfLib, PdfEngineError } from '/shared/pdflib-loader.js';
import { stripSourceMetadata } from '/shared/pdf-meta.js';
import { loadJSZip } from './zip.js';
export { PdfEngineError }; // re-export for main.js's single import path

// Distinguish "this PDF is encrypted" from any other load failure. The minified
// build doesn't set Error.name reliably, so identity comes from the exported
// class (instanceof), with a message-substring fallback for safety.
function isEncryptedError(err, EncryptedPDFError) {
  if (EncryptedPDFError && err instanceof EncryptedPDFError) return true;
  return /encrypted/i.test(String((err && err.message) || err || ''));
}

/**
 * Read one File into a source descriptor:
 *   { file, name, size, pageCount, status, error, bytes }
 * status: 'ok' (readable, pageCount set) | 'locked' (password-protected) |
 * 'error' (corrupt / not a real PDF). Throws PdfEngineError only if pdf-lib
 * itself can't load (an engine failure, never the file's fault). Caches
 * `bytes` so a later split never re-reads the File.
 */
export async function loadPdf(file) {
  const src = {
    file, name: file.name, size: file.size,
    pageCount: 0, status: 'ok', error: null, bytes: null,
  };

  try {
    src.bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    src.status = 'error';
    src.error = 'unreadable';
    return src;
  }

  let PDFDocument, EncryptedPDFError;
  try {
    ({ PDFDocument, EncryptedPDFError } = await loadPdfLib());
  } catch (e) {
    throw new PdfEngineError(e);
  }

  try {
    // ignoreEncryption:false → pdf-lib throws EncryptedPDFError for a
    // password-protected file instead of silently loading a broken doc.
    const doc = await PDFDocument.load(src.bytes, { ignoreEncryption: false });
    src.pageCount = doc.getPageCount();
  } catch (err) {
    if (isEncryptedError(err, EncryptedPDFError)) {
      src.status = 'locked';
      src.error = 'password-protected';
    } else {
      src.status = 'error';
      src.error = 'unreadable';
    }
  }
  return src;
}

// Build one saved PDF (Uint8Array) from an ordered list of 1-based page numbers.
// copyPages carries pages only — no source Title/Author/Subject/Keywords reach
// the output. The shared cluster helper clears the info dictionary AND deletes
// any catalog XMP (/Metadata) stream so nothing from the source survives.
// Producer is re-stamped to the library's own name by save().
async function makePdf(pdfLib, srcDoc, pageNums) {
  const { PDFDocument } = pdfLib;
  const out = await PDFDocument.create();
  const indices = pageNums.map((p) => p - 1);
  const copied = await out.copyPages(srcDoc, indices);
  copied.forEach((pg) => out.addPage(pg));
  stripSourceMetadata(out, pdfLib);
  return out.save();
}

function expand(group) {
  const [a, b] = group;
  const pages = [];
  for (let p = a; p <= b; p++) pages.push(p);
  return pages;
}

// Descriptive, stable per-group name. Ranges/burst read the actual pages
// (`<stem>-1-3.pdf`, single page `<stem>-p5.pdf`); every-N reads as ordinal
// chunks (`<stem>-part-2.pdf`) since the run boundaries are what matter there.
function nameFor(stem, group, index, naming) {
  if (naming === 'part') return `${stem}-part-${index + 1}.pdf`;
  const [a, b] = group;
  return a === b ? `${stem}-p${a}.pdf` : `${stem}-${a}-${b}.pdf`;
}

/**
 * Build ONE output PDF per group (ranges / every-N / burst).
 * @param {Uint8Array} srcBytes cached source bytes
 * @param {number[][]} groups   1-based [a,b] inclusive page ranges
 * @param {string} stem         output filename stem (source name without .pdf)
 * @param {{naming?: 'range'|'part'}} [opts] 'part' → `<stem>-part-N.pdf` (every-N)
 * @returns {Promise<Array<{name:string, bytes:Uint8Array}>>}
 * Throws PdfEngineError if the engine can't load; other pdf-lib failures propagate.
 */
export async function buildOutputs(srcBytes, groups, stem, opts = {}) {
  const naming = opts.naming || 'range';
  let pdfLib;
  try {
    pdfLib = await loadPdfLib();
  } catch (e) {
    throw new PdfEngineError(e);
  }
  const { PDFDocument } = pdfLib;
  const src = await PDFDocument.load(srcBytes);
  const outputs = [];
  for (let i = 0; i < groups.length; i++) {
    const bytes = await makePdf(pdfLib, src, expand(groups[i]));
    outputs.push({ name: nameFor(stem, groups[i], i, naming), bytes });
  }
  return outputs;
}

/**
 * Build the SINGLE extract-mode output from an ordered, deduped page list.
 * @returns {Promise<{name:string, bytes:Uint8Array}>}  `<stem>-pages.pdf`
 * Throws PdfEngineError if the engine can't load.
 */
export async function buildExtract(srcBytes, pages, stem) {
  let pdfLib;
  try {
    pdfLib = await loadPdfLib();
  } catch (e) {
    throw new PdfEngineError(e);
  }
  const { PDFDocument } = pdfLib;
  const src = await PDFDocument.load(srcBytes);
  const bytes = await makePdf(pdfLib, src, pages);
  return { name: `${stem}-pages.pdf`, bytes };
}

// Ensure every ZIP entry name is unique — a range typed twice (`1-3, 1-3`) would
// otherwise collide. Appends `-2`, `-3`, … before the extension.
function uniquify(name, seen) {
  if (!seen.has(name)) { seen.add(name); return name; }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = 2;
  let candidate = `${base}-${n}${ext}`;
  while (seen.has(candidate)) { n += 1; candidate = `${base}-${n}${ext}`; }
  seen.add(candidate);
  return candidate;
}

/**
 * Zip multiple outputs (STORE — PDFs barely deflate) into `<stem>-split.zip`.
 * @param {Array<{name:string, bytes:Uint8Array}>} outputs
 * @param {string} stem
 * @returns {Promise<{name:string, blob:Blob}>}
 * Throws if JSZip can't load (zip.js resets its cache so a retry re-fetches).
 */
export async function zipOutputs(outputs, stem) {
  const JSZip = await loadJSZip();
  const zip = new JSZip();
  const seen = new Set();
  for (const out of outputs) {
    zip.file(uniquify(out.name, seen), out.bytes, { compression: 'STORE' });
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  return { name: `${stem}-split.zip`, blob };
}
