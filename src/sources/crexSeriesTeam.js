/**
 * CREX Series & Team Scraper & API Engine
 * Handles Points Tables, Squads, Series Fixtures, Team Overviews, and Team Fixtures
 */

import { ASSETS } from './crex.js';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const cache = new Map(); // url -> { at, data }
const CACHE_TTL_MS = 60000; // 1 minute

function decodeCrex(str) {
  if (!str) return '';
  return str
    .replace(/&q;/g, '"')
    .replace(/&a;/g, '&')
    .replace(/&s;/g, "'")
    .replace(/&l;/g, '<')
    .replace(/&g;/g, '>');
}

async function fetchCrexState(url) {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const res = await fetch(url, {
      headers: HEADERS,
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/id="app-root-state"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return null;
    const data = JSON.parse(decodeCrex(m[1]));
    cache.set(url, { at: Date.now(), data });
    return data;
  } catch (err) {
    console.error('Failed to fetch Crex state for:', url, err.message);
    return null;
  }
}

const KNOWN_SERIES = new Map([
  ['2MS', 'world-championship-of-legends-2026-2MS'],
  ['1VF', 'world-championship-of-legends-2025-1VF'],
  ['1YW', 'world-cricket-league-division-two-2018-1YW'],
  ['1YV', 'world-cricket-league-division-two-2019-1YV'],
  ['1YZ', 'world-cricket-league-division-two-2015-1YZ'],
  ['2NK', 'emirates-d10-league-2026-2NK'],
  ['2IC', 'australia-u19-tour-of-india-2026-2IC'],
  ['2N5', 'india-women-tour-of-south-africa-2026-2N5'],
  ['2I5', 'zimbabwe-women-tour-of-india-2026-2I5'],
  ['2JY', 'womens-asian-games-t20-2026-2JY'],
  ['2LH', 'womens-asia-cup-2026-2LH'],
  ['1WU', 'india-women-tour-of-england-2026-1WU'],
]);

const KNOWN_TEAMS = new Map([
  ['16', 'india-women-16'],
  ['1', 'india-1'],
  ['17', 'south-africa-women-17'],
  ['6I', 'zimbabwe-women-6I'],
  ['1J', 'sri-lanka-women-1J'],
  ['VJ', 'india-champions-VJ'],
  ['VK', 'australia-champions-VK'],
  ['VL', 'england-champions-VL'],
  ['VM', 'pakistan-champions-VM'],
  ['1L6', 'south-africa-champions-1L6'],
  ['VN', 'west-indies-champions-VN'],
]);

function resolveSeriesSlug(slugOrId) {
  if (!slugOrId) return '';
  if (slugOrId.includes('-')) return slugOrId;
  const key = slugOrId.toUpperCase();
  if (KNOWN_SERIES.has(key)) return KNOWN_SERIES.get(key);
  return slugOrId;
}

function resolveTeamSlug(slugOrId) {
  if (!slugOrId) return '';
  if (slugOrId.includes('-')) return slugOrId;
  const key = String(slugOrId);
  if (KNOWN_TEAMS.has(key)) return KNOWN_TEAMS.get(key);
  return slugOrId;
}

// --------------------------- 1. SERIES POINTS TABLE ---------------------------

export async function getSeriesPointsTable(slugOrId) {
  const slug = resolveSeriesSlug(slugOrId);
  // Try with full slug first, fallback to ID
  let state = await fetchCrexState(`https://crex.com/series/${slug}/points-table`);
  if (!state && slug !== slugOrId) {
    state = await fetchCrexState(`https://crex.com/series/${slugOrId}/points-table`);
  }
  if (!state) return null;

  const so = state['https://stats.crickapi.com/series/getSeriesOverview'] || {};
  const mapData = state['https://oc.crickapi.com/mapping/getHomeMapDataseriesmain'] || {};
  const teamList = mapData.t || [];
  const teamMap = new Map(teamList.map((t) => [t.f_key, t]));

  const ptGroups = so.i3 || [];
  const groups = [];

  for (const grp of ptGroups) {
    for (const d of grp.d || []) {
      const groupName = d.g_name || 'Points Table';
      const rows = (d.pt_info || []).map((row) => {
        const tf = row.team_fkey;
        const tInfo = teamMap.get(tf) || {};
        return {
          rank: row.rank || null,
          team: {
            code: tf,
            name: row.team_name || tInfo.n || tf,
            shortName: tInfo.sn || tf,
            logo: ASSETS.TEAM_LOGO(tf),
            colors: {
              card: tInfo.cc || null,
              primary: tInfo.uc || null,
              dark: tInfo.dc || null,
            },
          },
          played: parseInt(row.P, 10) || 0,
          won: parseInt(row.W, 10) || 0,
          lost: parseInt(row.L, 10) || 0,
          noResult: parseInt(row.NR, 10) || 0,
          points: parseInt(row.Pts, 10) || 0,
          netRunRate: row.NRR || '0.000',
          recentForm: row.rf || [],
          qualified: row.qualified === 1,
          eliminated: row.eliminated === 1,
        };
      });

      groups.push({
        groupName,
        standings: rows,
      });
    }
  }

  return {
    seriesId: slugOrId,
    slug,
    totalGroups: groups.length,
    groups,
  };
}

// --------------------------- 2. SERIES SQUADS ---------------------------

export async function getSeriesSquads(slugOrId) {
  const slug = resolveSeriesSlug(slugOrId);
  let state = await fetchCrexState(`https://crex.com/series/${slug}/team-squad`);
  if (!state && slug !== slugOrId) {
    state = await fetchCrexState(`https://crex.com/series/${slugOrId}/team-squad`);
  }
  if (!state) return null;

  const so = state['https://stats.crickapi.com/series/getSeriesOverview'] || {};
  const mapData = state['https://oc.crickapi.com/mapping/getHomeMapDataseriesmain'] || {};
  const teamList = mapData.t || [];
  const playerList = mapData.p || [];
  const playerMap = new Map(playerList.map((p) => [p.f_key, p.n]));

  // Extract squad definitions from so.i1.s
  const squadDefs = so.i1?.s || [];
  const teams = teamList.map((t) => {
    const sDef = squadDefs.find((s) => s.tf === t.f_key);
    // Find players assigned to this team
    const players = [];
    if (sDef && sDef.p) {
      for (const pStr of String(sDef.p).split('-')) {
        if (!pStr) continue;
        const [pf, roleCode, capFlag] = pStr.split('.');
        const pName = playerMap.get(pf) || pf;
        players.push({
          fkey: pf,
          name: pName,
          role: roleCode === '0' ? 'WK' : roleCode === '1' ? 'Batter' : roleCode === '2' ? 'Bowler' : 'All-Rounder',
          captain: capFlag === '1' || capFlag === 'C',
          head: ASSETS.PLAYER_HEAD(pf),
          jersey: ASSETS.JERSEY_LIMITED(t.f_key),
        });
      }
    }

    return {
      code: t.f_key,
      name: t.n,
      shortName: t.sn,
      logo: ASSETS.TEAM_LOGO(t.f_key),
      jersey: ASSETS.JERSEY_LIMITED(t.f_key),
      colors: { card: t.cc, primary: t.uc, dark: t.dc },
      playersCount: players.length,
      players,
    };
  });

  return {
    seriesId: slugOrId,
    slug,
    teamsCount: teams.length,
    teams,
  };
}

// --------------------------- 3. SERIES MATCHES ---------------------------

export async function getSeriesMatches(slugOrId) {
  const slug = resolveSeriesSlug(slugOrId);
  let state = await fetchCrexState(`https://crex.com/series/${slug}/matches`);
  if (!state && slug !== slugOrId) {
    state = await fetchCrexState(`https://crex.com/series/${slugOrId}/matches`);
  }
  if (!state) return null;

  const so = state['https://stats.crickapi.com/series/getSeriesOverview'] || {};
  const rawMatches = state['https://stats.crickapi.com/series/getMatchesForSeriesID'] || [];
  const mapData = state['https://oc.crickapi.com/mapping/getHomeMapDataseriesmatches'] ||
                  state['https://oc.crickapi.com/mapping/getHomeMapDataseriesmain'] || {};
  const teamList = mapData.t || [];
  const venueList = [...(mapData.v || []), ...(so.i6 || [])];
  const teamMap = new Map(teamList.map((t) => [t.f_key, t]));
  const venueMap = new Map(venueList.map((v) => [v.f_key, v.known_name || v.n || (v.city ? `${v.city}, ${v.country || ''}`.trim() : null)]));

  const matches = rawMatches.map((m) => {
    const t1 = teamMap.get(m.t1f) || {};
    const t2 = teamMap.get(m.t2f) || {};
    const venueName = venueMap.get(m.vf) || m.vname || null;
    const matchId = m.nf || m.mf || String(m.id || '');

    const isFinished = m.st === 27 || m.st === 3 || m.status === 2 || Boolean(m.result && !m.result.includes('Upcoming'));
    const isLive = m.st === 2 || m.status === 1;
    const status = isFinished ? 'finished' : (isLive ? 'live' : 'upcoming');
    const statusText = m.result || m.resultExtraComment || m.res || (status === 'upcoming' ? 'Scheduled' : 'Live');

    const score1 = m.s1 ? `${m.s1}${m.o1 ? ` (${m.o1} ov)` : ''}` : (m.score1 || null);
    const score2 = m.s2 ? `${m.s2}${m.o2 ? ` (${m.o2} ov)` : ''}` : (m.score2 || null);

    const winnerKey = m.w || m.winner;
    const winnerName = teamMap.get(winnerKey)?.n || (winnerKey === m.t1f ? t1.n : winnerKey === m.t2f ? t2.n : winnerKey);

    return {
      id: matchId,
      matchDesc: m.mn ? `Match ${m.mn}` : null,
      format: m.fo || (m.mt === 5 ? 'T20' : 'ODI'),
      date: m.date || null,
      timestamp: m.t || null,
      venue: venueName,
      status,
      statusText,
      winner: winnerName || null,
      teams: {
        team1: {
          code: m.t1f,
          name: t1.n || m.t1f,
          shortName: t1.sn || m.t1f,
          logo: ASSETS.TEAM_LOGO(m.t1f),
          jersey: ASSETS.JERSEY_LIMITED(m.t1f),
          score: score1,
        },
        team2: {
          code: m.t2f,
          name: t2.n || m.t2f,
          shortName: t2.sn || m.t2f,
          logo: ASSETS.TEAM_LOGO(m.t2f),
          jersey: ASSETS.JERSEY_LIMITED(m.t2f),
          score: score2,
        },
      },
      streaming: m.ifs === 'C' ? { provider: 'FanCode', image: m.fi } : null,
    };
  });

  return {
    seriesId: slugOrId,
    slug,
    count: matches.length,
    matches,
  };
}

// --------------------------- 4. TEAM OVERVIEW & BIO ---------------------------

export async function getTeamOverview(slugOrId) {
  const slug = resolveTeamSlug(slugOrId);
  let state = await fetchCrexState(`https://crex.com/team/${slug}`);
  if (!state && slug !== slugOrId) {
    state = await fetchCrexState(`https://crex.com/team/${slugOrId}`);
  }
  if (!state) return null;

  const to = state['https://stats.crickapi.com/team/getTeamOverview'] || {};
  const rawBio = state['https://stats.crickapi.com/team/getBioOfTeam'];
  const bioObj = Array.isArray(rawBio) ? rawBio[0] : (rawBio || {});
  const bioContent = bioObj.bio || bioObj.b || bioObj.content || null;

  const mapData = state['https://oc.crickapi.com/mapping/getHomeMapDatateammain'] || {};
  const tInfo = (mapData.t || [])[0] || {};
  const teamCode = tInfo.f_key || slugOrId;

  // Format recent form matches if present
  const recentForm = Array.isArray(to.rf)
    ? to.rf.map((m) => ({
        id: m.nf || m.mf || String(m.id || ''),
        format: m.fo || 'T20I',
        date: m.date || null,
        result: m.result || m.resultExtraComment || null,
        score1: m.s1 ? `${m.s1}${m.o1 ? ` (${m.o1} ov)` : ''}` : null,
        score2: m.s2 ? `${m.s2}${m.o2 ? ` (${m.o2} ov)` : ''}` : null,
        opponentCode: m.vs || (m.t1f === teamCode ? m.t2f : m.t1f),
      }))
    : [];

  return {
    id: teamCode,
    slug,
    name: tInfo.n || 'Cricket Team',
    shortName: tInfo.sn || teamCode,
    logo: ASSETS.TEAM_LOGO(teamCode),
    jersey: ASSETS.JERSEY_LIMITED(teamCode),
    colors: {
      card: tInfo.cc || null,
      primary: tInfo.uc || null,
      dark: tInfo.dc || null,
    },
    activeFrom: bioObj.active_from || null,
    ranking: to.tw || null,
    recentForm,
    trophies: to.tr || [],
    bio: bioContent,
    upcomingSeriesCount: (to.us || []).length,
    upcomingSeries: to.us || [],
  };
}

// --------------------------- 5. TEAM MATCHES ---------------------------

export async function getTeamMatches(slugOrId) {
  const slug = resolveTeamSlug(slugOrId);
  let state = await fetchCrexState(`https://crex.com/team/${slug}/matches`);
  if (!state && slug !== slugOrId) {
    state = await fetchCrexState(`https://crex.com/team/${slugOrId}/matches`);
  }
  if (!state) return null;

  const rawGroups = state['https://stats.crickapi.com/team/getMatchesForTeam'] || [];
  const mapData = state['https://oc.crickapi.com/mapping/getHomeMapDatateammatches'] ||
                  state['https://oc.crickapi.com/mapping/getHomeMapDatafixtureteam'] || {};
  const teamList = mapData.t || [];
  const seriesList = mapData.s || [];
  const venueList = mapData.v || [];

  const teamMap = new Map(teamList.map((t) => [t.f_key, t]));
  const seriesMap = new Map(seriesList.map((s) => [s.f_key, s.n]));
  const venueMap = new Map(venueList.map((v) => [v.f_key, v.n]));

  const tournaments = [];

  for (const groupObj of rawGroups) {
    for (const [sKey, mList] of Object.entries(groupObj)) {
      if (!Array.isArray(mList)) continue;
      const sName = seriesMap.get(sKey) || 'Cricket Tournament';

      const matches = mList.map((m) => {
        const t1 = teamMap.get(m.t1f) || {};
        const t2 = teamMap.get(m.t2f) || {};
        const vName = venueMap.get(m.vf) || null;
        const matchId = m.nf || m.mf || String(m.id || '');

        return {
          id: matchId,
          matchDesc: m.mn ? `Match ${m.mn}` : null,
          format: m.fo || 'T20',
          date: m.date || null,
          timestamp: m.t || null,
          venue: vName,
          status: m.st === 3 ? 'finished' : (m.st === 2 ? 'live' : 'upcoming'),
          statusText: m.res || m.result || (m.st === 1 ? 'Upcoming' : 'Scheduled'),
          teams: {
            team1: {
              code: m.t1f,
              name: t1.n || m.t1f,
              shortName: t1.sn || m.t1f,
              logo: ASSETS.TEAM_LOGO(m.t1f),
              score: m.score1 || null,
            },
            team2: {
              code: m.t2f,
              name: t2.n || m.t2f,
              shortName: t2.sn || m.t2f,
              logo: ASSETS.TEAM_LOGO(m.t2f),
              score: m.score2 || null,
            },
          },
        };
      });

      tournaments.push({
        seriesKey: sKey,
        seriesName: sName,
        matchesCount: matches.length,
        matches,
      });
    }
  }

  return {
    teamId: slugOrId,
    slug,
    tournamentsCount: tournaments.length,
    tournaments,
  };
}
