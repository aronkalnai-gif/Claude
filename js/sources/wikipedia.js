/* Wikipedia — the prose layer.

   MusicBrainz knows *that* two people played together; Wikipedia knows who
   they were. We reach it via the Wikidata id MusicBrainz already stores,
   which is far more reliable than guessing an article title from a name. */

import { getJSON } from '../net.js';

const WD = 'https://www.wikidata.org/w/api.php';
const REST = 'https://en.wikipedia.org/api/rest_v1/page/summary';

const qidFrom = url => (String(url || '').match(/\/(Q\d+)(?:$|[?#])/) || [])[1] || null;

const titleFromUrl = url => {
  const m = String(url || '').match(/wikipedia\.org\/wiki\/([^?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
};

/**
 * Fetch a short summary for an entity, given the external URLs MusicBrainz
 * recorded for it. Returns null rather than throwing — a missing blurb
 * should never take down an expansion.
 */
export async function summaryFor(urls = {}) {
  try {
    let title = titleFromUrl(urls.wikipedia);
    if (!title && urls.wikidata) title = await enwikiTitle(qidFrom(urls.wikidata));
    if (!title) return null;

    const data = await getJSON(`${REST}/${encodeURIComponent(title.replace(/ /g, '_'))}`);
    if (!data || data.type === 'disambiguation' || !data.extract) return null;

    return {
      extract: data.extract,
      image: data.thumbnail?.source || null,
      url: data.content_urls?.desktop?.page || null,
      title: data.title || title,
    };
  } catch {
    return null;
  }
}

async function enwikiTitle(qid) {
  if (!qid) return null;
  const url = `${WD}?action=wbgetentities&ids=${qid}&props=sitelinks&format=json&origin=*`;
  const data = await getJSON(url);
  return data?.entities?.[qid]?.sitelinks?.enwiki?.title || null;
}
