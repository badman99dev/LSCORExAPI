/**
 * Advanced Match Finder
 * ---------------------------------------------------------------
 * Two modes:
 *
 * A) TEAM MODE (team1 + team2 + startTime):
 *   1. Search each team name -> take top N (default 2) Team results.
 *   2. For every ordered combo (1x1, 1x2, 2x1, 2x2) fetch both
 *      teams' "Team Matches & Tours" and intersect by match id.
 *   3. Within each combo pick the fixture closest to startTime
 *      (exact -> within tolerance -> same UTC day -> closest).
 *
 * B) SERIES MODE (series + startTime [+ optional team1/team2 filter]):
 *   1. Search the series name -> take the FIRST Series result.
 *   2. Load that series' matches.
 *   3. Return the series match closest to startTime.
 */

import { searchCricket } from './crex.js';
import { getTeamMatches, getSeriesMatches } from './crexSeriesTeam.js';

// ---------------------------------------------------------------------------
// Series-mode cache (1 day TTL). Series + their fixtures rarely change, so we
// cache both the search hits and the per-series fixture lists for 24h.
// ---------------------------------------------------------------------------
const SERIES_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
const seriesSearchCache = new Map(); // query -> { at, data }
const seriesMatchesCache = new Map(); // seriesKey -> { at, data }

function cacheGet(store, key) {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < SERIES_CACHE_TTL_MS) return hit.data;
  if (hit) store.delete(key);
  return undefined;
}

function cacheSet(store, key, data) {
  store.set(key, { at: Date.now(), data });
  return data;
}

export function clearSeriesCache() {
  seriesSearchCache.clear();
  seriesMatchesCache.clear();
}

export function getSeriesCacheStats() {
  return {
    ttlMs: SERIES_CACHE_TTL_MS,
    searchEntries: seriesSearchCache.size,
    matchesEntries: seriesMatchesCache.size,
    searchKeys: [...seriesSearchCache.keys()],
    matchesKeys: [...seriesMatchesCache.keys()],
  };
}

async function cachedSearchCricket(query) {
  const key = String(query || '').trim().toLowerCase();
  const cached = cacheGet(seriesSearchCache, key);
  if (cached) return cached;
  const data = await searchCricket(query);
  return cacheSet(seriesSearchCache, key, data);
}

async function cachedSeriesMatches(seriesKey) {
  const key = String(seriesKey || '');
  const cached = cacheGet(seriesMatchesCache, key);
  if (cached) return cached;
  let matches = [];
  try {
    const data = await getSeriesMatches(key);
    matches = (data && data.matches) ? data.matches.map((m) => ({ ...m })) : [];
  } catch {
    matches = [];
  }
  return cacheSet(seriesMatchesCache, key, matches);
}

function flattenMatches(tm) {
  const out = [];
  if (!tm) return out;
  for (const t of tm.tournaments || []) {
    for (const m of t.matches || []) {
      out.push({ ...m, seriesName: t.seriesName || null, seriesKey: t.seriesKey || null });
    }
  }
  return out;
}

const EPOCH_MS_MIN = 0;
const EPOCH_MS_MAX = 4102444800000; // year 2100

// "2026/10/09 13:30:14 +0000" (also accepts '-' separators, 'T'/' ' gap,
// optional seconds, optional tz as +HHMM/+HH:MM/Z/UTC).
const DATETIME_RE = /^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:\s*([+-]?\d{2}:?\d{2}|Z|UTC))?$/i;

function parseDateTimeString(raw) {
  const m = raw.match(DATETIME_RE);
  if (!m) return null;
  const year = +m[1], month = +m[2], day = +m[3];
  const hour = +m[4], min = +m[5], sec = m[6] ? +m[6] : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || min > 59 || sec > 59) {
    return null;
  }
  let offsetMin = 0;
  const tz = m[7];
  if (tz && !/^(Z|UTC)$/i.test(tz)) {
    const sign = tz[0] === '-' ? -1 : 1;
    const digits = tz.slice(1).replace(':', '');
    const hh = +digits.slice(0, 2);
    const mm = digits.length > 2 ? +digits.slice(2, 4) : 0;
    offsetMin = sign * (hh * 60 + mm);
  }
  const utcMs = Date.UTC(year, month - 1, day, hour, min, sec);
  return utcMs - offsetMin * 60000;
}

