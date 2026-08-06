// resume-builder/js/model.js — PURE resume data model. No DOM, no I/O.
// The `sections` array order IS the render order (phase 2 reordering just moves
// array items). schemaVersion + migrate() exist from day one so stored/imported
// data survives future shape changes.
export const SCHEMA_VERSION = 1;
export const SECTION_TYPES = Object.freeze(['experience', 'education', 'skills', 'custom']);

const DEFAULT_TITLES = { experience: 'Experience', education: 'Education', skills: 'Skills', custom: 'Projects' };

let idCounter = 1;
export function _resetIdsForTest() { idCounter = 1; }
function genId(prefix) { return `${prefix}_${Date.now().toString(36)}${(idCounter++).toString(36)}`; }

/** A fresh resume id — used when duplicating (the copy must not share the original's key). */
export function genResumeId() { return genId('r'); }

export function blankItem(type) {
  switch (type) {
    case 'experience': return { id: genId('i'), role: '', org: '', location: '', start: '', end: '', current: false, bullets: [''] };
    case 'education':  return { id: genId('i'), degree: '', school: '', location: '', start: '', end: '', note: '' };
    case 'skills':     return { id: genId('i'), text: '' };
    case 'custom':     return { id: genId('i'), heading: '', sub: '', meta: '', bullets: [''] };
    default: throw new Error(`unknown section type: ${type}`);
  }
}

function blankSection(type) {
  return { id: genId('s'), type, title: DEFAULT_TITLES[type], items: [blankItem(type)] };
}

export function createResume() {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: genId('r'),
    name: 'Untitled resume',
    template: 'classic',
    options: { paper: 'letter' },
    basics: { fullName: '', headline: '', email: '', phone: '', location: '', links: [] },
    summary: '',
    sections: [blankSection('experience'), blankSection('education'), blankSection('skills')],
  };
}

function sectionOf(resume, sectionId) {
  return resume.sections.find(s => s.id === sectionId) || null;
}

export function addItem(resume, sectionId) {
  const sec = sectionOf(resume, sectionId);
  if (!sec) return null;
  const item = blankItem(sec.type);
  sec.items.push(item);
  return item;
}

export function removeItem(resume, sectionId, itemId) {
  const sec = sectionOf(resume, sectionId);
  if (!sec) return;
  sec.items = sec.items.filter(i => i.id !== itemId);
}

export function moveItem(resume, sectionId, itemId, dir) {
  const sec = sectionOf(resume, sectionId);
  if (!sec) return;
  const from = sec.items.findIndex(i => i.id === itemId);
  const to = from + dir;
  if (from < 0 || to < 0 || to >= sec.items.length) return; // clamp
  const [it] = sec.items.splice(from, 1);
  sec.items.splice(to, 0, it);
}

export function addSection(resume, type) {
  if (!SECTION_TYPES.includes(type)) throw new Error(`unknown section type: ${type}`);
  const sec = blankSection(type);
  resume.sections.push(sec);
  return sec;
}

export function removeSection(resume, sectionId) {
  resume.sections = resume.sections.filter(s => s.id !== sectionId);
}

export function moveSection(resume, sectionId, dir) {
  const from = resume.sections.findIndex(s => s.id === sectionId);
  const to = from + dir;
  if (from < 0 || to < 0 || to >= resume.sections.length) return; // clamp
  const [s] = resume.sections.splice(from, 1);
  resume.sections.splice(to, 0, s);
}

// Arbitrary-index moves. `moveItem`/`moveSection` step by ±1 (the ▲▼ buttons);
// drag needs to drop an element at any position, so these take a target index
// and clamp it into range. Unknown ids are no-ops, like their ±1 siblings.
export function moveItemTo(resume, sectionId, itemId, index) {
  const sec = resume.sections.find(s => s.id === sectionId);
  if (!sec) return;
  const from = sec.items.findIndex(i => i.id === itemId);
  if (from < 0) return;
  const to = Math.max(0, Math.min(sec.items.length - 1, index));
  if (to === from) return;
  const [it] = sec.items.splice(from, 1);
  sec.items.splice(to, 0, it);
}

