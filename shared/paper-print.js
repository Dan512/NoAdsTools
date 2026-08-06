// shared/paper-print.js — the print / Save-as-PDF flow for paper-document tools
// (resume-builder, cover-letter-generator). No PDF library: the browser's paged
// media engine produces the file, so the text stays real and selectable.
//
// applyPaper keeps the injected @page rule in sync with the chosen paper (CSS
// alone cannot switch @page size from an attribute). printDocument sets
// document.title only for the duration of the dialog — Chrome/Edge use it as
// the suggested PDF filename — then restores it.

export function applyPaper(paper) {
  const style = document.getElementById('page-size-style');
  if (!style) return;
  style.textContent = `@page { size: ${paper === 'a4' ? 'A4' : 'letter'}; margin: 0; }`;
}

/**
 * @param {string} fullName the person's name, used in the suggested filename
 * @param {string} docLabel e.g. 'Resume' or 'Cover Letter'
 */
export function printDocument(fullName, docLabel) {
  const prev = document.title;
  const name = (fullName || '').trim();
  const label = docLabel || 'Document';
  document.title = name ? `${name} — ${label}` : label;
  const restore = () => { document.title = prev; window.removeEventListener('afterprint', restore); };
  window.addEventListener('afterprint', restore);
  window.print();
  setTimeout(restore, 2000); // fallback: some browsers skip afterprint
}
