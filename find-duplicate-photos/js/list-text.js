// find-duplicate-photos/js/list-text.js — PURE formatter for the copy/download
// delete list. Plain text, usable directly in a file manager.

export function prettyBytes(n) {
  if (!Number.isFinite(n) || n < 0) n = 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v.toFixed(1).replace(/\.0$/, '')} ${units[u]}`;
}

const MATCH_LABEL = { exact: 'identical files', similar: 'visually similar' };

export function buildDuplicateListText({ groups, itemsById, scannedCount }) {
  const withDupes = groups.filter(g => g.members.some(m => !m.keep));
  const deleteCount = withDupes.reduce((n, g) => n + g.members.filter(m => !m.keep).length, 0);
  const bytes = withDupes.reduce((n, g) =>
    n + g.members.filter(m => !m.keep).reduce((s, m) => s + (itemsById.get(m.id)?.size || 0), 0), 0);

  const lines = [
    'Duplicate photos found by NoAdsTools (https://noadstools.com/find-duplicate-photos/)',
    `Scanned ${scannedCount} photos — ${withDupes.length} duplicate groups, ${deleteCount} files marked as duplicates (${prettyBytes(bytes)}).`,
    '',
  ];
  withDupes.forEach((g, i) => {
    lines.push(`Group ${i + 1} — ${MATCH_LABEL[g.matchType] || g.matchType}:`);
    for (const m of g.members) {
      const it = itemsById.get(m.id);
      if (!it) continue;
      const tag = m.keep ? 'KEEP  ' : 'DELETE';
      const dims = it.width && it.height ? `${it.width}×${it.height}, ` : '';
      lines.push(`  ${tag}  ${it.relPath}  (${dims}${prettyBytes(it.size)})`);
    }
    lines.push('');
  });
  return lines.join('\n');
}