/**
 * Parse a start time supplied as:
 *   - epoch milliseconds since 1970 (number or numeric string), e.g. 1822896000000
 *   - a datetime string like "2026/10/09 13:30:14 +0000"
 * Returns { ms, error }.
 */
function parseStartTime(input) {
  if (input == null || input === '') return { ms: null, error: 'startTime is required' };
  const raw = typeof input === 'number' ? input : String(input).trim();
  if (raw === '') return { ms: null, error: 'startTime is required' };

  // Datetime string form (contains ':' or a space between date and time)
  if (!/^-?\d+(\.\d+)?$/.test(String(raw))) {
    const dt = parseDateTimeString(String(raw));
    if (dt == null) {
      return {
        ms: null,
        error: 'startTime must be epoch milliseconds (e.g. 1822896000000) or datetime "YYYY/MM/DD HH:mm:ss +0000"',
      };
    }
    if (dt < EPOCH_MS_MIN || dt > EPOCH_MS_MAX) {
      return { ms: null, error: 'startTime out of range' };
    }
    return { ms: Math.round(dt), error: null };
  }

  const n = Number(raw);
  if (!Number.isFinite(n) || n < EPOCH_MS_MIN || n > EPOCH_MS_MAX) {
    return { ms: null, error: 'startTime out of range; must be epoch milliseconds since 1970' };
  }
  return { ms: Math.round(n), error: null };
}

function sameUtcDay(a, b) {
  if (!a || !b) return false;
  return Math.floor(a / 86400000) === Math.floor(b / 86400000);
}

function teamSummary(t) {
  if (!t) return null;
  return { name: t.name, slug: t.slug, code: t.id || t.teamCode || null };
}

function seriesSummary(s) {
  if (!s) return null;
  return { name: s.name, slug: s.slug, id: s.id || null };
}

/**
 * Pick the fixture whose start time best matches `start`, using priority:
 * exact -> within-tolerance -> same UTC day -> closest (best-effort).
 * Returns { chosen, timeDeltaMs, timeMatchType, candidates }.
 */
function selectByTime(list, start, toleranceMs) {
  const byCloseness = (a, b) =>
    Math.abs((a.timestamp || 0) - start) - Math.abs((b.timestamp || 0) - start);
  const withTs = list.filter((m) => m.timestamp);
  const within = withTs.filter((m) => Math.abs(m.timestamp - start) <= toleranceMs);
  const sameDay = withTs.filter((m) => sameUtcDay(m.timestamp, start));

  let chosen = null;
  let timeDeltaMs = null;
  let timeMatchType = null;

  if (within.length) {
    within.sort(byCloseness);
    chosen = within[0];
    timeDeltaMs = chosen.timestamp - start;
    timeMatchType = timeDeltaMs === 0 ? 'exact' : 'within-tolerance';
  } else if (sameDay.length) {
    sameDay.sort(byCloseness);
    chosen = sameDay[0];
    timeDeltaMs = chosen.timestamp - start;
    timeMatchType = 'same-day';
  } else if (withTs.length) {
    withTs.sort(byCloseness);
    chosen = withTs[0];
    timeDeltaMs = chosen.timestamp - start;
    timeMatchType = 'closest';
  } else if (list.length) {
    chosen = list[0];
    timeMatchType = 'closest';
  }

  return { chosen, timeDeltaMs, timeMatchType, candidates: withTs.slice().sort(byCloseness) };
}

/**
 * Series mode: search the series name, pick the best Series result, load its
 * fixtures and return the one closest to the supplied start time.
 *
 * When several series share the name (e.g. "...2026" vs "...2016"), the series
 * whose end/start year is closest to the requested year is chosen first by
 * actually probing each candidate's fixtures for a near-time match.
 */
