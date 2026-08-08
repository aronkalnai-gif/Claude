/* Wikipedia — the prose layer.

   MusicBrainz knows *that* two people played together; Wikipedia knows who
   they were. We reach it via the Wikidata id MusicBrainz already stores,
   which is far more reliable than guessing an article title from a name.

   This asks for the whole lead section rather than the REST `summary`
   endpoint. The summary is one or two sentences by design — enough for a
   tooltip, not enough to tell you anything. The lead section is the
   paragraph or three an editor wrote to introduce the subject, which is
   exactly the length a reader wants when they open something. */

import { getJSON } from '../net.js';

const API = 'https://en.wikipedia.org/w/api.php';
const WD = 'https://www.wikidata.org/w/api.php';

const qidFrom = url => (String(url || '').match(/\/(Q\d+)(?:$|[?#])/) || [])[1] || null;

const titleFromUrl = url => {
  const m = String(url || '').match(/wikipedia\.org\/wiki\/([^?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
};

/**
 * Fetch the lead section for an entity, given the external URLs
 * MusicBrainz recorded for it. Returns null rather than throwing — a
 * missing blurb should never take down an expansion.
 */
export async function summaryFor(urls = {}) {
  try {
    let title = titleFromUrl(urls.wikipedia);
    if (!title && urls.wikidata) title = await enwikiTitle(qidFrom(urls.wikidata));
    if (!title) return null;
    return await leadSection(title);
  } catch {
    return null;
  }
}

/* One request for prose, picture and canonical link. `redirects` matters
   more than it looks: MusicBrainz often stores a title that has since been
   renamed, and without it those articles come back missing. */
async function leadSection(title) {
  const q = new URLSearchParams({
    action: 'query', format: 'json', origin: '*', redirects: '1',
    prop: 'extracts|pageimages|info', inprop: 'url',
    exintro: '1', explaintext: '1',
    piprop: 'thumbnail', pithumbsize: '480',
    titles: title,
  });

  const data = await getJSON(`${API}?${q}`);
  const page = Object.values(data?.query?.pages || {})[0];
  if (!page || page.missing !== undefined) return null;

  const extract = clean(page.extract);
  if (!extract) return null;

  return {
    extract,
    image: page.thumbnail?.source || null,
    url: page.fullurl || null,
    title: page.title || title,
  };
}

/* Plaintext extracts still carry the parenthetical thicket that opens most
   articles — IPA, birth names, alternative spellings. It's noise to a
   reader who came here for the music, and it usually eats the first line. */
function clean(text) {
  return String(text || '')
    .replace(/\((?:[^()]|\([^()]*\))*\)/g, m =>
      // Keep parentheses that carry a year; drop pronunciation guides.
      /\d{3,4}/.test(m) && !/[ɐ-ʯ̀-ͯ]|listen|pronoun/i.test(m) ? m : '')
    .replace(/\s+([,;.])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{2,}/g, '\n\n')
    .trim();
}

/** First `n` sentences of a block of prose. */
export function firstSentences(text, n) {
  const s = String(text || '').trim();
  if (!s) return '';
  const parts = s.match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g) || [s];
  return parts.slice(0, n).join('').trim();
}

export const sentenceCount = text =>
  ((String(text || '').match(/[^.!?]+[.!?]+["')\]]*/g)) || []).length;

async function enwikiTitle(qid) {
  if (!qid) return null;
  const url = `${WD}?action=wbgetentities&ids=${qid}&props=sitelinks&format=json&origin=*`;
  const data = await getJSON(url);
  return data?.entities?.[qid]?.sitelinks?.enwiki?.title || null;
}
