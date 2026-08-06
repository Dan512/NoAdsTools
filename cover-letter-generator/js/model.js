// cover-letter-generator/js/model.js — PURE cover-letter data model. No DOM, no I/O.
// Mirrors resume-builder's model conventions: schemaVersion + migrate() from day
// one, per-field type coercion at the migrate boundary (a hostile or corrupt
// import must never be able to crash the renderer).
export const SCHEMA_VERSION = 1;

let idCounter = 1;
export function _resetIdsForTest() { idCounter = 1; }
function genId(prefix) { return `${prefix}_${Date.now().toString(36)}${(idCounter++).toString(36)}`; }
export function genLetterId() { return genId('c'); }

const str = (v) => (typeof v === 'string' ? v : '');
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export function createLetter() {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: genId('c'),
    name: 'Untitled cover letter',
    options: { paper: 'letter' },
    sender: { fullName: '', email: '', phone: '', location: '' },
    recipient: { name: '', title: '', company: '', address: '' },
    dateLine: '',
    salutation: 'Dear Hiring Manager,',
    body: '',
    closing: 'Sincerely,',
    signature: '',
  };
}

/** Blank-line-separated paragraphs. A single newline is a soft wrap, not a break. */
export function paragraphsOf(body) {
  return str(body).split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
}

export function migrate(raw) {
  const base = createLetter();
  const r = isObj(raw) ? raw : {};
  const sender = isObj(r.sender) ? r.sender : {};
  const recipient = isObj(r.recipient) ? r.recipient : {};
  return {
    schemaVersion: SCHEMA_VERSION,
    id: str(r.id) || base.id,
    name: str(r.name) || base.name,
    options: { paper: isObj(r.options) && r.options.paper === 'a4' ? 'a4' : 'letter' },
    sender: {
      fullName: str(sender.fullName), email: str(sender.email),
      phone: str(sender.phone), location: str(sender.location),
    },
    recipient: {
      name: str(recipient.name), title: str(recipient.title),
      company: str(recipient.company), address: str(recipient.address),
    },
    dateLine: str(r.dateLine),
    salutation: str(r.salutation) || base.salutation,
    body: str(r.body),
    closing: str(r.closing) || base.closing,
    signature: str(r.signature),
  };
}
