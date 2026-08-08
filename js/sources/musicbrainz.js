/* MusicBrainz — the backbone of the whole app.

   Other sources tell you that two artists are *similar*. MusicBrainz is the
   only free source that tells you two artists were in the same room: it
   encodes band membership with instruments and date ranges, producer and
   engineer credits, which studio a session happened in, and which label
   pressed the record. That's where the good facts live. */

import { getJSON } from '../net.js';
import { artistKind, isPlaceholder } from '../model.js';

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

  // Filtered here as well as in rankCandidates, because `onPartial` shows
  // its list before the ranking runs — otherwise "Various Artists" would
  // flash up in the results and then vanish.
  const drop = list => list.filter(c => !isPlaceholder(c));

  const jobs = [
    searchArtists(term).then(drop).then(r => (onPartial(r), r)),
    searchReleaseGroups(term).then(drop).then(r => (onPartial(r), r)),
    searchRecordings(term).then(drop).then(r => (onPartial(r), r)),
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
    .filter(c => !isPlaceholder(c))
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
  getJSON(`${WS}/artist/${mbid}?${q({ inc: 'artist-rels url-rels tags genres release-groups' })}`);

export const lookupReleaseGroup = mbid =>
  getJSON(`${WS}/release-group/${mbid}?${q({ inc: 'artists artist-rels url-rels tags genres releases' })}`);

export const lookupRecording = mbid =>
  getJSON(`${WS}/recording/${mbid}?${q({ inc: 'artists artist-rels work-rels url-rels tags genres releases' })}`);

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
    // Their own channel, which is what makes a concert video trustworthy.
    else if (/youtube\.com\/(channel|user|c)\/|youtube\.com\/@/.test(res)) out.youtube = res;
    else if (rel.type === 'official homepage') out.homepage = res;
  }
  return out;
}

/* Where you can actually hear it.

   MusicBrainz stores the streaming pages themselves as url relations, which
   beats guessing: a link to an artist's Spotify page is a fact somebody
   entered, where a search URL is a hope. Matched on the host rather than on
   the relation type, because the same page arrives as "free streaming",
   "streaming" or "youtube" depending on who added it. */
