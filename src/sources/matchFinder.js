/**
 * Advanced Match Finder
 * ---------------------------------------------------------------
 * Given two team names + a match start time, figures out which
 * specific fixture the caller is talking about.
 *
 * Strategy (priority ordered):
 *   1. Search each team name -> take top N (default 2) Team results.
 *   2. For every ordered combo (1x1, 1x2, 2x1, 2x2) fetch both
 *      teams' "Team Matches & Tours" and intersect by match id.
 *   3. Within each combo, pick the common match whose start time is
 *      closest to the supplied start time (within tolerance).
 *   4. First combo (in priority order) that yields a time match wins.
 */

import { searchCricket } from './crex.js';
import { getTeamMatches } from './crexSeriesTeam.js';

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

function parseStartTime(input) {
  if (input == null || input === '') return null;
  if (typeof input === 'number' && Number.isFinite(input)) {
    return input < 1e12 ? input * 1000 : input;
  }
  const raw = String(input).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n < 1e12 ? n * 1000 : n;
  }
  const d = Date.parse(raw);
  return Number.isNaN(d) ? null : d;
}

function sameUtcDay(a, b) {
  if (!a || !b) return false;
  return Math.floor(a / 86400000) === Math.floor(b / 86400000);
}

function teamSummary(t) {
  if (!t) return null;
  return { name: t.name, slug: t.slug, code: t.id || t.teamCode || null };
}

/**
 * @param {object} opts
 * @param {string} opts.team1          - first team search term
 * @param {string} opts.team2          - second team search term
 * @param {string|number} [opts.startTime] - match start time (ISO string or epoch sec/ms)
 * @param {number} [opts.toleranceMs]  - max allowed |delta| when time matching (default 3h)
 * @param {number} [opts.topN]         - how many team search hits to consider (default 2)
 */
export async function findMatch({ team1, team2, startTime, toleranceMs = 3 * 60 * 60 * 1000, topN = 2 } = {}) {
  const start = parseStartTime(startTime);

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

    const withinTolerance = common.filter(
      (m) => m.timestamp && start != null && Math.abs(m.timestamp - start) <= toleranceMs
    );
    const sameDay = common.filter((m) => m.timestamp && start != null && sameUtcDay(m.timestamp, start));

    let chosen = null;
    let timeDeltaMs = null;

    if (withinTolerance.length) {
      withinTolerance.sort((a, b) => Math.abs(a.timestamp - start) - Math.abs(b.timestamp - start));
      chosen = withinTolerance[0];
      timeDeltaMs = chosen.timestamp - start;
    } else if (sameDay.length) {
      sameDay.sort((a, b) => Math.abs(a.timestamp - start) - Math.abs(b.timestamp - start));
      chosen = sameDay[0];
      timeDeltaMs = chosen.timestamp - start;
    } else if (start == null) {
      chosen = [...common].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0] || common[0];
      timeDeltaMs = null;
    }

    attempt.bestTimeMatch = chosen
      ? { id: chosen.id, timestamp: chosen.timestamp || null, deltaMs: timeDeltaMs }
      : null;
    attempts.push(attempt);

    if (chosen) {
      const candidates = common
        .slice()
        .sort((a, b) => (start != null
          ? Math.abs((a.timestamp || 0) - start) - Math.abs((b.timestamp || 0) - start)
          : (b.timestamp || 0) - (a.timestamp || 0)));

      return {
        matched: true,
        strategy: attempt.combo,
        teams: { team1: teamSummary(t1), team2: teamSummary(t2) },
        startTime: start,
        timeDeltaMs,
        match: chosen,
        candidates,
        attempts,
      };
    }
  }

  const hadCommon = attempts.some((a) => a.commonCount > 0);
  return {
    matched: false,
    reason: !hadCommon
      ? 'no common match found between the searched teams'
      : (start != null ? 'no common match within time tolerance' : 'no common match found'),
    startTime: start,
    teams1: cand1.map(teamSummary),
    teams2: cand2.map(teamSummary),
    attempts,
  };
}