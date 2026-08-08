/* YouTube — the performances.

   A record tells you what an artist made; a great concert tells you what
   they were. But YouTube is mostly fan recordings of both, and a phone
   held up in a crowd in 2011 is not what anyone means by "watch this".

   So nothing here trusts a search result on its own. A video has to come
   from a channel we can name — the artist's own, resolved from the link
   MusicBrainz already stores, or one of a curated list of festivals and
   broadcasters — and it has to look like a performance rather than a
   trailer, an interview or a lyric video. What survives that is a
   candidate, not an answer: which of them are actually worth watching is
   a judgement, and it's made in llm.js, or by view count when there's no
   key to make it with.

   Quota: search costs 100 units of the 10,000 a free key gets per day, so
   this is one search per artist and one batched details call. Roughly a
   hundred artists a day, and the fortnight-long cache means revisiting
   costs nothing. */

import { getJSON } from '../net.js';
import { settings, hasYouTube } from '../config.js';

const API = 'https://www.googleapis.com/youtube/v3';

/* Festivals, broadcasters and sessions that publish their own footage.
   Matched on the exact channel title, normalised — a substring rule would
   let "Glastonbury Highlights 2011" through, which is precisely the fan
   upload this is meant to keep out. Nothing here is a guess about quality;
   it's a list of people who own what they post. */
const TRUSTED = new Set([
  // Sessions and broadcasters
  'npr music', 'kexp', 'bbc music', 'bbc radio 1', 'bbc radio 6 music',
  'arte concert', 'rockpalast', 'wdr rockpalast', 'austin city limits',
  'audiotree', 'la blogotheque', 'the late show with stephen colbert',
  'jimmy kimmel live', 'the tonight show starring jimmy fallon',
  'saturday night live', 'triple j', 'radio france', 'srf 3', 'nrk p3',
  'seattle kexp', 'paste magazine', 'sofar sounds', 'colors',
  'jazz at lincoln center', 'the current', 'opb music', 'cbc music',
  // Festivals
  'glastonbury festival', 'montreux jazz festival', 'coachella',
  'lollapalooza', 'primavera sound', 'roskilde festival', 'sziget festival',
  'rock am ring und rock im park', 'reading and leeds festival',
  'newport folk festival', 'newport jazz festival', 'north sea jazz festival',
  'sxsw', 'pitchfork', 'boiler room', 'red bull music', 'tiny desk',
  'live aid', 'woodstock', 'pinkpop', 'lowlands', 'exit festival',
  'melt festival', 'hurricane festival', 'openair st gallen',
]);

const norm = s => String(s || '')
  .toLowerCase()
  .replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/* A channel an artist's own label runs for them. VEVO is the one naming
   convention on YouTube that reliably means "not a fan". */
const isVevo = title => /\bvevo$/i.test(String(title || '').trim());

/* Titles that describe a performance. A video has to say it is one — the
   alternative is trusting that anything on a festival's channel is a set,
   and festivals post trailers and aftermovies too. */
const PERFORMANCE = /\b(live|concert|full set|full show|in concert|unplugged|session|sessions|acoustic|festival|tiny desk|boiler room|rockpalast|performance|performs|playing)\b/i;

const NOT_A_PERFORMANCE = /\b(trailer|teaser|aftermovie|after movie|interview|documentary|announcement|recap|highlights|behind the scenes|making of|reaction|lyric video|official (music )?video|audio only|visualizer|full album|track by track|snippet|preview|q&a)\b/i;

/* Under this it's a clip, not a performance. Tiny Desk runs about fifteen
   minutes; a single song from a festival broadcast runs four or five. */
const MIN_SECONDS = 240;

/* ── Public ─────────────────────────────────────────────────────────── */

/**
 * Candidate concert videos for an artist, already filtered to sources we
 * can name. Judgement about which are worth watching happens elsewhere.
 *
 * @param {string} name        the artist, as people would search for them
 * @param {string|null} ownChannelId  their channel, if MusicBrainz knows it
 * @returns {Promise<Array>} newest-quality-first candidates
 */
