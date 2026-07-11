// shared/pdf-meta.js — clear a PDF's carried metadata so no source document
// properties survive into an output produced by the PDF cluster. Clears the
// info dictionary AND deletes the catalog XMP (/Metadata) stream, which
// pdf-lib's info-dict setters leave untouched. Call before doc.save().
//
// Two-step XMP removal matters for the LOAD-MODIFY path (e.g. watermark, which
// loads a source doc and re-saves it): pdf-lib serializes EVERY indirect object
// in the context on save(), so deleting only the catalog reference leaves the
// now-orphaned XMP stream — with its source title/author — in the output.
// Deleting the object itself from the context removes it for real. Fresh-doc
// paths (merge/split build a new doc via copyPages) never carry the XMP at all;
// there the call is a harmless no-op. Verified: with this helper, a source
// carrying a secret XMP marker produces output with the marker absent.
export function stripSourceMetadata(doc, pdfLib) {
  try { doc.setTitle(''); doc.setAuthor(''); doc.setSubject(''); doc.setKeywords([]);
        doc.setProducer('NoAdsTools'); doc.setCreator('NoAdsTools'); } catch {}
  try {
    const { PDFName, PDFRef } = pdfLib;
    const key = PDFName.of('Metadata');
    const ref = doc.catalog.get(key);   // indirect ref to the XMP stream, if any
    doc.catalog.delete(key);
    if (ref instanceof PDFRef) doc.context.delete(ref);
  } catch {}
}
