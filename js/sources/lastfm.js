/* Last.fm — the statistical layer.

   This is the one source that answers "what else sounds like this", from
   listening behaviour rather than documented fact. It supplies the fuzzy
   edges MusicBrainz structurally cannot: nobody ever filed paperwork
   saying Portishead and Massive Attack belong near each other. */

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

export async function similarArtists(name, mbid, limit = 8) {
  if (!hasLastfm()) return [];
  const params = mbid ? { mbid, limit: String(limit) } : { artist: name, limit: String(limit) };
  const data = unwrap(await getJSON(url('artist.getsimilar', params)));
  return (data?.similarartists?.artist || []).map(a => ({
    name: a.name,
    mbid: a.mbid || null,
    match: Number(a.match) || 0,
  })).filter(a => a.name);
}

export async function similarTracks(artist, track, mbid, limit = 8) {
  if (!hasLastfm()) return [];
  const params = mbid ? { mbid, limit: String(limit) } : { artist, track, limit: String(limit) };
  const data = unwrap(await getJSON(url('track.getsimilar', params)));
  return (data?.similartracks?.track || []).map(t => ({
    name: t.name,
    artist: t.artist?.name || '',
    mbid: t.mbid || null,
    match: Number(t.match) || 0,
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