async function findMatchInSeries({ series, startTime, toleranceMs, team1, team2 }) {
  const start = startTime;
  const results = await cachedSearchCricket(series || '');
  // CREX tags some tours/series as "Series" (t=5) and others as "Other" (t=1),
  // so we treat both as series candidates and validate them by fetching fixtures.
  const seriesHits = results.filter((r) => r.category === 'Series' || r.category === 'Other');

  if (!seriesHits.length) {
    return {
      matched: false,
      mode: 'series',
      reason: 'no series results found',
      query: { series },
      startTime: start,
      referenceTime: start,
    };
  }

  // Optional team filter within the series (accepts team1/team2 as search terms)
  const wanted = [team1, team2].filter(Boolean).map((s) => String(s).toLowerCase());

  const probeCache = new Map();
  const loadSeries = async (hit) => {
    const key = hit.slug || hit.id;
    if (probeCache.has(key)) return probeCache.get(key);
    const matches = await cachedSeriesMatches(key);
    probeCache.set(key, matches);
    return matches;
  };

  const filterByTeams = (list) => {
    if (!wanted.length) return list;
    const filtered = list.filter((m) => {
      const names = [
        m.teams?.team1?.name, m.teams?.team1?.shortName,
        m.teams?.team2?.name, m.teams?.team2?.shortName,
      ].filter(Boolean).map((x) => String(x).toLowerCase());
      return wanted.every((w) => names.some((n) => n.includes(w) || w.includes(n)));
    });
    return filtered.length ? filtered : list;
  };

  let best = null; // { hit, result, teamFiltered }

  // Year hint from the requested startTime (or the query text) to prioritise the
  // matching edition when several same-named series exist (…2026 vs …2016).
  const queryYear = (String(series).match(/\b(19|20)\d{2}\b/) || [])[0];
  const wantYear = queryYear ? Number(queryYear) : new Date(start).getUTCFullYear();
  const hitYear = (hit) => {
    const m = String(hit.name || '').match(/\b(19|20)\d{2}\b/);
    const end = hit.endDate ? new Date(hit.endDate).getUTCFullYear() : null;
    return m ? Number(m[0]) : end;
  };
  const orderedHits = seriesHits.slice().sort((a, b) => {
    const da = Math.abs((hitYear(a) || 9999) - wantYear);
    const db = Math.abs((hitYear(b) || 9999) - wantYear);
    return da - db;
  });

  // Probe each candidate series (bounded) and keep the one with the best time match.
  const probeLimit = Math.min(orderedHits.length, 6);
  const rank = { exact: 0, 'within-tolerance': 1, 'same-day': 2, closest: 3 };

  for (let i = 0; i < probeLimit; i++) {
    const hit = orderedHits[i];
    const all = await loadSeries(hit);
    if (!all.length) continue;

    const pool = filterByTeams(all);
    const sel = selectByTime(pool, start, toleranceMs);
    if (!sel.chosen) continue;

    const candidate = { hit, result: { ...sel, all, pool }, teamFiltered: wanted.length > 0 };
    const better =
      !best ||
      rank[sel.timeMatchType] < rank[best.result.timeMatchType] ||
      (rank[sel.timeMatchType] === rank[best.result.timeMatchType] &&
        Math.abs(sel.timeDeltaMs || 0) < Math.abs(best.result.timeDeltaMs || 0));
    if (better) best = candidate;

    // Early exit on an exact / within-tolerance match.
    if (sel.timeMatchType === 'exact' || sel.timeMatchType === 'within-tolerance') break;
  }

  if (!best) {
    return {
      matched: false,
      mode: 'series',
      reason: 'series has no matches',
      series: seriesSummary(seriesHits[0]),
      startTime: start,
      referenceTime: start,
    };
  }

  const { hit, result, teamFiltered } = best;
  const { chosen, timeDeltaMs, timeMatchType, candidates } = result;
  const timeMatch = timeMatchType === 'exact' || timeMatchType === 'within-tolerance' || timeMatchType === 'same-day';
  const messages = {
    exact: 'Exact start-time match found within the series.',
    'within-tolerance': `Closest series match within the time tolerance (${Math.round(Math.abs(timeDeltaMs) / 60000)} min off).`,
    'same-day': `No match within tolerance, but a series match on the same UTC day was found (${(Math.abs(timeDeltaMs) / 3600000).toFixed(1)} h off).`,
    closest: `No match within tolerance — returning the CLOSEST series fixture (${(Math.abs(timeDeltaMs || 0) / 3600000).toFixed(1)} h off).`,
  };

  return {
    matched: true,
    mode: 'series',
    timeMatch,
    timeMatchType,
    note: messages[timeMatchType] || null,
    series: seriesSummary(hit),
    seriesCandidates: orderedHits.slice(0, probeLimit).map(seriesSummary),
    teamFilter: teamFiltered ? { team1: team1 || null, team2: team2 || null } : null,
    seriesMatchesCount: result.all.length,
    candidatesCount: result.pool.length,
    startTime: start,
    referenceTime: start,
    timeDeltaMs,
    match: chosen,
    candidates,
  };
}

