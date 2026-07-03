// find-duplicate-photos/js/report.js — PURE view-model for the results panel.
// Clusters via shared/dedupe.js, applies the auto-keeper rule, then user
// overrides, and derives the summary. No DOM, no async — Node-testable.
import {
  groupBySha256, clusterByPerceptual, thresholdFor, pickKeeper,
} from '../../shared/dedupe.js';

/**
 * @param {{ items: Array<object>, sensitivity: string, overrides: Record<string, boolean> }} args
 * @returns {{
 *   groups: Array<{ key: string, matchType: 'exact'|'similar', reclaimableBytes: number,
 *                   members: Array<{ id: string, keep: boolean }> }>,
 *   scannedCount: number, duplicateCount: number, reclaimableBytes: number,
 *   duplicateGroupCount: number,
 * }}
 */
export function buildGroups({ items, sensitivity, overrides }) {
  overrides = overrides || {};
  const usable = items.filter(it => it && (it.status === 'hashed' || it.status === 'exact-only'));
  const byId = new Map(usable.map(it => [it.id, it]));

  const exact = groupBySha256(usable.filter(it => it.sha256));
  const inExact = new Set(exact.flat());
  const rest = usable.filter(it => it.status === 'hashed' && !inExact.has(it.id) && (it.dhash || it.phash));
  const similar = clusterByPerceptual(rest, thresholdFor(sensitivity));

  const getMeta = (id) => {
    const it = byId.get(id);
    return {
      pixelCount: (it.width || 0) * (it.height || 0),
      byteSize: it.size || 0,
      queuePosition: it.order ?? Number.MAX_SAFE_INTEGER,
    };
  };

  const toGroup = (memberIds, matchType) => {
    const keeper = pickKeeper(memberIds, getMeta);
    const members = memberIds
      .slice()
      .sort((a, b) => (byId.get(a).order ?? 0) - (byId.get(b).order ?? 0))
      .map(id => {
        const auto = id === keeper;
        const keep = Object.prototype.hasOwnProperty.call(overrides, id) ? !!overrides[id] : auto;
        return { id, keep };
      });
    // Keeper-marked members render first.
    members.sort((a, b) => (b.keep ? 1 : 0) - (a.keep ? 1 : 0));
    const reclaimableBytes = members
      .filter(m => !m.keep)
      .reduce((sum, m) => sum + (byId.get(m.id).size || 0), 0);
    return {
      key: memberIds.slice().sort().join('|'),
      matchType, members, reclaimableBytes,
    };
  };

  const groups = exact.map(g => toGroup(g, 'exact'))
    .concat(similar.map(g => toGroup(g, 'similar')))
    .filter(g => g.members.some(m => !m.keep) || g.members.length >= 2);
  groups.sort((a, b) => b.reclaimableBytes - a.reclaimableBytes);

  const duplicateCount = groups.reduce((n, g) => n + g.members.filter(m => !m.keep).length, 0);
  const reclaimableBytes = groups.reduce((n, g) => n + g.reclaimableBytes, 0);
  const duplicateGroupCount = groups.filter(g => g.members.some(m => !m.keep)).length;
  return {
    groups, scannedCount: usable.length, duplicateCount, reclaimableBytes, duplicateGroupCount,
  };
}
