/**
 * Deep diff between two objects.
 * Emits list of changed leaf paths: [{ path: 'rich.striker.runs', from: 42, to: 46 }]
 */

const IGNORED_DIFF_KEYS = new Set([
  'updatedAt',
  'timestamp',
  'serverTimestamp',
  'cachedAt',
  'meta',
  'ts',
  'at',
]);

export function diffResponse(prev, next) {
  const changes = [];
  walk(prev, next, '', changes);
  return changes;
}

function walk(a, b, path, out) {
  if (a === b) return;
  const isObj = (x) => x && typeof x === 'object';
  if (!isObj(a) || !isObj(b)) {
    out.push({ path, from: a ?? null, to: b ?? null });
    return;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (IGNORED_DIFF_KEYS.has(k)) continue;
    walk(a[k], b[k], path ? `${path}.${k}` : k, out);
  }
}
