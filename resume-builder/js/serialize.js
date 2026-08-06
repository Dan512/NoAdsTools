// resume-builder/js/serialize.js — PURE .resume.json (de)serialisation.
// fromJson NEVER throws: { ok:true, resume } | { ok:false, errors:[strings] }.
// The current resume is only replaced on ok:true (import must never destroy work).
import { SCHEMA_VERSION, migrate } from './model.js';

export function toJson(resume) {
  return JSON.stringify(resume, null, 2);
}

export function fromJson(text) {
  let raw;
  try {
    raw = JSON.parse(String(text));
  } catch {
    return { ok: false, errors: ['This file is not valid JSON.'] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['This does not look like a resume file from this tool.'] };
  }
  if (typeof raw.schemaVersion !== 'number' || !('sections' in raw || 'basics' in raw)) {
    return { ok: false, errors: ['This does not look like a resume file from this tool.'] };
  }
  if (raw.schemaVersion > SCHEMA_VERSION) {
    return { ok: false, errors: ['This file was made with a newer version of this tool — update this page (reload) and try again.'] };
  }
  return { ok: true, resume: migrate(raw) };
}
