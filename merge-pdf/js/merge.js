// merge-pdf/js/merge.js — coordinator between the UI and the vendored pdf-lib.
// Reads each added PDF's page count (classifying encrypted → 'locked' and
// unreadable/corrupt → 'error'), then merges the readable ones in list order
// via copyPages into a fresh document with minimal metadata. pdf-lib is loaded
// lazily through the shared loader, so nothing is fetched until the first PDF is
// added. Each item caches its own bytes so the merge never re-reads a File.
// PdfEngineError is shared across the PDF cluster — one class, one message.
import { loadPdfLib, PdfEngineError } from '/shared/pdflib-loader.js';
import { stripSourceMetadata } from '/shared/pdf-meta.js';
export { PdfEngineError }; // re-export for main.js's existing import path

// Distinguish "this PDF is encrypted" from any other load failure. The minified
// build doesn't set Error.name, so identity comes from the exported class
// (instanceof), with a message-substring fallback for safety.
function isEncryptedError(err, EncryptedPDFError) {
  if (EncryptedPDFError && err instanceof EncryptedPDFError) return true;
  return /encrypted/i.test(String((err && err.message) || err || ''));
}

/**
 * Read a File into an item: { id, file, name, size, pageCount, status, error, bytes }.
 * status: 'ok' (readable, pageCount set) | 'locked' (password-protected) |
 * 'error' (corrupt / not a real PDF). Throws PdfEngineError only if pdf-lib
 * itself can't load. Caches item.bytes for a later merge.
 */
export async function addPdf(file, id) {
  const item = {
    id, file, name: file.name, size: file.size,
    pageCount: 0, status: 'ok', error: null, bytes: null,
  };

  try {
    item.bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    item.status = 'error';
    item.error = 'unreadable';
    return item;
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
    const doc = await PDFDocument.load(item.bytes, { ignoreEncryption: false });
    item.pageCount = doc.getPageCount();
  } catch (err) {
    if (isEncryptedError(err, EncryptedPDFError)) {
      item.status = 'locked';
      item.error = 'password-protected';
    } else {
      item.status = 'error';
      item.error = 'unreadable';
    }
  }
  return item;
}

/**
 * Merge readable items (already filtered to status 'ok' and ordered) into one
 * PDF. Returns the saved Uint8Array. Fresh minimal metadata only — no source
 * document metadata is carried into the output. Throws PdfEngineError if the
 * engine can't load; other pdf-lib failures propagate for the caller to report.
 */
export async function mergeItems(orderedOkItems, onProgress) {
  let pdfLib;
  try {
    pdfLib = await loadPdfLib();
  } catch (e) {
    throw new PdfEngineError(e);
  }
  const { PDFDocument } = pdfLib;

  const out = await PDFDocument.create();
  let done = 0;
  for (const item of orderedOkItems) {
    const src = await PDFDocument.load(item.bytes);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
    done += 1;
    if (onProgress) onProgress({ done, total: orderedOkItems.length });
  }
  // Fresh, minimal metadata via the shared cluster helper — clears the info
  // dictionary AND deletes any catalog XMP (/Metadata) stream, so no source
  // document properties (info-dict OR XMP) reach the output. copyPages already
  // carries pages only; this closes the XMP gap uniformly across the cluster.
  // Note: pdf-lib 1.17.1 re-stamps its own Producer + ModDate inside save() —
  // harmless (the library's own name, not source data).
  stripSourceMetadata(out, pdfLib);
  return out.save();
}
