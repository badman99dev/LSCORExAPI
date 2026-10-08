/**
 * Cricket scores, overs, and match progress parsing.
 */

export function parseScore(str) {
  if (str == null) return null;
  const s = String(str).trim();
  const m = s.match(/(\d{1,3})\s*\/\s*(\d{1,2})?\s*(?:\(\s*(\d{1,3})(?:\.(\d))?\))?/);
  if (!m) return null;
  const runs = parseInt(m[1], 10);
  const wickets = m[2] != null ? parseInt(m[2], 10) : null;
  let overs = null, balls = null;
  if (m[3] != null) {
    const full = parseInt(m[3], 10);
    const part = m[4] != null ? parseInt(m[4], 10) : 0;
    overs = full + part / 10;
    balls = full * 6 + part;
  }
  return { runs, wickets, overs, balls };
}

export function ovStr(overs) {
  if (overs == null) return null;
  const full = Math.floor(overs + 1e-9);
  const part = Math.round((overs - full) * 10 + 1e-6);
  return `${full}.${part}`;
}

export function ballCount(overs) {
  if (overs == null) return null;
  const full = Math.floor(overs + 1e-9);
  const part = Math.round((overs - full) * 10 + 1e-6);
  return full * 6 + part;
}

export function parseOversStr(s) {
  const full = parseInt(String(s), 10);
  const partM = String(s).match(/\.(\d)/);
  const part = partM ? parseInt(partM[1], 10) : 0;
  if (isNaN(full)) return { overs: null, balls: null };
  return { overs: full + part / 10, balls: full * 6 + part };
}

export function parseNeed(str) {
  if (!str) return null;
  const m = String(str).match(/(\d+)\s+runs?\s+in\s+(\d+)\s+balls?/i);
  if (!m) return null;
  return { runs: parseInt(m[1], 10), balls: parseInt(m[2], 10) };
}
