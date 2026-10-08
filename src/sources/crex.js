/**
 * CREX Data Adapter
 *
 * Reverse-engineered live cricket endpoints:
 * - Scores: api.goscorer.com/api/v3/getLiveMatches
 * - Identity & metadata: crex.com homepage SSR blob
 * - Match detail & ball feed: crex.com/cricket-live-score/<slug> (app-root-state)
 * - Squad & Playing XI: api.goscorer.com/api/v3/getIV4?key=<CODE>
 * - Player names & team metadata: oc.crickapi.com/mapping/getHomeMapData
 * - Visual assets:
 *     Team Logo: cricketvectors.akamaized.net/Teams/<CODE>.png
 *     Player Headshot: cricketvectors.akamaized.net/players/org/<PLAYER_FKEY>.png
 *     Team Jersey: cricketvectors.akamaized.net/jersey/{limited|test}/org/<TEAM_FKEY>.png
 */

import { getText, getJson, decodeCrex, extractBalanced, extractAnyBalanced, nnum, paren, stripHtml } from '../core/util.js';
import { parseScore, parseOversStr, parseNeed } from '../core/cricket.js';

const LIVE_URL = 'https://api.goscorer.com/api/v3/getLiveMatches';
const HOME_URL = 'https://crex.com/';
const IV4_URL = 'https://api.goscorer.com/api/v3/getIV4?key=';
const MAPDATA_URL = 'https://oc.crickapi.com/mapping/getHomeMapData';

