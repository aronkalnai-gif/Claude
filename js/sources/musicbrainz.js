/* MusicBrainz — the backbone of the whole app.

   Other sources tell you that two artists are *similar*. MusicBrainz is the
   only free source that tells you two artists were in the same room: it
   encodes band membership with instruments and date ranges, producer and
   engineer credits, which studio a session happened in, and which label
   pressed the record. That's where the good facts live. */

import { getJSON } from '../net.js';
import { artistKind } from '../model.js';

const WS = 'https://musicbrainz.org/ws/2';

const q = params => new URLSearchParams({ fmt: 'json', ...params }).toString();

/* ── Search ─────────────────────────────────────────────────────────── */

/**
 * Search artists, albums and songs at once. MusicBrainz has no cross-entity
 * endpoint, so this is three queued requests — `onPartial` fires as each
 * one lands so the list fills in instead of making you wait for all three.
 */
export function searchAll(query, onPartial = () => {}) {
  const term = query.trim();
  if (!term) return Promise.resolve([]);

  const jobs = [
    searchArtists(term).then(r => (onPartial(r), r)),
    searchReleaseGroups(term).then(r => (onPartial(r), r)),
    searchRecordings(term).then(r => (onPartial(r), r)),
  ];

  return Promise.allSettled(jobs).then(res =>
    rankCandidates(res.flatMap(r => (r.status === 'fulfilled' ? r.value : []))));
}

