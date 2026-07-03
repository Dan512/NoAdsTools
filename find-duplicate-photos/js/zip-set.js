// find-duplicate-photos/js/zip-set.js — PURE "unique set" builder: which files
// go in the deduplicated ZIP and at what path. Keepers + every non-clustered
// photo; never the files the user marked for deletion; never unreadable files.

/** @returns {Array<{ id: string, zipPath: string, size: number }>} */
export function buildZipManifest({ items, groups }) {
  const excluded = new Set();
  for (const g of groups) for (const m of g.members) if (!m.keep) excluded.add(m.id);

  const taken = new Map(); // lowercased zipPath → true (Windows unzips are case-insensitive)
  const out = [];
  for (const it of items) {
    if (!it || it.status === 'failed' || it.status === 'pending') continue;
    if (excluded.has(it.id)) continue;
    let path = it.relPath || it.name;
    if (taken.has(path.toLowerCase())) {
      const slash = path.lastIndexOf('/');
      const dot = path.lastIndexOf('.');
      const hasExt = dot > slash + 1;
      const stem = hasExt ? path.slice(0, dot) : path;
      const ext = hasExt ? path.slice(dot) : '';
      let n = 2;
      while (taken.has(`${stem} (${n})${ext}`.toLowerCase())) n++;
      path = `${stem} (${n})${ext}`;
    }
    taken.set(path.toLowerCase(), true);
    out.push({ id: it.id, zipPath: path, size: it.size || 0 });
  }
  return out;
}
