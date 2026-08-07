/* Shared vocabulary: node kinds, their colours, and how a relationship
   turns into a sentence a human wants to read. */

export const KIND = {
  person: { label: 'Person',  color: '#F0B429', r: 26 },
  group:  { label: 'Band',    color: '#F2704A', r: 30 },
  // Used for artists we've heard of but not yet looked up — Last.fm tells
  // us the name before MusicBrainz tells us whether it's a person or a band.
  artist: { label: 'Artist',  color: '#C99C3E', r: 24 },
  album:  { label: 'Album',   color: '#5BA9F5', r: 24 },
  track:  { label: 'Song',    color: '#4ED6A0', r: 20 },
  work:   { label: 'Work',    color: '#B98CF0', r: 20 },
  label:  { label: 'Label',   color: '#8FA3B8', r: 20 },
  place:  { label: 'Studio',  color: '#E2668E', r: 20 },
};

export const kindColor = k => (KIND[k] || KIND.work).color;
export const kindLabel = k => (KIND[k] || KIND.work).label;
export const kindRadius = k => (KIND[k] || KIND.work).r;

/* Edge kinds, ordered by how much they earn their place on screen.
   `weight` drives spring strength: the tighter the tie, the closer the
   two nodes sit. */
export const EDGE = {
  member:      { weight: 1.00, color: '#F0B429', dash: null },
  founded:     { weight: 1.00, color: '#F0B429', dash: null },
  credit:      { weight: 0.95, color: '#7E8AA0', dash: null },
  released:    { weight: 0.85, color: '#5BA9F5', dash: null },
  track:       { weight: 0.80, color: '#4ED6A0', dash: null },
  performed:   { weight: 0.75, color: '#9AA5B6', dash: null },
  produced:    { weight: 0.70, color: '#B98CF0', dash: null },
  recordedAt:  { weight: 0.65, color: '#E2668E', dash: [5, 4] },
  onLabel:     { weight: 0.55, color: '#8FA3B8', dash: [5, 4] },
  wroteWork:   { weight: 0.60, color: '#B98CF0', dash: [5, 4] },
  otherTake:   { weight: 0.55, color: '#B98CF0', dash: [2, 5] },
  collab:      { weight: 0.70, color: '#F2704A', dash: null },
  related:     { weight: 0.50, color: '#6E7A8C', dash: [2, 5] },
  similar:     { weight: 0.35, color: '#4A5568', dash: [2, 5] },
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

export function listenLinks(node) {
  const q = encodeURIComponent(node.searchTerm || node.label);
  return [
    { name: 'Apple Music', url: `https://music.apple.com/search?term=${q}` },
    { name: 'Spotify',     url: `https://open.spotify.com/search/${q}` },
    { name: 'YouTube',     url: `https://www.youtube.com/results?search_query=${q}` },
  ];
}
