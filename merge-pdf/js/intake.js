// merge-pdf/js/intake.js — pure PDF allowlist. No DOM, no I/O.
// A file is accepted only if its FINAL extension is `pdf`, or (when it has no
// extension at all) its MIME is application/pdf. Extension wins over MIME so a
// disguised `invoice.pdf.exe` (final ext `exe`) is rejected even if the browser
// mislabels its type.
const PDF_MIME = 'application/pdf';

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

/** Allowlist check: real PDFs only. Extension decides when present; MIME rescues extensionless files. */
export function isPdf(name, mime) {
  const e = extOf(name);
  if (e) return e === 'pdf';
  return String(mime || '').toLowerCase() === PDF_MIME;
}