export function rankCandidates(list) {
  // MusicBrainz scores are 0–100 per entity type and aren't directly
  // comparable across types, so nudge people and albums up: they're what
  // someone typing a bare name almost always means.
  const bias = { person: 6, group: 8, album: 3, track: 0 };
  return list
    .map(c => ({ ...c, rank: (c.score || 0) + (bias[c.kind] || 0) }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 12);
}

async function searchArtists(term) {
  const data = await getJSON(`${WS}/artist?${q({ query: term, limit: '6' })}`);
  return (data.artists || []).map(a => ({
    kind: artistKind(a),
    mbid: a.id,
    label: a.name,
    sublabel: [a.disambiguation, a.type, a.area?.name, lifeSpan(a)].filter(Boolean).join(' · '),
    score: a.score,
  }));
}

async function searchReleaseGroups(term) {
  const data = await getJSON(`${WS}/release-group?${q({ query: term, limit: '6' })}`);
  return (data['release-groups'] || []).map(rg => ({
    kind: 'album',
    mbid: rg.id,
    label: rg.title,
    sublabel: [credit(rg['artist-credit']), rg['primary-type'], year(rg['first-release-date'])]
      .filter(Boolean).join(' · '),
    score: rg.score,
  }));
}

async function searchRecordings(term) {
  const data = await getJSON(`${WS}/recording?${q({ query: term, limit: '6' })}`);
  return (data.recordings || []).map(rec => ({
    kind: 'track',
    mbid: rec.id,
    label: rec.title,
    sublabel: [credit(rec['artist-credit']), rec.releases?.[0]?.title].filter(Boolean).join(' · '),
    score: rec.score,
  }));
}

/* ── Lookups ────────────────────────────────────────────────────────── */

export const lookupArtist = mbid =>
  getJSON(`${WS}/artist/${mbid}?${q({ inc: 'artist-rels url-rels tags release-groups' })}`);

export const lookupReleaseGroup = mbid =>
  getJSON(`${WS}/release-group/${mbid}?${q({ inc: 'artists artist-rels url-rels tags releases' })}`);

export const lookupRecording = mbid =>
  getJSON(`${WS}/recording/${mbid}?${q({ inc: 'artists artist-rels work-rels url-rels tags releases' })}`);

/* Releases carry the details a release-group can't: the track list, the
   label, and — the good one — `place-rels`, which is how you find out a
   session happened at Sun Studio in July 1954. */
export const lookupRelease = mbid =>
  getJSON(`${WS}/release/${mbid}?${q({ inc: 'artist-credits recordings labels release-groups artist-rels place-rels url-rels' })}`);

export const lookupWork = mbid =>
  getJSON(`${WS}/work/${mbid}?${q({ inc: 'artist-rels recording-rels url-rels' })}`);

export const lookupLabel = mbid =>
  getJSON(`${WS}/label/${mbid}?${q({ inc: 'url-rels tags' })}`);

export const lookupPlace = mbid =>
  getJSON(`${WS}/place/${mbid}?${q({ inc: 'url-rels' })}`);

/** Browse: what else this label put out. */
export async function lookupLabelReleases(mbid, limit = 25) {
  const data = await getJSON(`${WS}/release?${q({ label: mbid, limit: String(limit), inc: 'artist-credits' })}`);
  return (data.releases || [])
    .slice()
    .sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')));
}

/* ── Small helpers ──────────────────────────────────────────────────── */

export function credit(artistCredit) {
  if (!Array.isArray(artistCredit)) return '';
  return artistCredit.map(c => c.name + (c.joinphrase || '')).join('');
}

export const creditArtists = ac =>
  (Array.isArray(ac) ? ac : []).map(c => c.artist).filter(Boolean);

export const year = d => (d ? String(d).slice(0, 4) : '');

function lifeSpan(a) {
  const ls = a['life-span'] || {};
  const b = year(ls.begin), e = year(ls.end);
  if (b && e) return `${b}–${e}`;
  if (b) return `b. ${b}`;
  return '';
}

/** Pull the useful external links out of a lookup's url relations. */
export function externalUrls(entity) {
  const out = {};
  for (const rel of entity?.relations || []) {
    if (rel['target-type'] !== 'url' || !rel.url?.resource) continue;
    const res = rel.url.resource;
    if (rel.type === 'wikidata' || /wikidata\.org/.test(res)) out.wikidata = res;
    else if (rel.type === 'wikipedia' || /wikipedia\.org/.test(res)) out.wikipedia = res;
    else if (/discogs\.com/.test(res)) out.discogs = res;
    else if (rel.type === 'official homepage') out.homepage = res;
  }
  return out;
}

/** Relations of a given target type, e.g. relationsOfType(artist, 'artist'). */
export const relationsOfType = (entity, targetType) =>
  (entity?.relations || []).filter(r => r['target-type'] === targetType);

/** Tags, most-voted first — a decent stand-in for genre. */
export const topTags = (entity, n = 4) =>
  (entity?.tags || [])
    .slice()
    .sort((a, b) => (b.count || 0) - (a.count || 0))
    .slice(0, n)
    .map(t => t.name);

/**
 * Pick the release that best represents a release-group: earliest dated,
 * preferring one with a country (i.e. an actual issued pressing rather than
 * a placeholder). This is the release we mine for tracks, label and studio.
 */
export function pickRepresentativeRelease(releases) {
  const list = (releases || []).filter(Boolean);
  if (!list.length) return null;
  return list.slice().sort((a, b) => {
    const ad = a.date || '9999', bd = b.date || '9999';
    if (ad !== bd) return ad < bd ? -1 : 1;
    return (b.country ? 1 : 0) - (a.country ? 1 : 0);
  })[0];
}

/** Flatten a release's media into a plain track list. */
export function tracksOf(release) {
  const out = [];
  for (const medium of release?.media || []) {
    for (const t of medium.tracks || []) {
      if (t.recording) out.push({ ...t.recording, position: t.position, trackTitle: t.title });
    }
  }
  return out;
}

const byDate = (a, b) =>
  String(a['first-release-date'] || '9999').localeCompare(String(b['first-release-date'] || '9999'));

/** Records worth showing for an artist: proper albums and EPs, oldest first. */
export function notableAlbums(artist, n = 4) {
  const rank = rg => {
    if ((rg['secondary-types'] || []).length) return 3;   // compilations, live, remixes
    if (rg['primary-type'] === 'Album') return 0;
    if (rg['primary-type'] === 'EP') return 1;
    return 2;
  };
  return (artist['release-groups'] || [])
    .filter(rg => /^(Album|EP)$/.test(rg['primary-type'] || ''))
    .slice()
    .sort((a, b) => rank(a) - rank(b) || byDate(a, b))
    .slice(0, n);
}

/**
 * Singles. A single's title is the song's title, so these are the artist's
 * songs by any listener's definition — and unlike a tracklist they cost no
 * extra request, because the artist lookup already carries them.
 */
export function notableSingles(artist, n = 4) {
  return (artist['release-groups'] || [])
    .filter(rg => rg['primary-type'] === 'Single' && !(rg['secondary-types'] || []).length)
    .slice()
    .sort(byDate)
    .slice(0, n);
}
