/* The one place that talks to the network.

   Three jobs, all of which matter more than they look:
     · Per-host throttling. MusicBrainz asks for one request per second and
       enforces it with 503s; exceeding it is the fastest way to get a
       broken-looking app.
     · Caching. Expanding a node you've already visited should be instant
       and free, and the same lookups recur constantly as a web grows.
     · Honest errors. When a source fails we want to know which one and
       why, because that's what the diagnostics panel reports. */

const HOST_RULES = [
  { match: /musicbrainz\.org/,       minGap: 1100, label: 'MusicBrainz' },
  { match: /coverartarchive\.org/,   minGap: 250,  label: 'Cover Art Archive' },
  { match: /audioscrobbler\.com/,    minGap: 220,  label: 'Last.fm' },
  { match: /api\.discogs\.com/,      minGap: 1100, label: 'Discogs' },
  { match: /wikipedia\.org|wikidata/, minGap: 120, label: 'Wikipedia' },
  { match: /api\.anthropic\.com/,    minGap: 0,    label: 'Anthropic' },
];

const ruleFor = url => HOST_RULES.find(r => r.match.test(url)) || { minGap: 200, label: 'network' };

/* ── Per-host serial queues ─────────────────────────────────────────── */

const queues = new Map();   // label -> { last: ms, chain: Promise }

function schedule(label, minGap, task) {
  let q = queues.get(label);
  if (!q) { q = { last: 0, chain: Promise.resolve() }; queues.set(label, q); }

  const run = async () => {
    const wait = Math.max(0, q.last + minGap - Date.now());
    if (wait > 0) await sleep(wait);
    q.last = Date.now();
    return task();
  };

  // Chain so requests to the same host never overlap, and make sure one
  // failure doesn't poison the queue for everything behind it.
  const result = q.chain.then(run, run);
  q.chain = result.then(() => {}, () => {});
  return result;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── Cache ──────────────────────────────────────────────────────────── */

const CACHE_KEY = 'odyssey.cache.v1';
const CACHE_TTL = 1000 * 60 * 60 * 24 * 14;   // a fortnight; this data barely moves
const CACHE_MAX = 600;

const mem = new Map();
let persisted = null;
let flushTimer = null;

function loadPersisted() {
  if (persisted) return persisted;
  try { persisted = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); }
  catch { persisted = {}; }
  return persisted;
}

function flushSoon() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const store = loadPersisted();
    // Trim oldest first so localStorage never becomes the reason the app breaks.
    const keys = Object.keys(store);
    if (keys.length > CACHE_MAX) {
      keys.sort((a, b) => store[a].t - store[b].t)
          .slice(0, keys.length - CACHE_MAX)
          .forEach(k => delete store[k]);
    }
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(store)); }
    catch { /* quota — drop the persistent layer, memory cache still works */
      try { localStorage.removeItem(CACHE_KEY); persisted = {}; } catch {}
    }
  }, 1500);
}

function cacheGet(key) {
  if (mem.has(key)) return mem.get(key);
  const rec = loadPersisted()[key];
  if (rec && Date.now() - rec.t < CACHE_TTL) { mem.set(key, rec.v); return rec.v; }
  return undefined;
}

function cacheSet(key, value) {
  mem.set(key, value);
  loadPersisted()[key] = { t: Date.now(), v: value };
  flushSoon();
}

export function clearCache() {
  mem.clear();
  persisted = {};
  try { localStorage.removeItem(CACHE_KEY); } catch {}
}

export function cacheSize() {
  return Object.keys(loadPersisted()).length;
}

/* ── The fetch itself ───────────────────────────────────────────────── */

export class SourceError extends Error {
  constructor(source, message, { status = 0, cause } = {}) {
    super(message);
    this.name = 'SourceError';
    this.source = source;
    this.status = status;
    this.cause = cause;
  }
}

const inflight = new Map();

/**
 * GET JSON with throttling, caching and retry.
 * @param {string} url
 * @param {{cache?: boolean, headers?: object, retries?: number, timeout?: number}} opts
 */
export function getJSON(url, opts = {}) {
  const { cache = true, headers = {}, retries = 2, timeout = 20000 } = opts;
  const rule = ruleFor(url);

  if (cache) {
    const hit = cacheGet(url);
    if (hit !== undefined) return Promise.resolve(hit);
    // Collapse duplicate concurrent lookups — very common while a graph expands.
    if (inflight.has(url)) return inflight.get(url);
  }

  const job = schedule(rule.label, rule.minGap, async () => {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(700 * Math.pow(2, attempt - 1));
      try {
        const data = await rawJSON(url, { headers, timeout, source: rule.label });
        if (cache) cacheSet(url, data);
        return data;
      } catch (err) {
        lastErr = err;
        // 4xx other than 429 won't get better by asking again.
        if (err.status >= 400 && err.status < 500 && err.status !== 429) break;
      }
    }
    throw lastErr;
  }).finally(() => inflight.delete(url));

  if (cache) inflight.set(url, job);
  return job;
}

async function rawJSON(url, { headers, timeout, source }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetch(url, { headers, signal: ctl.signal, mode: 'cors' });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new SourceError(source, `timed out after ${timeout / 1000}s`);
    // A network-level TypeError from fetch is almost always CORS or offline,
    // and the browser deliberately won't tell us which. Say so plainly.
    throw new SourceError(source, 'network or CORS failure (the browser blocked the response)', { cause: err });
  }
  clearTimeout(timer);

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch {}
    throw new SourceError(source, `HTTP ${res.status}${detail ? ` — ${detail}` : ''}`, { status: res.status });
  }
  try { return await res.json(); }
  catch (err) { throw new SourceError(source, 'response was not valid JSON', { cause: err }); }
}

/** POST JSON — used only by the Anthropic call. */
export async function postJSON(url, body, { headers = {}, timeout = 60000 } = {}) {
  const rule = ruleFor(url);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctl.signal,
      mode: 'cors',
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new SourceError(rule.label, `timed out after ${timeout / 1000}s`);
    throw new SourceError(rule.label, 'network or CORS failure', { cause: err });
  }
  clearTimeout(timer);

  const text = await res.text();
  if (!res.ok) throw new SourceError(rule.label, `HTTP ${res.status} — ${text.slice(0, 300)}`, { status: res.status });
  try { return JSON.parse(text); }
  catch (err) { throw new SourceError(rule.label, 'response was not valid JSON', { cause: err }); }
}
