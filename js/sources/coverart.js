/* Cover Art Archive.

   Loaded as plain <img> elements rather than fetched: images don't need
   CORS to render, and the archive answers 404 for anything it doesn't have,
   which the error handler turns into "no art" without ceremony. */

const cache = new Map();   // url -> HTMLImageElement | null (null = known missing)

export const releaseGroupArt = (mbid, size = 250) =>
  `https://coverartarchive.org/release-group/${mbid}/front-${size}`;

export const releaseArt = (mbid, size = 250) =>
  `https://coverartarchive.org/release/${mbid}/front-${size}`;

/**
 * Load an image and resolve with it, or with null if it isn't there.
 * Results are memoised so the canvas can ask on every frame for free.
 */
export function loadImage(url) {
  if (!url) return Promise.resolve(null);
  if (cache.has(url)) {
    const v = cache.get(url);
    return v instanceof Promise ? v : Promise.resolve(v);
  }

  const p = new Promise(resolve => {
    const img = new Image();
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => { cache.set(url, img); resolve(img); };
    img.onerror = () => { cache.set(url, null); resolve(null); };
    img.src = url;
  });

  cache.set(url, p);
  return p;
}

/** Synchronous peek for the render loop: an image, or null/undefined. */
export function peekImage(url) {
  const v = cache.get(url);
  return v instanceof Promise ? undefined : v;
}
