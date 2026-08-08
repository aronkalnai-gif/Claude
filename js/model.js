/* Shared vocabulary: node kinds, their colours, and how a relationship
   turns into a sentence a human wants to read. */

/* The single source of truth for the palette, shared by the CSS and the
   canvas. Pigments from a naturalist's plate rather than a screen: they
   have to sit on warm paper without shouting, and stay distinguishable
   from each other at the size of a fingernail. */
export const THEME = {
  paper:      '#F7F1E3',
  paperDeep:  '#F1E7D3',
  ink:        '#1F1D18',
  inkSoft:    '#3B4A3D',
  inkDim:     '#77705F',
  rule:       '#D9CBAE',
  rust:       '#C4603F',
};

export const KIND = {
  person: { label: 'Person',  color: '#B4832C', r: 26 },
  group:  { label: 'Band',    color: '#C4603F', r: 30 },
  // Used for artists we've heard of but not yet looked up — Last.fm tells
  // us the name before MusicBrainz tells us whether it's a person or a band.
  artist: { label: 'Artist',  color: '#A07A3C', r: 24 },
  album:  { label: 'Album',   color: '#3E6B80', r: 24 },
  track:  { label: 'Song',    color: '#4A7A4E', r: 21 },
  work:   { label: 'Work',    color: '#7A4C6B', r: 20 },
  label:  { label: 'Label',   color: '#6B7566', r: 20 },
  place:  { label: 'Studio',  color: '#A34E58', r: 20 },
};

export const kindColor = k => (KIND[k] || KIND.work).color;
export const kindLabel = k => (KIND[k] || KIND.work).label;
export const kindRadius = k => (KIND[k] || KIND.work).r;

/* Edge kinds, ordered by how much they earn their place on screen.
   `weight` drives spring strength: the tighter the tie, the closer the
   two nodes sit. */
export const EDGE = {
  member:      { weight: 1.00, color: '#B4832C', dash: null },
  founded:     { weight: 1.00, color: '#B4832C', dash: null },
  credit:      { weight: 0.95, color: '#8A7B5E', dash: null },
  released:    { weight: 0.85, color: '#3E6B80', dash: null },
  track:       { weight: 0.80, color: '#4A7A4E', dash: null },
  performed:   { weight: 0.75, color: '#7E8A72', dash: null },
  produced:    { weight: 0.70, color: '#7A4C6B', dash: null },
  recordedAt:  { weight: 0.65, color: '#A34E58', dash: [5, 4] },
  onLabel:     { weight: 0.55, color: '#6B7566', dash: [5, 4] },
  wroteWork:   { weight: 0.60, color: '#7A4C6B', dash: [5, 4] },
  otherTake:   { weight: 0.55, color: '#7A4C6B', dash: [2, 5] },
  collab:      { weight: 0.70, color: '#C4603F', dash: null },
  related:     { weight: 0.50, color: '#8A8370', dash: [2, 5] },
  style:       { weight: 0.40, color: '#8A7B5E', dash: [3, 4] },
};

export const edgeStyle = k => EDGE[k] || EDGE.related;

/* MusicBrainz gives dates as YYYY, YYYY-MM or YYYY-MM-DD. Render only as
   much precision as we actually have — "1926" beats "1926-01-01" when the
   day was never known. */
export function fmtDate(d) {
  if (!d) return '';
  const [y, m, day] = String(d).split('-');
  if (!y) return '';
  if (!m) return y;
  const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m - 1] || '';
  return day ? `${+day} ${month} ${y}` : `${month} ${y}`;
}

export function fmtRange(begin, end, ended) {
  const b = fmtDate(begin), e = fmtDate(end);
  if (b && e) return `${b} – ${e}`;
  if (b) return ended ? `from ${b}` : `since ${b}`;
  if (e) return `until ${e}`;
  return '';
}

/* Turn a MusicBrainz relation into readable prose. Returns the phrase
   without the other party's name — the caller supplies that, so the name
   can be a tappable link. */