export function moveSectionTo(resume, sectionId, index) {
  const from = resume.sections.findIndex(s => s.id === sectionId);
  if (from < 0) return;
  const to = Math.max(0, Math.min(resume.sections.length - 1, index));
  if (to === from) return;
  const [s] = resume.sections.splice(from, 1);
  resume.sections.splice(to, 0, s);
}

// --- Type-coercion helpers for migrate() -------------------------------------
// migrate() is the ONE normalization boundary: it must guarantee every field
// has the TYPE the templates assume, not just the right shape. A crafted or
// corrupt .json (bad export, hand-edited file, future format drift) must
// degrade to blank fields here — never throw downstream in render().
function coerceString(v) {
  return typeof v === 'string' ? v : '';
}

function coerceBool(v) {
  return !!v;
}

function coerceBullets(v) {
  const arr = Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
  return arr.length ? arr : [''];
}

function isPlainObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function coerceLink(raw) {
  const l = isPlainObj(raw) ? raw : {};
  return {
    id: typeof l.id === 'string' && l.id ? l.id : genId('l'),
    label: coerceString(l.label),
    url: coerceString(l.url),
  };
}

// Build a fresh item with ONLY the known fields for `type`, each coerced to
// its expected type. Unknown extra keys on `raw` are dropped intentionally —
// a blind `{...blank, ...raw}` spread would let them round-trip forever.
function coerceItem(type, raw) {
  const i = isPlainObj(raw) ? raw : {};
  const id = typeof i.id === 'string' && i.id ? i.id : genId('i');
  switch (type) {
    case 'experience':
      return {
        id, role: coerceString(i.role), org: coerceString(i.org),
        location: coerceString(i.location), start: coerceString(i.start), end: coerceString(i.end),
        current: coerceBool(i.current), bullets: coerceBullets(i.bullets),
      };
    case 'education':
      return {
        id, degree: coerceString(i.degree), school: coerceString(i.school),
        location: coerceString(i.location), start: coerceString(i.start), end: coerceString(i.end),
        note: coerceString(i.note),
      };
    case 'skills':
      return { id, text: coerceString(i.text) };
    case 'custom':
      return {
        id, heading: coerceString(i.heading), sub: coerceString(i.sub),
        meta: coerceString(i.meta), bullets: coerceBullets(i.bullets),
      };
    default:
      throw new Error(`unknown section type: ${type}`);
  }
}

// Normalise a stored/imported object of THIS OR OLDER schemaVersion into the
// current shape: fill anything missing, coerce anything mistyped, keep
// everything recognisable. The caller (serialize.fromJson / storage load)
// rejects NEWER versions first.
export function migrate(raw) {
  const base = createResume();
  const r = (raw && typeof raw === 'object') ? raw : {};
  const rBasics = isPlainObj(r.basics) ? r.basics : {};
  const out = {
    schemaVersion: SCHEMA_VERSION,
    id: typeof r.id === 'string' && r.id ? r.id : base.id,
    name: typeof r.name === 'string' && r.name ? r.name : base.name,
    template: typeof r.template === 'string' && r.template ? r.template : base.template,
    options: { paper: r.options?.paper === 'a4' ? 'a4' : 'letter' },
    basics: {
      fullName: coerceString(rBasics.fullName),
      headline: coerceString(rBasics.headline),
      email: coerceString(rBasics.email),
      phone: coerceString(rBasics.phone),
      location: coerceString(rBasics.location),
      links: Array.isArray(rBasics.links) ? rBasics.links.filter(isPlainObj).map(coerceLink) : [],
    },
    summary: typeof r.summary === 'string' ? r.summary : '',
    sections: Array.isArray(r.sections) ? r.sections
      .filter(s => isPlainObj(s) && SECTION_TYPES.includes(s.type))
      .map(s => ({
        id: typeof s.id === 'string' && s.id ? s.id : genId('s'),
        type: s.type,
        title: typeof s.title === 'string' && s.title ? s.title : DEFAULT_TITLES[s.type],
        items: (Array.isArray(s.items) ? s.items : [])
          .filter(isPlainObj)
          .map(i => coerceItem(s.type, i)),
      })) : base.sections,
  };
  return out;
}
