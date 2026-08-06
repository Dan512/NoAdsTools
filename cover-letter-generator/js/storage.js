// cover-letter-generator/js/storage.js — letter-specific binding of the shared
// id-keyed document store. Separate key prefix from resume-builder, so the two
// tools' documents never collide in localStorage — and so clearing one tool's
// data can never delete the other's.
//
// The import is RELATIVE, not '/shared/…': this module is reachable from Node
// unit tests, and Node cannot resolve a root-absolute specifier. A relative
// path works in both Node and the browser.
import { migrate } from './model.js';
import { makeDocStorage } from '../../shared/doc-storage.js';

const S = makeDocStorage('noadstools:letter:', migrate);

export const INDEX_KEY = S.INDEX_KEY;
export const keyFor = S.keyFor;
export const loadIndex = S.loadIndex;
export const loadLetter = S.loadDoc;
export const saveLetter = S.saveDoc;
export const removeLetter = S.removeDoc;
export const clearAll = S.clearAll;