export function describeRelation(rel, { asSubject = true } = {}) {
  const type = rel.type || '';
  const attrs = (rel.attributes || []).filter(a => a !== 'original');

  // Sessions happen on a date; memberships run over one. "Recorded at
  // Sun Studio · since July 1954" reads as nonsense, so events that are
  // points in time get a bare date instead of an open-ended range.
  const pointInTime = /^(recorded|mixed|engineered|mastered) (at|in)$/.test(type);
  const range = pointInTime
    ? (rel.begin && rel.end && rel.begin !== rel.end
        ? fmtRange(rel.begin, rel.end, true)
        : fmtDate(rel.begin || rel.end))
    : fmtRange(rel.begin, rel.end, rel.ended);
  const instruments = attrs.filter(a => !/^(guest|additional|original|founder|lead|solo)$/i.test(a));
  const roleWord = instruments.length ? instruments.join(', ') : null;
  const founder = (rel.attributes || []).some(a => /founder/i.test(a));

  let phrase;
  switch (type) {
    case 'member of band':
      // Keep the instrument even when they founded the band — "co-founded
      // and played guitar in" is the fact worth having, and dropping the
      // instrument to say "co-founded" throws away the better half of it.
      if (founder) phrase = roleWord ? `co-founded and played ${roleWord} in` : 'co-founded';
      else phrase = roleWord ? `played ${roleWord} in` : 'was a member of';
      break;
    case 'collaboration':      phrase = 'collaborated with'; break;
    case 'founder':            phrase = 'founded'; break;
    case 'subgroup':           phrase = 'is a splinter of'; break;
    case 'supporting musician':phrase = roleWord ? `backed on ${roleWord}` : 'was a supporting musician for'; break;
    case 'teacher':            phrase = 'taught'; break;
    case 'sibling':            phrase = 'is a sibling of'; break;
    case 'parent':             phrase = 'is a parent of'; break;
    case 'married':            phrase = 'was married to'; break;
    case 'involved with':      phrase = 'was involved with'; break;
    case 'is person':          phrase = 'is also known as'; break;
    case 'tribute':            phrase = 'pays tribute to'; break;
    case 'conductor position': phrase = 'conducted'; break;
    case 'artistic director':  phrase = 'was artistic director of'; break;
    case 'producer':           phrase = 'produced'; break;
    case 'engineer':           phrase = 'engineered'; break;
    case 'mix':                phrase = 'mixed'; break;
    case 'recording engineer': phrase = 'engineered the recording of'; break;
    case 'mastering':          phrase = 'mastered'; break;
    case 'vocal':              phrase = roleWord ? `sang ${roleWord} on` : 'sang on'; break;
    case 'instrument':         phrase = roleWord ? `played ${roleWord} on` : 'played on'; break;
    case 'performer':          phrase = 'performed on'; break;
    case 'performance':        phrase = 'is a recording of'; break;
    case 'composer':           phrase = 'composed'; break;
    case 'lyricist':           phrase = 'wrote the lyrics for'; break;
    case 'writer':             phrase = 'wrote'; break;
    case 'arranger':           phrase = 'arranged'; break;
    case 'recorded at':        phrase = 'was recorded at'; break;
    case 'recorded in':        phrase = 'was recorded in'; break;
    case 'mixed at':           phrase = 'was mixed at'; break;
    case 'engineered at':      phrase = 'was engineered at'; break;
    default:                   phrase = type || 'is connected to';
  }
  return range ? `${phrase} · ${range}` : phrase;
}

/* Map a MusicBrainz artist type onto our two people-shaped node kinds. */
export const artistKind = a =>
  (a && /group|orchestra|choir/i.test(a.type || '')) ? 'group' : 'person';

/* ── Placeholders ───────────────────────────────────────────────────── */

/* MusicBrainz keeps a handful of "special purpose" entities that stand in
   for the absence of an artist rather than naming one: a compilation is
   credited to Various Artists, an untitled field recording to [unknown], a
   spoken interlude to [dialogue]. They are bookkeeping, and they are poison
   for a relationship graph — Various Artists alone stands in for hundreds
   of thousands of compilations, so opening it connects Elvis Presley to
   Madonna to Bruce Springsteen by way of nothing at all.

   The ids are a belt; the naming convention is the braces, and the one that
   actually catches them all. Square brackets are reserved for these stubs —
   with the notable exception of the ska band [spunge], which is why a name
   in brackets only counts as a placeholder when MusicBrainz hasn't typed it
   as a group. Album and song titles are left alone: brackets are ordinary
   punctuation in a title. */
const SPECIAL_MBID = new Set([
  '89ad4ac3-39f7-470e-963a-56509c546377',   // Various Artists
  '125ec42a-7229-4250-afc5-e057484327fe',   // [unknown]
  'eec63d3c-3b81-4ad4-b1e4-7c147d4d2b61',   // [no artist]
  '9be7f096-97ec-4615-8957-8d40b5dcbc41',   // [traditional]
  'f731ccc4-e22a-43af-a747-64213329e088',   // [anonymous]
  '33cf029c-63b0-41a0-9855-be2a3665fb3b',   // [data]
  'a0ef7e1d-44ff-4039-9435-7d5fefdeecc9',   // [dialogue]
  '157afde4-4bf5-4039-8ad2-5a15acc85176',   // [no label]
]);

const STUB_KINDS = new Set(['person', 'artist', 'label', 'place']);

/** True for anything that names an absence rather than a thing. */
export function isPlaceholder({ kind, label, mbid } = {}) {
  if (mbid && SPECIAL_MBID.has(mbid)) return true;
  const name = String(label || '').trim();
  if (/^various artists$/i.test(name)) return true;
  return STUB_KINDS.has(kind) && /^\[.+\]$/.test(name);
}

export function listenLinks(node) {
  const q = encodeURIComponent(node.searchTerm || node.label);
  return [
    { name: 'Apple Music', url: `https://music.apple.com/search?term=${q}` },
    { name: 'Spotify',     url: `https://open.spotify.com/search/${q}` },
    { name: 'YouTube',     url: `https://www.youtube.com/results?search_query=${q}` },
  ];
}
