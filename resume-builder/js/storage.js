// resume-builder/js/storage.js — resume-specific binding of the shared
// id-keyed document store. The generic engine lives in shared/doc-storage.js
// (also used by cover-letter-generator); this file fixes the key prefix and
// the migrate function, and keeps the original export names so nothing that
// imports it has to change.
//
// The import is RELATIVE, not '/shared/…': this module is imported by Node
// unit tests, and Node cannot resolve a root-absolute specifier. A relative
// path works in both Node and the browser — the same reason
// js/templates/classic.js reaches shared/escape.js the same way.
import { migrate } from './model.js';
import { makeDocStorage } from '../../shared/doc-storage.js';

const S = makeDocStorage('noadstools:resume:', migrate);

export const INDEX_KEY = S.INDEX_KEY;
export const keyFor = S.keyFor;
export const loadIndex = S.loadIndex;
export const loadResume = S.loadDoc;
export const saveResume = S.saveDoc;
export const removeResume = S.removeDoc;
export const clearAll = S.clearAll;