export const ASSETS = {
  TEAM_LOGO: (code) => code ? `https://cricketvectors.akamaized.net/Teams/${code}.png` : null,
  PLAYER_HEAD: (fkey) => fkey ? `https://cricketvectors.akamaized.net/players/org/${fkey}.png` : null,
  JERSEY_LIMITED: (fkey) => fkey ? `https://cricketvectors.akamaized.net/jersey/limited/org/${fkey}.png` : null,
  JERSEY_TEST: (fkey) => fkey ? `https://cricketvectors.akamaized.net/jersey/test/org/${fkey}.png` : null,
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Caches & TTLs
const HOME_TTL_MS = 60000;       // 1 min
const LIVE_TTL_MS = 1800;        // 1.8s for fast live updates
const SQUAD_TTL_MS = 600000;     // 10 mins
const SQUAD_FAIL_TTL_MS = 30000; // 30s

const teamCache = new Map();  // code -> { name, logo }
const keyMeta = new Map();    // code -> { series, desc, venue, battingTeam, slug, team1Code, team2Code }
let lastHomeAt = 0;
let homeInFlight = null;

let slugMap = null;
let slugMapAt = 0;

const liveCache = new Map();      // code -> { at, state }
const liveInflight = new Map();   // code -> Promise<state>

const squadCache = new Map();     // code -> { at, data }
const squadInflight = new Map();  // code -> Promise<data>

const ROLE_LABEL = { 0: 'WK', 1: 'Batter', 2: 'Bowler', 3: 'All-Rounder' };

export async function loadHomeNames() {
  const r = await getText(HOME_URL, {
    headers: { ...HEADERS, 'Accept-Encoding': 'br, gzip, deflate' },
    timeout: 12000,
  });
  if (!r.ok) return false;
  const txt = decodeCrex(r.text);
  const blob = extractBalanced(txt, 'api/v3/getLiveMatches":');
  if (!blob) return false;
  let data;
  try {
    data = JSON.parse(blob);
  } catch {
    return false;
  }
  let count = 0;
  for (const [key, v] of Object.entries(data)) {
    if (v.b) {
      teamCache.set(v.b, {
        name: v.team1 || v.t1Sname || null,
        shortName: v.t1Sname || null,
        logo: v.team1flag || ASSETS.TEAM_LOGO(v.b),
      });
      count++;
    }
    if (v.c) {
      teamCache.set(v.c, {
        name: v.team2 || v.t2Sname || null,
        shortName: v.t2Sname || null,
        logo: v.team2flag || ASSETS.TEAM_LOGO(v.c),
      });
      count++;
    }
    keyMeta.set(key, {
      series: v.sfullname || v.sname || v.seriesTitle || null,
      desc: v.matchNo || null,
      venue: v.vname || null,
      battingTeam: v.rate_team || null,
      slug: v.matchTitle ? `${v.matchTitle}-${key}` : null,
      team1Code: v.b || null,
      team2Code: v.c || null,
      format: v.fo || null,
    });
  }
  lastHomeAt = Date.now();
  return count > 0;
}

export async function refreshNames(force = false) {
  if (!force && Date.now() - lastHomeAt < HOME_TTL_MS && teamCache.size > 0) return;
  if (homeInFlight) return homeInFlight;
  homeInFlight = loadHomeNames().catch(() => false).finally(() => { homeInFlight = null; });
  return homeInFlight;
}

async function refreshSlugMap() {
  if (slugMap && Date.now() - slugMapAt < 120000) return;
  const r = await getText('https://crex.com/cricket-live-score', {
    headers: { ...HEADERS, 'Accept-Encoding': 'br, gzip, deflate' },
    timeout: 15000,
  });
  if (!r.ok) return;
  const txt = decodeCrex(r.text);
  const map = {};
  for (const m of txt.matchAll(/\/cricket-live-score\/([a-z0-9-]+-([A-Z0-9]{3,6}))(?=["'?\\\s])/g)) {
    map[m[2]] = m[1];
  }
  if (Object.keys(map).length) {
    slugMap = map;
    slugMapAt = Date.now();
  }
}

// --------------------------- MATCH STATE & RICH DATA ---------------------------

function findBallFeed(state) {
  for (const k of Object.keys(state)) {
    if (/commentary\/v\d+\/getBallFeeds$/.test(k)) return state[k] || [];
  }
  return [];
}

function buildRich(state, code) {
  const sv = state['https://api.goscorer.com/api/v3/getSV3'] || {};
  const meta = (state['https://stats.crickapi.com/live/getMatchMetaData'] || [])[0] || {};
  const map = state['https://oc.crickapi.com/mapping/getHomeMapDataliveparsing'] || {};
  const feed = findBallFeed(state);
  const km = keyMeta.get(code) || {};

  const isTest = /test|multi.?day|first.?class/i.test(`${km.format || sv.fo || ''}`);
  const jerseyBase = isTest ? ASSETS.JERSEY_TEST : ASSETS.JERSEY_LIMITED;

  const playerName = (fk) => (map.p || []).find((p) => p.f_key === fk)?.n || null;

  const rich = {
    venue: meta.v || km.venue || null,
    series: km.series || null,
    matchDesc: km.desc || null,
    format: km.format || sv.fo || null,
    day: sv.dy || null,
    totalDays: sv.numDays || null,
    inning: Number(sv.inning) || null,
    target: Number(sv.target) || null,
    crr: sv.crr && sv.crr !== '--' ? nnum(sv.crr) : null,
    rrr: sv.rrr && sv.rrr !== '--' ? nnum(sv.rrr) : null,
    equation: sv.tod && sv.tod !== '--' && !/nan/i.test(sv.tod) ? sv.tod : null,
    comment: sv.comment1 ? stripHtml(sv.comment1) : null,
    partnership: sv.partnerruns != null ? { runs: nnum(sv.partnerruns), balls: nnum(sv.partnerballs) } : null,
  };

  // Batting team resolution
  const newestBall = feed.find((b) => b.type === 'b' && b.pf);
  const batFkey = sv.rtKey || newestBall?.bat_team_fkey || (map.t || []).find((t) => t.n === sv.rt)?.f_key || null;
  const batTeam = (map.t || []).find((t) => t.f_key === batFkey) || null;

  if (batTeam || sv.rt) {
    rich.battingTeam = batTeam?.n || sv.rt || null;
    rich.battingTeamShort = batTeam?.sn || sv.rtShort || null;
    if (batFkey) rich.battingTeamCode = batFkey;
  }

  // Jersey resolution
  const t1f = sv.t1f || km.team1Code || null;
  const t2f = sv.t2f || km.team2Code || null;
  const jersey1 = sv.t1Jerimage || (t1f ? jerseyBase(t1f) : null);
  const jersey2 = sv.t2Jerimage || (t2f ? jerseyBase(t2f) : null);

  let batJersey = null;
  let bowlJersey = null;
  if (batFkey && batFkey === t2f) {
    batJersey = jersey2;
    bowlJersey = jersey1;
  } else if (batFkey && batFkey === t1f) {
    batJersey = jersey1;
    bowlJersey = jersey2;
  } else {
    batJersey = jersey1 || jersey2;
    bowlJersey = jersey2 || jersey1;
  }

  // Current Batters
  const mkBatter = (fkey, name, short, runs, balls, sr, fours, sixes, img) => ({
    fkey: fkey || null,
    name: name || playerName(fkey) || null,
    shortName: short || null,
    runs: nnum(runs),
    balls: paren(balls),
    strikeRate: nnum(sr),
    fours: nnum(fours),
    sixes: nnum(sixes),
    strike: false,
    head: img || ASSETS.PLAYER_HEAD(fkey),
    jersey: batJersey,
  });

  const p1 = sv.player_full_name1
    ? mkBatter(sv.p1f, sv.player_full_name1, sv.pname1, sv.run1, sv.ball1, sv.sr1, sv.four1, sv.six1, sv.b1image)
    : null;
  const p2 = sv.player_full_name2
    ? mkBatter(sv.p2f, sv.player_full_name2, sv.pname2, sv.run2, sv.ball2, sv.sr2, sv.four2, sv.six2, sv.b2image)
    : null;

  const strikeFkey = newestBall?.pf || null;
  let striker = null;
  let nonStriker = null;
  if (p1 && p2 && strikeFkey) {
    if (strikeFkey === p2.fkey) {
      p2.strike = true;
      striker = p2;
      nonStriker = p1;
    } else {
      p1.strike = true;
      striker = p1;
      nonStriker = p2;
    }
  } else {
    striker = p1 || p2 || null;
    nonStriker = (striker === p1 ? p2 : p1) || null;
  }

  rich.striker = striker;
  rich.nonStriker = nonStriker;

  // Current Bowler
  if (sv.bowler_full_name) {
    const mm = String(sv.bwr || '').match(/(\d+)\s*-\s*(\d+)/);
    rich.bowler = {
      fkey: sv.b3f || null,
      name: sv.bowler_full_name,
      shortName: sv.bname || null,
      overs: sv.bover || null,
      maidens: mm ? parseInt(mm[1], 10) : null,
      runs: mm ? parseInt(mm[2], 10) : null,
      wickets: nnum(sv.b3w) || null,
      economy: nnum(sv.beco),
      head: sv.b3image || ASSETS.PLAYER_HEAD(sv.b3f),
      jersey: bowlJersey,
    };
  }

  // Recent overs & balls
  if (Array.isArray(sv.lastovers) && sv.lastovers.length) {
    rich.lastOvers = sv.lastovers.map((o) => ({
      over: o.over,
      balls: o.overinfo,
      total: o.total,
    }));
  }

  const rb = feed.filter((b) => b.type === 'b' && b.c1);
  if (rb.length) {
    rich.recentBalls = rb.slice(0, 18).map((b) => ({
      over: b.o,
      text: b.c1,
      score: b.s,
      shot: b.shot_type && b.shot_type !== 'NA' ? b.shot_type : null,
      wagon: b.wagon_w && b.wagon_w !== 'NA' ? b.wagon_w : null,
      commentary: b.c2 ? stripHtml(b.c2) : null,
    }));
  }

  // Wickets
  const wkts = feed.filter((b) => b.type === 'w');
  if (wkts.length) {
    rich.wickets = wkts.slice(0, 10).map((w) => ({
      over: w.o || null,
      player: w.player_fullname || w.n || null,
      dismissal: w.wicketDesc || w.dismissal || null,
      runs: nnum(w.r),
      strikeRate: nnum(w.sr),
      score: w.tsl || null,
    }));
  }

  // Timeline
  const tl = feed.filter((b) => b.type === 't' && b.c);
  if (tl.length) {
    rich.timeline = tl.slice(0, 12).map((t) => ({
      text: stripHtml(t.c),
      score: t.tsl || null,
    }));
  }

  return rich;
}

async function loadPageState(code) {
  await refreshNames(false);
  const meta = keyMeta.get(code);
  let slug = meta?.slug;
  if (!slug) {
    await refreshSlugMap();
    slug = slugMap?.[code];
  }
  if (!slug) return null;

  const url = `https://crex.com/cricket-live-score/${slug}`;
  let r = await getText(url, { headers: { ...HEADERS, 'Accept-Encoding': 'br, gzip, deflate' }, timeout: 12000 });
  if (!r.ok && r.status === 403) {
    await new Promise((res) => setTimeout(res, 400));
    r = await getText(url, { headers: { ...HEADERS, 'Accept-Encoding': 'br, gzip, deflate' }, timeout: 12000 });
  }
  if (!r.ok) return null;

  const m = r.text && r.text.match(/<script id="app-root-state" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(decodeCrex(m[1]));
  } catch {
    return null;
  }
}

export async function getPageState(code) {
  const c = liveCache.get(code);
  if (c && Date.now() - c.at < LIVE_TTL_MS) return c.state;
  if (liveInflight.has(code)) return liveInflight.get(code);

  const p = loadPageState(code)
    .then((state) => {
      if (state) liveCache.set(code, { at: Date.now(), state });
      return state;
    })
    .catch(() => null)
    .finally(() => liveInflight.delete(code));

  liveInflight.set(code, p);
  return p;
}

// --------------------------- SQUAD & PLAYING XI ---------------------------

function parseXi(str, teamNo, camps, teamCode, jerseyUrl) {
  const out = [];
  if (!str) return out;
  for (const chunk of str.split('-')) {
    if (!chunk) continue;
    const p = chunk.split('.');
    const fk = p[0];
    if (!fk) continue;
    const cap = [];
    if (teamNo === 1) {
      if (fk === camps[0]) cap.push('C');
      if (fk === camps[1]) cap.push('WK');
    } else {
      if (fk === camps[2]) cap.push('C');
      if (fk === camps[3]) cap.push('WK');
    }
    const roleId = parseInt(p[2], 10);
    out.push({
      fkey: fk,
      name: null,
      role: ROLE_LABEL[roleId] || 'All-Rounder',
      roleId: isNaN(roleId) ? null : roleId,
      matches: p[1] && /^\d+$/.test(p[1]) ? parseInt(p[1], 10) : null,
      captain: cap.includes('C'),
      keeper: cap.includes('WK'),
      foreign: p[4] === '1',
      injured: p[5] === '1',
      head: ASSETS.PLAYER_HEAD(fk),
      jersey: jerseyUrl,
      teamCode: teamCode || null,
    });
  }
  return out;
}

async function resolveNames(playerFkeys, teamFkeys) {
  const players = {};
  const teams = {};
  try {
    const r = await getJson(MAPDATA_URL, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p: playerFkeys, t: teamFkeys, s: [], u: [], v: [], lc: 'en' }),
      timeout: 10000,
    });
    if (r.ok && r.data) {
      for (const p of r.data.p || []) players[p.f_key] = p.n;
      for (const t of r.data.t || []) {
        teams[t.f_key] = {
          name: t.n,
          shortName: t.sn || null,
          colors: { card: t.cc || null, primary: t.uc || null, dark: t.dc || null },
        };
      }
    }
  } catch (_) {}
  return { players, teams };
}

async function fetchSquad(code) {
  const iv = await getJson(IV4_URL + encodeURIComponent(code), { headers: HEADERS, timeout: 12000 });
  if (!iv.ok || !iv.data) return null;
  const d = iv.data;
  const teamFkeys = String(d.t || '').split('-').filter(Boolean);
  if (teamFkeys.length < 2) return null;

  const camps = String(d.x || '///').split('/');
  while (camps.length < 4) camps.push('');

  const tb = String(d.tb || '').split('/');
  const tp = String(d.tp || '').split('/');
  const isXI = tp.length >= 2 && Boolean(tp[0]) && Boolean(tp[1]);
  const src = isXI ? tp : tb;
  if (!src[0] && !src[1]) return null;

  const isTest = /test|multi.?day|first.?class/i.test(`${d.fo || ''}`);
  const jerseyBase = isTest ? ASSETS.JERSEY_TEST : ASSETS.JERSEY_LIMITED;

  const t1key = teamFkeys[0];
  const t2key = teamFkeys[1];
  const t1Jersey = jerseyBase(t1key);
  const t2Jersey = jerseyBase(t2key);

  const t1 = parseXi(src[0], 1, camps, t1key, t1Jersey);
  const t2 = parseXi(src[1], 2, camps, t2key, t2Jersey);

  const allFks = [...t1, ...t2].map((p) => p.fkey);
  const { players, teams } = await resolveNames(allFks, teamFkeys);

  for (const p of [...t1, ...t2]) p.name = players[p.fkey] || null;

  const meta = keyMeta.get(code);

  const teamObj = (key, list, jerseyUrl) => ({
    code: key,
    name: teams[key]?.name || teamCache.get(key)?.name || null,
    shortName: teams[key]?.shortName || teamCache.get(key)?.shortName || null,
    colors: teams[key]?.colors || null,
    flag: ASSETS.TEAM_LOGO(key),
    jersey: jerseyUrl,
    playersCount: list.length,
    players: list,
  });

  return {
    id: code,
    kind: isXI ? 'XI' : 'Squad',
    format: d.fo || meta?.format || null,
    venue: d.v || meta?.venue || null,
    teams: {
      team1: teamObj(t1key, t1, t1Jersey),
      team2: teamObj(t2key, t2, t2Jersey),
    },
    meta: {
      updatedAt: new Date().toISOString(),
      isXIAnnounced: isXI,
    },
  };
}

export async function squadFor(code) {
  if (!code) return null;
  const c = squadCache.get(code);
  const ttl = c && c.data ? SQUAD_TTL_MS : SQUAD_FAIL_TTL_MS;
  if (c && Date.now() - c.at < ttl) return c.data;
  if (squadInflight.has(code)) return squadInflight.get(code);

  const p = fetchSquad(code)
    .then((data) => {
      squadCache.set(code, { at: Date.now(), data });
      return data;
    })
    .catch(() => {
      squadCache.set(code, { at: Date.now(), data: null });
      return null;
    })
    .finally(() => squadInflight.delete(code));

  squadInflight.set(code, p);
  return p;
}

// --------------------------- PUBLIC EXPORTS ---------------------------

export async function getLiveMatches() {
  await refreshNames(false);
  const r = await getJson(LIVE_URL, { headers: HEADERS, timeout: 8000 });
  if (!r.ok || !r.data) return [];

  const list = [];
  for (const [code, item] of Object.entries(r.data)) {
    const km = keyMeta.get(code) || {};
    const t1Code = item.b || km.team1Code;
    const t2Code = item.c || km.team2Code;

    const t1Info = teamCache.get(t1Code) || {};
    const t2Info = teamCache.get(t2Code) || {};

    const team1 = {
      code: t1Code,
      name: t1Info.name || item.team1 || null,
      shortName: t1Info.shortName || item.t1Sname || null,
      logo: ASSETS.TEAM_LOGO(t1Code),
      jersey: ASSETS.JERSEY_LIMITED(t1Code),
      score: item.j ? parseScore(item.j) : null,
      scoreRaw: item.j || null,
    };

    const team2 = {
      code: t2Code,
      name: t2Info.name || item.team2 || null,
      shortName: t2Info.shortName || item.t2Sname || null,
      logo: ASSETS.TEAM_LOGO(t2Code),
      jersey: ASSETS.JERSEY_LIMITED(t2Code),
      score: item.k ? parseScore(item.k) : null,
      scoreRaw: item.k || null,
    };

    let status = 'live';
    if (item.mStatus === 'UPCOMING' || item.st === 'UPCOMING') status = 'upcoming';
    else if (item.mStatus === 'FINISHED' || item.st === 'FINISHED' || item.result) status = 'finished';

    list.push({
      id: code,
      series: km.series || item.sfullname || item.sname || null,
      matchDesc: km.desc || item.matchNo || null,
      venue: km.venue || item.vname || null,
      format: km.format || item.fo || null,
      status,
      statusText: item.result || item.tod || item.rem || 'Live',
      battingTeam: km.battingTeam || item.rate_team || null,
      slug: km.slug || null,
      teams: {
        team1,
        team2,
      },
      updatedAt: new Date().toISOString(),
    });
  }

  return list;
}

export async function getMatchDetail(code) {
  const state = await getPageState(code);
  if (!state) {
    // Fallback: check if we have it in live list
    const live = await getLiveMatches();
    return live.find((m) => m.id === code) || null;
  }

  const sv = state['https://api.goscorer.com/api/v3/getSV3'] || {};
  const rich = buildRich(state, code);
  const km = keyMeta.get(code) || {};

  const t1Code = sv.t1f || km.team1Code;
  const t2Code = sv.t2f || km.team2Code;
  const t1Info = teamCache.get(t1Code) || {};
  const t2Info = teamCache.get(t2Code) || {};

  const team1 = {
    code: t1Code,
    name: t1Info.name || sv.t1 || null,
    shortName: t1Info.shortName || sv.t1Short || null,
    logo: ASSETS.TEAM_LOGO(t1Code),
    jersey: ASSETS.JERSEY_LIMITED(t1Code),
    score: sv.j ? parseScore(sv.j) : null,
    scoreRaw: sv.j || null,
  };

  const team2 = {
    code: t2Code,
    name: t2Info.name || sv.t2 || null,
    shortName: t2Info.shortName || sv.t2Short || null,
    logo: ASSETS.TEAM_LOGO(t2Code),
    jersey: ASSETS.JERSEY_LIMITED(t2Code),
    score: sv.k ? parseScore(sv.k) : null,
    scoreRaw: sv.k || null,
  };

  return {
    id: code,
    series: rich.series || km.series || null,
    matchDesc: rich.matchDesc || km.desc || null,
    venue: rich.venue || km.venue || null,
    format: rich.format || km.format || null,
    status: 'live',
    statusText: sv.result || rich.equation || 'Live',
    teams: { team1, team2 },
    rich,
    updatedAt: new Date().toISOString(),
  };
}
