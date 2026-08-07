/* Last.fm — what people actually play, and what they call it.

   Two jobs, both optional. It knows an artist's most-played songs, which is
   a better answer to "what are they known for" than whichever tracks got
   pressed as singles. And its tags fill in a style for artists MusicBrainz
   hasn't tagged yet.

   What it deliberately does *not* supply any more is co-listening
   similarity. "People who play this also play that" describes an audience,
   not a sound — the overlap is often an accident of era or playlist. Style
   comes from tags instead; see musicbrainz.js. */

import { getJSON, SourceError } from '../net.js';
import { settings, hasLastfm } from '../config.js';

const API = 'https://ws.audioscrobbler.com/2.0/';

function url(method, params) {
  return `${API}?${new URLSearchParams({
    method,
    api_key: settings().lastfmKey,
    format: 'json',
    autocorrect: '1',
    ...params,
  })}`;
}

/* Last.fm answers HTTP 200 with an error body, so success needs checking
   rather than assuming. */
function unwrap(data) {
  if (data && data.error) throw new SourceError('Last.fm', `${data.message || 'error'} (code ${data.error})`);
  return data;
}

/**
 * The songs an artist is actually known for, ranked by listening rather
 * than by what happened to get pressed as a single. This is the best
 * available answer to "which of their songs would I recognise".
 */
export async function topTracks(name, mbid, limit = 5) {
  if (!hasLastfm()) return [];
  const params = mbid ? { mbid, limit: String(limit) } : { artist: name, limit: String(limit) };
  const data = unwrap(await getJSON(url('artist.gettoptracks', params)));
  const raw = data?.toptracks?.track;
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return list.map(t => ({
    name: t.name,
    mbid: t.mbid || null,
    listeners: Number(t.listeners) || 0,
    rank: Number(t['@attr']?.rank) || 0,
  })).filter(t => t.name);
}

export async function artistInfo(name, mbid) {
  if (!hasLastfm()) return null;
  const params = mbid ? { mbid } : { artist: name };
  const data = unwrap(await getJSON(url('artist.getinfo', params)));
  const a = data?.artist;
  if (!a) return null;
  return {
    listeners: Number(a.stats?.listeners) || 0,
    playcount: Number(a.stats?.playcount) || 0,
    tags: (a.tags?.tag || []).map(t => t.name),
    // Last.fm bios end with a boilerplate "Read more on Last.fm" link.
    bio: (a.bio?.summary || '').replace(/<a [^>]*>.*?<\/a>/gs, '').trim(),
  };
}

/** Used by the diagnostics panel to prove the key works. */
export async function ping() {
  const data = unwrap(await getJSON(url('artist.getinfo', { artist: 'Radiohead' }), { cache: false }));
  if (!data?.artist?.name) throw new SourceError('Last.fm', 'unexpected response shape');
  return 'key accepted';
}
