/* User settings, including API keys.

   Keys live in localStorage on this device. That is a deliberate trade for
   a personal, single-user app with no server: it's the only way to keep
   this a static site you can host for free. Anything stored here is
   readable by any script running on this origin, so use keys you're
   willing to rotate, and don't host this app on a domain you share. */

const KEY = 'constellation.settings.v1';

const DEFAULTS = {
  lastfmKey: '',
  discogsToken: '',
  anthropicKey: '',
  anthropicModel: 'claude-opus-5',
  useLastfm: true,
  useDiscogs: true,
  useLlm: true,
  useCoverArt: true,
  contactEmail: '',       // sent to MusicBrainz as a courtesy identifier
};

let cache = null;

export function settings() {
  if (cache) return cache;
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
  cache = { ...DEFAULTS, ...stored };
  return cache;
}

export function saveSettings(patch) {
  cache = { ...settings(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch {}
  return cache;
}

/* Which optional sources are actually live right now. */
export const hasLastfm  = () => { const s = settings(); return s.useLastfm  && !!s.lastfmKey; };
export const hasDiscogs = () => { const s = settings(); return s.useDiscogs && !!s.discogsToken; };
export const hasLlm     = () => { const s = settings(); return s.useLlm     && !!s.anthropicKey; };
