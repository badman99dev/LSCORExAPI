/**
 * Utility helpers: HTTP fetch with timeouts, HTML tag stripping,
 * CREX SSR decoding and balanced JSON extraction.
 */

export async function getText(url, { headers = {}, timeout = 8000, method = 'GET', body = undefined } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, { method, headers, body, signal: ac.signal, redirect: 'follow' });
    return { ok: r.ok, status: r.status, text: await r.text() };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: e.message };
  } finally {
    clearTimeout(t);
  }
}

export async function getJson(url, opts = {}) {
  const r = await getText(url, opts);
  if (!r.ok) return { ok: false, status: r.status, data: null, error: r.error };
  try {
    return { ok: true, status: r.status, data: JSON.parse(r.text) };
  } catch (e) {
    return { ok: false, status: r.status, data: null, error: 'bad json' };
  }
}

export function decodeCrex(html) {
  if (!html) return '';
  return html
    .replace(/&q;/g, '"')
    .replace(/&l;/g, '<')
    .replace(/&g;/g, '>')
    .replace(/&s;/g, "'")
    .replace(/&a;/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function extractBalanced(text, marker) {
  const i = text.indexOf(marker);
  if (i < 0) return null;
  const start = text.indexOf('{', i + marker.length);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = start; j < text.length; j++) {
    const ch = text[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, j + 1);
    }
  }
  return null;
}

export function extractAnyBalanced(text, marker) {
  const i = text.indexOf(marker);
  if (i < 0) return null;
  let start = -1;
  for (let j = i + marker.length; j < text.length; j++) {
    if (text[j] === '{' || text[j] === '[') { start = j; break; }
  }
  if (start < 0) return null;
  const open = text[start], close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let j = start; j < text.length; j++) {
    const ch = text[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, j + 1);
    }
  }
  return null;
}

export const nnum = (v) => {
  if (v == null || v === '' || v === '--') return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
};

export const paren = (v) => {
  const m = String(v ?? '').match(/\((\d+)\)/);
  return m ? parseInt(m[1], 10) : null;
};

export const stripHtml = (s) =>
  String(s == null ? '' : s)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function normTeam(name) {
  if (!name) return '';
  const n = String(name)
    .toLowerCase()
    .replace(/\b(u19|u-19|women|w|men|a)\b/g, '')
    .replace(/[^a-z]/g, '');
  const alias = {
    ind: 'india', indiaa: 'indiaa',
    win: 'westindies', wi: 'westindies', windies: 'westindies', westindies: 'westindies',
    aus: 'australia', eng: 'england', pak: 'pakistan', sa: 'southafrica', rsa: 'southafrica',
    nz: 'newzealand', sl: 'srilanka', ban: 'bangladesh', afg: 'afghanistan', zim: 'zimbabwe',
  };
  return alias[n] || n;
}