/**
 * @param {object} opts
 * @param {string} [opts.team1]          - first team search term
 * @param {string} [opts.team2]          - second team search term
 * @param {string} [opts.series]         - series/tournament name (alternative to teams)
 * @param {number|string} opts.startTime - match start time (epoch ms or datetime string) [REQUIRED]
 * @param {number} [opts.toleranceMs]    - max allowed |delta| when time matching (default 3h)
 * @param {number} [opts.topN]           - how many team search hits to consider (default 2)
 */
export async function findMatch({ team1, team2, series, startTime, toleranceMs = 3 * 60 * 60 * 1000, topN = 2 } = {}) {
  const parsed = parseStartTime(startTime);
  if (parsed.error) {
    return { matched: false, reason: parsed.error, invalidStartTime: true, startTime: null };
  }
  const start = parsed.ms;

  if (series) {
    return findMatchInSeries({ series, startTime: start, toleranceMs, team1, team2 });
  }

  const [r1, r2] = await Promise.all([searchCricket(team1 || ''), searchCricket(team2 || '')]);
  const cand1 = r1.filter((r) => r.category === 'Team').slice(0, topN);
  const cand2 = r2.filter((r) => r.category === 'Team').slice(0, topN);

  if (!cand1.length || !cand2.length) {
    return {
      matched: false,
      reason: !cand1.length ? 'no team results for team1' : 'no team results for team2',
      teams1: cand1.map(teamSummary),
      teams2: cand2.map(teamSummary),
      startTime: start,
    };
  }

  const comboOrder = [];
  for (let i = 0; i < cand1.length; i++) {
    for (let j = 0; j < cand2.length; j++) comboOrder.push([i, j]);
  }

  const matchCache = new Map();
  const loadMatches = async (slug) => {
    if (matchCache.has(slug)) return matchCache.get(slug);
    let data = [];
    try {
      const tm = await getTeamMatches(slug);
      data = flattenMatches(tm);
    } catch {
      data = [];
    }
    matchCache.set(slug, data);
    return data;
  };

  const attempts = [];
  let fallback = null; // closest common match seen across combos (respecting combo priority)

  for (const [i, j] of comboOrder) {
    const t1 = cand1[i];
    const t2 = cand2[j];
    const [m1, m2] = await Promise.all([loadMatches(t1.slug), loadMatches(t2.slug)]);

    const ids2 = new Map(m2.map((m) => [m.id, m]));
    const common = m1.filter((m) => ids2.has(m.id)).map((m) => {
      const other = ids2.get(m.id);
      return { ...m, otherSide: other };
    });

    const attempt = {
      combo: `${i + 1}x${j + 1}`,
      team1: teamSummary(t1),
      team2: teamSummary(t2),
      team1Matches: m1.length,
      team2Matches: m2.length,
      commonCount: common.length,
    };

    if (!common.length) {
      attempts.push(attempt);
      continue;
    }

    const ref = start;
    const withinTolerance = common.filter(
      (m) => m.timestamp && Math.abs(m.timestamp - ref) <= toleranceMs
    );
    const sameDay = common.filter((m) => m.timestamp && sameUtcDay(m.timestamp, ref));
    const byCloseness = (a, b) =>
      Math.abs((a.timestamp || 0) - ref) - Math.abs((b.timestamp || 0) - ref);
    const closest = common.filter((m) => m.timestamp).sort(byCloseness)[0] || common[0];

    let chosen = null;
    let timeDeltaMs = null;
    let timeMatchType = null;

    if (withinTolerance.length) {
      withinTolerance.sort(byCloseness);
      chosen = withinTolerance[0];
      timeDeltaMs = chosen.timestamp - ref;
      timeMatchType = timeDeltaMs === 0 ? 'exact' : 'within-tolerance';
    } else if (sameDay.length) {
      sameDay.sort(byCloseness);
      chosen = sameDay[0];
      timeDeltaMs = chosen.timestamp - ref;
      timeMatchType = 'same-day';
    }

    attempt.bestTimeMatch = chosen
      ? { id: chosen.id, timestamp: chosen.timestamp || null, deltaMs: timeDeltaMs, type: timeMatchType }
      : { id: closest.id, timestamp: closest.timestamp || null, deltaMs: closest.timestamp ? closest.timestamp - ref : null, type: 'closest' };
    attempts.push(attempt);

    // Phase 1: a real time match -> win immediately in combo priority order.
    if (chosen) {
      const candidates = common.slice().sort(byCloseness);
      return buildResult({ matched: true, t1, t2, attempts, chosen, candidates, timeDeltaMs, timeMatchType, start, strategy: attempt.combo });
    }

    // Phase 2: remember closest as fallback, but keep scanning higher-priority first.
    if (!fallback) {
      fallback = { t1, t2, chosen: closest, candidates: common.slice().sort(byCloseness), strategy: attempt.combo };
    }
  }

  // No combo had a match within tolerance -> return the closest (best-effort).
  if (fallback) {
    const delta = fallback.chosen.timestamp ? fallback.chosen.timestamp - start : null;
    return buildResult({
      matched: true,
      t1: fallback.t1,
      t2: fallback.t2,
      attempts,
      chosen: fallback.chosen,
      candidates: fallback.candidates,
      timeDeltaMs: delta,
      timeMatchType: 'closest',
      start,
      strategy: fallback.strategy,
    });
  }

  return {
    matched: false,
    reason: 'no common match found between the searched teams',
    startTime: start,
    referenceTime: start,
    timeMatch: false,
    timeMatchType: 'none',
    teams1: cand1.map(teamSummary),
    teams2: cand2.map(teamSummary),
    attempts,
  };
}

function buildResult({ t1, t2, attempts, chosen, candidates, timeDeltaMs, timeMatchType, start, strategy }) {
  const timeMatch = timeMatchType === 'exact' || timeMatchType === 'within-tolerance' || timeMatchType === 'same-day';
  const messages = {
    exact: 'Exact start-time match found within the selected teams.',
    'within-tolerance': `Closest match within the time tolerance (${Math.round(Math.abs(timeDeltaMs) / 60000)} min off).`,
    'same-day': `No match within tolerance, but a match on the same UTC day was found (${(Math.abs(timeDeltaMs) / 3600000).toFixed(1)} h off).`,
    closest: `No match within tolerance — returning the CLOSEST available fixture (${(Math.abs(timeDeltaMs || 0) / 3600000).toFixed(1)} h off).`,
  };
  return {
    matched: true,
    timeMatch,
    timeMatchType,
    note: messages[timeMatchType] || null,
    strategy,
    teams: { team1: teamSummary(t1), team2: teamSummary(t2) },
    startTime: start,
    referenceTime: start,
    timeDeltaMs,
    match: chosen,
    candidates,
    attempts,
  };
}