// merge-pdf/js/reorder.js — pure list-move helpers for the merge order.
// Every function is immutable: the input array is never mutated (each returns a
// fresh array), so the drag/keyboard UI can call these and diff against state.
// No DOM, no pdf-lib — Node-testable.

/** Move the item at `i` one slot earlier. No-op at index 0 or out of range. */
export function moveUp(arr, i) {
  if (i <= 0 || i >= arr.length) return arr.slice();
  return moveTo(arr, i, i - 1);
}

/** Move the item at `i` one slot later. No-op at the last index or out of range. */
export function moveDown(arr, i) {
  if (i < 0 || i >= arr.length - 1) return arr.slice();
  return moveTo(arr, i, i + 1);
}

/** Relocate the item at `from` to `to`, clamping `to` into [0, len-1]. Immutable. */
export function moveTo(arr, from, to) {
  const next = arr.slice();
  if (from < 0 || from >= next.length) return next;
  const target = Math.max(0, Math.min(to, next.length - 1));
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item);
  return next;
}

/** Drop the item at index `i`. Immutable; out-of-range indices return a copy. */
export function removeAt(arr, i) {
  const next = arr.slice();
  if (i < 0 || i >= next.length) return next;
  next.splice(i, 1);
  return next;
}
