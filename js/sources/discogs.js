/* Discogs — session personnel.

   Discogs is collector-maintained and goes deep where MusicBrainz thins
   out: who actually played bass on a 1957 Blue Note date, which engineer
   cut it, which studio. For pre-war and jazz material especially, this is
   often the only place the sidemen are named.

   Caveat worth knowing about: Discogs' API asks callers to identify
   themselves with a custom User-Agent, and browsers refuse to let any page
   set that header. Requests from here therefore go out with Safari's own
   User-Agent and may be rejected. The diagnostics panel will tell you
   definitively; everything degrades cleanly if it is. */

import { getJSON, SourceError } from '../net.js';
import { settings, hasDiscogs } from '../config.js';

const API = 'https://api.discogs.com';

const auth = extra => new URLSearchParams({ token: settings().discogsToken, ...extra }).toString();

/* Roles that describe how the record was *made*, as opposed to how it was
   packaged. Sleeve designers are real people doing real work; they just
   aren't the connective tissue this app is drawing. */
const DROP_ROLE = /photograph|design|artwork|illustration|layout|sleeve|liner notes|cover|typography|lacquer|pressed by|distributed by|copyright|phonographic|manufactured/i;

export async function creditsForAlbum({ title, artistName, discogsUrl }) {
  if (!hasDiscogs()) return null;

  const releaseId = await resolveReleaseId({ title, artistName, discogsUrl });
  if (!releaseId) return null;

  const rel = await getJSON(`${API}/releases/${releaseId}?${auth()}`);
  if (!rel) return null;

  const credits = [];
  for (const c of rel.extraartists || []) {
    const role = cleanRole(c.role);
    if (!role || DROP_ROLE.test(role)) continue;
    credits.push({ name: (c.anv || c.name || '').replace(/\s\(\d+\)$/, ''), role });
  }
  // Main performers carry no explicit role but belong in the picture.
  for (const a of rel.artists || []) {
    const name = (a.anv || a.name || '').replace(/\s\(\d+\)$/, '');
    if (name && !credits.some(c => c.name === name)) credits.push({ name, role: 'Main artist' });
  }

  const studios = (rel.companies || [])
    .filter(c => /recorded at|mixed at|mastered at|studio/i.test(c.entity_type_name || ''))
    .map(c => ({ name: c.name, role: c.entity_type_name }));

  return {
    id: releaseId,
    url: rel.uri || `https://www.discogs.com/release/${releaseId}`,
    year: rel.year || null,
    notes: (rel.notes || '').slice(0, 600),
    credits: dedupe(credits).slice(0, 24),
    studios,
    labels: (rel.labels || []).map(l => l.name),
  };
}

async function resolveReleaseId({ title, artistName, discogsUrl }) {
  // A Discogs link already on the MusicBrainz entity is the exact match —
  // always prefer it to a fuzzy title search.
  const direct = parseDiscogsUrl(discogsUrl);
  if (direct?.type === 'release') return direct.id;
  if (direct?.type === 'master') {
    const master = await getJSON(`${API}/masters/${direct.id}?${auth()}`).catch(() => null);
    if (master?.main_release) return master.main_release;
  }

  if (!title) return null;
  const query = [artistName, title].filter(Boolean).join(' ');
  const res = await getJSON(`${API}/database/search?${auth({ q: query, type: 'release', per_page: '5' })}`)
    .catch(() => null);
  return res?.results?.[0]?.id || null;
}

function parseDiscogsUrl(url) {
  const m = String(url || '').match(/discogs\.com\/(?:[a-z]{2}\/)?(release|master)\/(\d+)/i);
  return m ? { type: m[1].toLowerCase(), id: m[2] } : null;
}

/* Discogs roles arrive as free text: "Producer [Additional]", "Bass, Vocals".
   Keep the first meaningful clause and drop the bracketed qualifiers. */
function cleanRole(role) {
  return String(role || '')
    .replace(/\[[^\]]*\]/g, '')
    .split(',')[0]
    .trim();
}

function dedupe(list) {
  const seen = new Set();
  return list.filter(c => {
    const k = `${c.name}|${c.role}`.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Used by the diagnostics panel. */
export async function ping() {
  const res = await getJSON(`${API}/database/search?${auth({ q: 'Kind of Blue', type: 'release', per_page: '1' })}`,
    { cache: false, retries: 0 });
  if (!res?.results) throw new SourceError('Discogs', 'unexpected response shape');
  return 'token accepted';
}