export async function concertsFor(name, ownChannelId = null) {
  if (!hasYouTube() || !name) return [];

  const found = await search(`${name} live`);
  if (!found.length) return [];

  const trusted = found.filter(v =>
    (ownChannelId && v.channelId === ownChannelId) ||
    TRUSTED.has(norm(v.channelTitle)) ||
    isVevo(v.channelTitle));

  if (!trusted.length) return [];

  const detailed = await details(trusted.map(v => v.id));
  return trusted
    .map(v => ({ ...v, ...(detailed.get(v.id) || {}) }))
    .filter(v => v.seconds >= MIN_SECONDS)
    .filter(v => PERFORMANCE.test(v.title) && !NOT_A_PERFORMANCE.test(v.title))
    .sort((a, b) => (b.views || 0) - (a.views || 0));
}

/**
 * Turn the YouTube link MusicBrainz stores into a channel id.
 *
 * Worth the extra request: it's the difference between "a channel called
 * Radiohead" and "the channel Radiohead's own entry points at".
 */
export async function channelIdFor(url) {
  if (!hasYouTube() || !url) return null;
  const u = String(url);

  const direct = u.match(/youtube\.com\/channel\/(UC[\w-]+)/);
  if (direct) return direct[1];

  const handle = u.match(/youtube\.com\/@([\w.-]+)/);
  const user = u.match(/youtube\.com\/user\/([\w-]+)/);
  if (!handle && !user) return null;      // /c/name has no API lookup

  try {
    const params = handle ? { forHandle: `@${handle[1]}` } : { forUsername: user[1] };
    const data = await getJSON(`${API}/channels?${qs({ part: 'id', ...params })}`);
    return data?.items?.[0]?.id || null;
  } catch {
    return null;
  }
}

/** Used by the diagnostics panel. */
export async function ping() {
  const data = await getJSON(`${API}/search?${qs({
    part: 'snippet', type: 'video', maxResults: '1', q: 'kexp live',
  })}`, { cache: false, retries: 1 });
  const n = data?.pageInfo?.totalResults;
  return n ? 'key accepted, search responding' : 'key accepted (no results)';
}

/* ── Internals ──────────────────────────────────────────────────────── */

const qs = params => new URLSearchParams({ ...params, key: settings().youtubeKey }).toString();

async function search(q) {
  const data = await getJSON(`${API}/search?${qs({
    part: 'snippet',
    type: 'video',
    videoEmbeddable: 'true',
    maxResults: '50',        // same quota cost as 5; take the bigger pool
    order: 'relevance',
    q,
  })}`);

  return (data.items || [])
    .filter(i => i.id?.videoId)
    .map(i => ({
      id: i.id.videoId,
      title: decodeEntities(i.snippet?.title || ''),
      channelTitle: i.snippet?.channelTitle || '',
      channelId: i.snippet?.channelId || '',
      published: i.snippet?.publishedAt || '',
      url: `https://www.youtube.com/watch?v=${i.id.videoId}`,
    }));
}

async function details(ids) {
  const out = new Map();
  // videos.list takes fifty ids for one unit, so this is a single call.
  for (let i = 0; i < ids.length; i += 50) {
    const data = await getJSON(`${API}/videos?${qs({
      part: 'contentDetails,statistics',
      id: ids.slice(i, i + 50).join(','),
    })}`);
    for (const item of data.items || []) {
      out.set(item.id, {
        seconds: isoDuration(item.contentDetails?.duration),
        views: Number(item.statistics?.viewCount || 0),
      });
    }
  }
  return out;
}

/** PT1H23M45S → seconds. */
function isoDuration(iso) {
  const m = String(iso || '').match(/P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

/* The search API returns titles HTML-escaped — "Bowie &amp; Queen". */
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&apos;|&#39;/g, "'");
}
