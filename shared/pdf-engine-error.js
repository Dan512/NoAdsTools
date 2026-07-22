// shared/pdf-engine-error.js — the ONE engine-failure class for the whole PDF
// cluster. Thrown when an ENGINE (pdf-lib or pdf.js) can't be fetched/parsed —
// an infrastructure failure (a 404, an offline network, a blocked module), NOT
// the dropped file's fault. Tools surface it as a global "couldn't load the PDF
// engine" message instead of blaming the file (playbook: never blame the file
// for a load limit).
//
// It lives in its own tiny module so BOTH loaders (pdflib-loader, pdfjs-loader)
// can throw the SAME class — then `err instanceof PdfEngineError` holds no
// matter which engine failed, and every tool shows one honest, retryable
// message. `cause` carries the underlying load error for the console diagnostic.
export class PdfEngineError extends Error {
  constructor(cause) {
    super('failed to load the PDF engine');
    this.name = 'PdfEngineError';
    this.cause = cause;
  }
}