const SERVICES = [
  { name: 'Apple Music', test: /(^|\/\/)(music|itunes)\.apple\.com\// },
  { name: 'Spotify',     test: /open\.spotify\.com\// },
  { name: 'YouTube',     test: /(music\.)?youtube\.com\/|youtu\.be\// },
  { name: 'Bandcamp',    test: /\.bandcamp\.com/ },
  { name: 'SoundCloud',  test: /soundcloud\.com\// },
];

/** Direct links to this entity on services that carry it. */
export function streamingUrls(entity) {
  const out = [], seen = new Set();
  for (const rel of entity?.relations || []) {
    if (rel['target-type'] !== 'url' || !rel.url?.resource) continue;
    const res = rel.url.resource;
    const svc = SERVICES.find(s => s.test.test(res));
    if (!svc || seen.has(svc.name)) continue;
    seen.add(svc.name);
    out.push({ name: svc.name, url: res, direct: true });
  }
  return out.sort((a, b) =>
    SERVICES.findIndex(s => s.name === a.name) - SERVICES.findIndex(s => s.name === b.name));
}

/**
 * Is there anything at all credited to this artist?
 *
 * The last word on whether a person has music, for the cases the artist
 * lookup can't settle: a session player releases nothing under their own
 * name but appears on plenty of recordings, while a sleeve photographer
 * appears on none. One request, and `limit=1` keeps it to a yes or no.
 */
export async function hasRecordings(mbid) {
  const data = await getJSON(`${WS}/recording?${q({ artist: mbid, limit: '1' })}`);
  return (data['recording-count'] ?? (data.recordings || []).length) > 0;
}

/** Relations of a given target type, e.g. relationsOfType(artist, 'artist'). */
export const relationsOfType = (entity, targetType) =>
  (entity?.relations || []).filter(r => r['target-type'] === targetType);

/* MusicBrainz runs two tagging systems on the same entity. `tags` are
   unmoderated folksonomy — anyone can add one, so coverage is wide and
   quality is uneven. `genres` are the same mechanism restricted to a
   fixed, moderated vocabulary: a genre called "afrobeat" was vouched for
   as an actual genre, where a tag by that name might mean anything.
   Preferring the genre when both exist is free precision for the same
   word, so the two are merged once here rather than read separately by
   every caller. */
function folksonomy(entity) {
  const out = new Map();
  for (const g of entity?.genres || []) {
    if (!g?.name) continue;
    out.set(g.name.toLowerCase().trim(), { name: g.name, count: g.count || 0, curated: true });
  }
  for (const t of entity?.tags || []) {
    if (!t?.name) continue;
    const key = t.name.toLowerCase().trim();
    if (out.has(key)) continue;   // the curated genre already covers this word
    out.set(key, { name: t.name, count: t.count || 0, curated: false });
  }
  return [...out.values()];
}

/** Tags and genres, most-voted first with genres given first refusal — a
    decent stand-in for style. */
export const topTags = (entity, n = 4) =>
  folksonomy(entity)
    .sort((a, b) => (b.curated - a.curated) || (b.count || 0) - (a.count || 0))
    .slice(0, n)
    .map(t => t.name);

/* Tags that describe a shelf rather than a sound. "Rock" is true of tens of
   thousands of artists and tells you nothing about why two of them belong
   near each other; "hard bop" or "psychedelic folk" is a real stylistic
   claim. The rest are the housekeeping labels people attach to their own
   listening, which aren't about the music at all. */
const BROAD_TAG = new Set([
  'rock', 'pop', 'jazz', 'classical', 'folk', 'metal', 'electronic', 'electronica',
  'hip hop', 'hip-hop', 'rap', 'country', 'blues', 'dance', 'soul', 'funk', 'punk',
  'indie', 'alternative', 'alternative rock', 'experimental', 'world', 'ambient',
  'reggae', 'r&b', 'rnb', 'soundtrack', 'instrumental', 'singer-songwriter',
  'male vocalists', 'female vocalists', 'seen live', 'favorites', 'favourites',
  'british', 'american', 'english', 'usa', 'uk', 'german', 'french', 'japanese',
  'swedish', 'canadian', 'australian', 'irish', 'live', 'other', 'various',
  '50s', '60s', '70s', '80s', '90s', '00s', '10s', '20s',
]);

/**
 * The tags that actually describe how something sounds, best first.
 *
 * Ranked by how much they narrow the field rather than by raw votes: a
 * two-word tag is nearly always a genuine sub-genre, and a broad shelf
 * label only survives if nothing better is on offer.
 */
export function styleTags(entity, n = 3) {
  const scored = folksonomy(entity).map(t => {
    const name = t.name.toLowerCase().trim();
    const broad = BROAD_TAG.has(name);
    const words = name.split(/[\s-]+/).length;
    return {
      name: t.name,
      score: (broad ? -1000 : 0) + (t.count || 0) * 2 + (words > 1 ? 12 : 0) + (t.curated ? 20 : 0),
    };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, n).map(t => t.name);
}

/**
 * Other artists working in a given style.
 *
 * MusicBrainz's search index accepts a Lucene `tag:` term, which means
 * stylistic kinship needs no API key at all — it's the same free source as
 * everything else on the backbone.
 */
export async function artistsByTag(tag, limit = 8) {
  const data = await getJSON(`${WS}/artist?${q({ query: `tag:"${tag}"`, limit: String(limit) })}`);
  return (data.artists || []).map(a => ({
    id: a.id, name: a.name, type: a.type,
    disambiguation: a.disambiguation || '',
    score: a.score || 0,
  }));
}

/** Other recordings in a given style. */
export async function recordingsByTag(tag, limit = 10) {
  const data = await getJSON(`${WS}/recording?${q({ query: `tag:"${tag}"`, limit: String(limit) })}`);
  return (data.recordings || []).map(r => ({
    id: r.id, title: r.title,
    artist: credit(r['artist-credit']),
    // Kept so callers can tell a stranger's record from one by the artist
    // they're already looking at.
    artistIds: (r['artist-credit'] || []).map(c => c.artist?.id).filter(Boolean),
    score: r.score || 0,
  }));
}

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
