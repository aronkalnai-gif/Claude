/* Expansion: given one thing, work out what else belongs beside it.

   Every source is optional except MusicBrainz, and every step is allowed to
   fail without taking the expansion down with it — a dead Last.fm key
   should cost you the similarity edges, not the band members. */

import * as mb from './sources/musicbrainz.js';
import * as lastfm from './sources/lastfm.js';
import * as discogs from './sources/discogs.js';
import { summaryFor, sentenceCount } from './sources/wikipedia.js';
import { releaseGroupArt, releaseArt, loadImage } from './sources/coverart.js';
import { annotate, profile } from './sources/llm.js';
import { addNode as storeNode, addEdge, graph, nodeId, emit, findByLabel } from './state.js';
import { describeRelation, artistKind, kindLabel, isPlaceholder } from './model.js';
import { factLines } from './facts.js';
import { hasLastfm, hasDiscogs, hasLlm, settings } from './config.js';

const REL_EDGE_KIND = {
  'member of band': 'member',
  'founder': 'founded',
  'collaboration': 'collab',
  'subgroup': 'related',
  'supporting musician': 'performed',
  'producer': 'produced',
  'engineer': 'credit',
  'recording engineer': 'credit',
  'mix': 'credit',
  'mastering': 'credit',
  'vocal': 'performed',
  'instrument': 'performed',
  'performer': 'performed',
  'composer': 'wroteWork',
  'lyricist': 'wroteWork',
  'writer': 'wroteWork',
  'arranger': 'credit',
  'performance': 'otherTake',
  'recorded at': 'recordedAt',
  'recorded in': 'recordedAt',
  'mixed at': 'recordedAt',
  'engineered at': 'recordedAt',
};

/* An artist expansion now has five categories competing for room —
   bandmates, records, their songs, kindred artists, and songs that merely
   sound alike. The budget is sized so the last of those still gets a
   showing, and people are capped so a large lineup can't eat everything
   ahead of them. */
const PER_EXPANSION_BUDGET = 26;
const MAX_PEOPLE = 10;

/* Every node this file creates goes through here, which is the point:
   there are a dozen places that mint one — band members, sidemen, track
   lists, tag searches — and a rule enforced at eleven of them is not a
   rule. The store stays dumb and this is where the judgement lives, so a
   placeholder is refused once, on the way in. Callers already cope with a
   null (it's what hitting the node ceiling returns), so nothing else
   needed changing. */
function addNode(spec, opts) {
  if (isPlaceholder(spec)) return null;
  return storeNode(spec, opts);
}

/* ── Entry points ───────────────────────────────────────────────────── */

/** Turn a search result into the first node of a fresh graph. */
export function makeSeed(candidate) {
  const mbType = {
    person: 'artist', group: 'artist', artist: 'artist',
    album: 'release-group', track: 'recording',
    work: 'work', label: 'label', place: 'place',
  }[candidate.kind] || 'artist';

  const node = addNode({
    id: nodeId(candidate.kind, candidate.mbid),
    kind: candidate.kind,
    mbType,
    mbid: candidate.mbid,
    label: candidate.label,
    sublabel: candidate.sublabel || '',
    depth: 0,
  });
  if (node) { node.x = 0; node.y = 0; graph.seedId = node.id; }
  return node;
}

/**
 * Grow the graph outward from one node.
 * @param {object} node
 * @param {(msg: string) => void} onProgress
 */
export async function expand(node, onProgress = () => {}) {
  // `unlinked`, not `expanded`: a node that hit the budget on its first
  // pass may still have more behind it, and the button says "Expand again"
  // for a reason. What stops the loop is finding nothing, not having tried.
  if (!node || node.expanding || node.unlinked) return;
  node.expanding = true;
  emit();

  const before = graph.nodes.size + graph.edges.size;
  const ctx = {
    node,
    added: [],          // {edge, otherLabel, otherKind, relation, extra}
    budget: PER_EXPANSION_BUDGET,
    onProgress,
  };

  try {
    switch (node.mbType) {
      case 'artist':        await expandArtist(ctx); break;
      case 'release-group':
      case 'release':       await expandAlbum(ctx); break;
      case 'recording':     await expandRecording(ctx); break;
      case 'work':          await expandWork(ctx); break;
      case 'label':         await expandLabel(ctx); break;
      case 'place':         await expandPlace(ctx); break;
      default:              await expandArtist(ctx);
    }
    node.expanded = true;

    // Nothing new came back. Expansion is deterministic over cached data —
    // the same sources, walked in the same order, with the same budget —
    // so a pass that added nothing means the next one would add nothing
    // either. Say so on the node instead of leaving a button that looks
    // like it does something.
    if (graph.nodes.size + graph.edges.size === before) node.unlinked = true;
  } catch (err) {
    node.error = err?.message || String(err);
    // A failed expansion still leaves whatever it managed to add — better a
    // partial web than an empty one.
    console.warn('[expand]', node.label, err);
    throw err;
  } finally {
    node.expanding = false;
    emit();
  }

  // Storytelling last, so the graph is already on screen and interactive
  // while the sentences arrive.
  if (hasLlm() && ctx.added.length) {
    onProgress('writing the notes…');
    annotate(
      { label: node.label, kind: node.kind },
      ctx.added.map(a => ({
        id: a.edge.id,
        other: a.otherLabel,
        otherKind: a.otherKind,
        relation: a.relation,
        extra: a.extra,
      })),
    ).then(notes => {
      let touched = false;
      for (const [id, text] of notes) {
        const e = graph.edges.get(id);
        if (e) { e.lore = text; touched = true; }
      }
      if (touched) emit();
    }).catch(err => console.warn('[annotate]', err));
  }
}

/* ── Artists and bands ──────────────────────────────────────────────── */

async function expandArtist(ctx) {
  const { node, onProgress } = ctx;
  onProgress(`looking up ${node.label}…`);

  const data = await mb.lookupArtist(node.mbid);
  node.data = data;
  node.kind = artistKind(data);
  node.provisional = false;
  node.tags = mb.topTags(data);
  if (!node.sublabel) {
    node.sublabel = [data.disambiguation, data.type, data.area?.name].filter(Boolean).join(' · ');
  }

  const urls = mb.externalUrls(data);
  attachBio(node, urls);

  // 1. People and bands: the strongest ties, so they go on first and get
  //    first claim on the budget — but not all of it. An orchestra with
  //    forty documented members would otherwise swallow the whole
  //    expansion and you'd never see a record or a song.
  let people = 0;
  for (const rel of mb.relationsOfType(data, 'artist')) {
    if (ctx.budget <= 0 || people >= MAX_PEOPLE) break;
    const other = rel.artist;
    if (!other?.id) continue;
    const kind = artistKind(other);
    const target = addNode({
      id: nodeId(kind, other.id),
      kind, mbType: 'artist', mbid: other.id,
      label: other.name,
      sublabel: [other.disambiguation, other.type].filter(Boolean).join(' · '),
      depth: node.depth + 1,
    }, { near: node });
    if (!target) continue;
    people++;
    linkRelation(ctx, node, target, rel);
  }
  emit();   // let the first ring appear before the next request goes out

  // 2. Their records.
  for (const rg of mb.notableAlbums(data, 4)) {
    if (ctx.budget <= 0) break;
    const album = addNode({
      id: nodeId('album', rg.id),
      kind: 'album', mbType: 'release-group', mbid: rg.id,
      label: rg.title,
      sublabel: [rg['primary-type'], mb.year(rg['first-release-date'])].filter(Boolean).join(' · '),
      art: releaseGroupArt(rg.id),
      searchTerm: `${node.label} ${rg.title}`,
      depth: node.depth + 1,
    }, { near: node });
    if (!album) continue;
    loadImage(album.art).then(img => { if (!img) album.art = null; emit(); });

    const yr = mb.year(rg['first-release-date']);
    record(ctx, addEdge(node.id, album.id, 'released', yr ? `released · ${yr}` : 'released'),
      album, yr ? `released ${rg.title} in ${yr}` : `released ${rg.title}`);
  }

  emit();

  // 3. Their songs. An artist without individual songs on the web is a
  //    discography, not a map of what they made — so this runs from two
  //    independent angles and takes whichever it can get.
  await addSongsForArtist(ctx, data);
  emit();

  // 4. Stylistic kin: other artists working the same seam, and songs by
  //    people with no connection to this one that simply sound like it.
  const styles = await addStylisticKin(ctx, data);
  emit();
  await addStylisticSongsForArtist(ctx, styles);
}

/**
 * Artists working in the same style.
 *
 * Deliberately *not* "people who listen to this also listen to that" —
 * co-listening tells you about audiences, and an audience overlap is often
 * an accident of era or playlist rather than anything you can hear. This
 * asks a narrower and more answerable question: who else made music like
 * this? MusicBrainz's tag index answers it, which also means stylistic
 * connections need no API key.
 *
 * The tag has to be specific to be worth drawing. "Rock" would tie the
 * seed to a few thousand strangers; "hard bop" is a claim about the music.
 */
async function addStylisticKin(ctx, data) {
  const { node, onProgress } = ctx;

  let styles = mb.styleTags(data, 2);

  // MusicBrainz tagging is uneven — plenty of artists have none. Last.fm's
  // tags are noisier but broad coverage, and the same filter cleans them up.
  if (!styles.length && hasLastfm()) {
    try {
      const info = await lastfm.artistInfo(node.label, node.mbid);
      styles = mb.styleTags({ tags: (info?.tags || []).map(name => ({ name, count: 1 })) }, 2);
    } catch (err) { console.warn('[lastfm tags]', err); }
  }

  if (!styles.length) return [];
  node.styles = styles;
  if (ctx.budget <= 0) return styles;

  const style = styles[0];
  onProgress(`looking for other ${style}…`);

  try {
    const kin = await mb.artistsByTag(style, 8);
    let added = 0;
    for (const a of kin) {
      if (ctx.budget <= 0 || added >= 4) break;
      if (a.id === node.mbid) continue;                   // the seed matches its own tag
      if (graph.nodes.has(nodeId('person', a.id)) ||
          graph.nodes.has(nodeId('group', a.id))) continue;  // already here for a better reason

      const kind = artistKind(a);
      const target = addNode({
        id: nodeId(kind, a.id),
        kind, mbType: 'artist', mbid: a.id,
        label: a.name,
        sublabel: [a.disambiguation, style].filter(Boolean).join(' · '),
        depth: node.depth + 1,
      }, { near: node });
      if (!target) continue;
      added++;
      record(ctx, addEdge(node.id, target.id, 'style', `both ${style}`),
        target, `works in the same style — ${style}`);
    }
  } catch (err) { console.warn('[style kin]', err); }

  return styles;
}

/**
 * Songs by people with no connection to the artist at all, that simply
 * sound like them.
 *
 * Every other edge on the graph is a documented fact — someone played on
 * something, a session happened in a room. These are the opposite: pure
 * "you might like this", justified only by a shared style. That makes two
 * things load-bearing.
 *
 * First, they must never read as the artist's own work. The edge says "in
 * the same style", not "released", and the node carries whoever actually
 * made it — because a green dot next to a band, unqualified, would imply
 * authorship the data doesn't support.
 *
 * Second, anything actually *by* this artist is filtered out. A song they
 * recorded is a fact about them and belongs on a factual edge, not in a
 * list of strangers.
 */
async function addStylisticSongsForArtist(ctx, styles) {
  const { node, onProgress } = ctx;
  if (!styles?.length || ctx.budget <= 0) return;

  const style = styles[0];
  onProgress(`listening for other ${style}…`);

  try {
    const kin = await mb.recordingsByTag(style, 12);
    let added = 0;
    for (const r of kin) {
      if (ctx.budget <= 0 || added >= 3) break;
      if (r.artistIds?.includes(node.mbid)) continue;   // their own record
      if (findByLabel('track', r.title)) continue;
      if (graph.nodes.has(nodeId('track', r.id))) continue;

      const song = addNode({
        id: nodeId('track', r.id),
        kind: 'track', mbType: 'recording', mbid: r.id,
        label: r.title,
        // The performer goes first: this is somebody else's song.
        sublabel: [r.artist, style].filter(Boolean).join(' · '),
        searchTerm: `${r.artist} ${r.title}`,
        depth: node.depth + 1,
      }, { near: node });
      if (!song) continue;
      added++;
      record(ctx, addEdge(node.id, song.id, 'style', `in the same style · ${style}`),
        song,
        `"${r.title}" is by ${r.artist || 'another artist'}, not by ${node.label}; the only link is the shared style`);
    }
  } catch (err) { console.warn('[style songs]', err); }
}

/**
 * Songs for an artist, from two sources that complement each other.
 *
 * Last.fm knows which songs people actually play, which is what someone
 * means when they ask what an artist is known for — but it needs a key.
 * MusicBrainz singles are always available and cost nothing extra, since
 * the artist lookup already carried them; they skew towards what got
 * pressed as a 7", which for older artists is exactly right.
 */
async function addSongsForArtist(ctx, data) {
  const { node, onProgress } = ctx;
  const seen = new Set();

  if (hasLastfm() && ctx.budget > 0) {
    onProgress('picking out the songs…');
    try {
      for (const t of await lastfm.topTracks(node.label, node.mbid, 5)) {
        if (ctx.budget <= 0) break;
        // Without an MBID the node would be a dead end on the graph.
        if (!t.mbid) continue;
        const track = addNode({
          id: nodeId('track', t.mbid),
          kind: 'track', mbType: 'recording', mbid: t.mbid,
          label: t.name,
          sublabel: 'most played',
          searchTerm: `${node.label} ${t.name}`,
          depth: node.depth + 1,
        }, { near: node });
        if (!track) continue;
        seen.add(t.name.toLowerCase());
        record(ctx, addEdge(node.id, track.id, 'performed', 'best known for'),
          track, `is best known for "${t.name}"`);
      }
    } catch (err) { console.warn('[lastfm toptracks]', err); }
  }

  // Singles, as songs. A single's title is the song's title, and expanding
  // one leads down to the recording itself, the session and the label.
  for (const rg of mb.notableSingles(data, seen.size ? 2 : 4)) {
    if (ctx.budget <= 0) break;
    if (seen.has(rg.title.toLowerCase())) continue;
    const yr = mb.year(rg['first-release-date']);
    const song = findByLabel('track', rg.title) || addNode({
      id: nodeId('track', rg.id),
      kind: 'track', mbType: 'release-group', mbid: rg.id,
      label: rg.title,
      sublabel: yr ? `single · ${yr}` : 'single',
      art: releaseGroupArt(rg.id),
      searchTerm: `${node.label} ${rg.title}`,
      depth: node.depth + 1,
    }, { near: node });
    if (!song) continue;
    seen.add(rg.title.toLowerCase());
    loadImage(song.art).then(img => { if (!img) song.art = null; emit(); });
    record(ctx, addEdge(node.id, song.id, 'performed', yr ? `released as a single · ${yr}` : 'released as a single'),
      song, yr ? `put out "${rg.title}" as a single in ${yr}` : `put out "${rg.title}" as a single`);
  }
}

/* ── Albums ─────────────────────────────────────────────────────────── */

async function expandAlbum(ctx) {
  const { node, onProgress } = ctx;
  onProgress(`opening ${node.label}…`);

  let rg = null, release = null;

  if (node.mbType === 'release-group') {
    rg = await mb.lookupReleaseGroup(node.mbid);
    node.data = rg;
    node.tags = mb.topTags(rg);
    const pick = mb.pickRepresentativeRelease(rg.releases);
    if (pick) {
      onProgress('reading the sleeve…');
      release = await mb.lookupRelease(pick.id).catch(() => null);
    }
    attachBio(node, mb.externalUrls(rg));
  } else {
    release = await mb.lookupRelease(node.mbid);
    node.data = release;
    attachBio(node, mb.externalUrls(release));
  }

  const source = rg || release;
  if (!node.sublabel && source) {
    node.sublabel = [mb.credit(source['artist-credit']), source['primary-type'] || 'Release',
      mb.year(source['first-release-date'] || source.date)].filter(Boolean).join(' · ');
  }
  if (!node.art) {
    node.art = node.mbType === 'release-group' ? releaseGroupArt(node.mbid) : releaseArt(node.mbid);
    loadImage(node.art).then(img => { if (!img) node.art = null; emit(); });
  }

  // Whose record is it?
  for (const a of mb.creditArtists(source?.['artist-credit'])) {
    if (ctx.budget <= 0) break;
    const kind = artistKind(a);
    const artist = addNode({
      id: nodeId(kind, a.id),
      kind, mbType: 'artist', mbid: a.id,
      label: a.name, sublabel: a.disambiguation || '',
      depth: node.depth + 1,
    }, { near: node });
    if (!artist) continue;
    record(ctx, addEdge(artist.id, node.id, 'released', 'released'), artist, `made the record ${node.label}`);
  }

  // Credits attached to the release-group itself.
  if (rg) linkArtistRelations(ctx, rg);

  if (release) {
    // Where it was cut. This is the one that produces the sentences people
    // actually remember.
    for (const rel of mb.relationsOfType(release, 'place')) {
      if (ctx.budget <= 0) break;
      const p = rel.place;
      if (!p?.id) continue;
      const place = addNode({
        id: nodeId('place', p.id),
        kind: 'place', mbType: 'place', mbid: p.id,
        label: p.name,
        sublabel: [p.type, p.area?.name].filter(Boolean).join(' · '),
        depth: node.depth + 1,
      }, { near: node });
      if (!place) continue;
      node.studioName = node.studioName || p.name;
      linkRelation(ctx, node, place, rel, `${node.label} was cut at ${p.name}`);
    }

    // Credits on the release: producers, engineers, sidemen.
    linkArtistRelations(ctx, release);

    // The label that pressed it.
    for (const li of release['label-info'] || []) {
      if (ctx.budget <= 0) break;
      const l = li.label;
      if (!l?.id) continue;
      const labelNode = addNode({
        id: nodeId('label', l.id),
        kind: 'label', mbType: 'label', mbid: l.id,
        label: l.name,
        sublabel: li['catalog-number'] ? `cat. ${li['catalog-number']}` : 'record label',
        depth: node.depth + 1,
      }, { near: node });
      if (!labelNode) continue;
      node.labelName = node.labelName || l.name;
      const when = mb.year(release.date);
      record(ctx, addEdge(node.id, labelNode.id, 'onLabel', when ? `issued on · ${when}` : 'issued on'),
        labelNode, `came out on ${l.name}${when ? ` in ${when}` : ''}`);
    }

    // A handful of tracks — enough to give the record a shape without
    // burying the album under its own tracklist.
    const allTracks = mb.tracksOf(release);
    node.trackCount = allTracks.length;
    const tracks = allTracks.slice(0, 6);
    for (const t of tracks) {
      if (ctx.budget <= 0) break;
      const title = t.trackTitle || t.title;
      const track = findByLabel('track', title) || addNode({
        id: nodeId('track', t.id),
        kind: 'track', mbType: 'recording', mbid: t.id,
        label: title,
        sublabel: node.label,
        searchTerm: `${mb.credit(source?.['artist-credit'])} ${t.title}`,
        depth: node.depth + 1,
      }, { near: node });
      if (!track) continue;
      record(ctx, addEdge(node.id, track.id, 'track', `track ${t.position || ''}`.trim()), track, null);
    }
  }

  // Discogs fills in the sidemen MusicBrainz often lacks, especially on
  // older jazz and blues sides.
  if (hasDiscogs() && ctx.budget > 0) {
    onProgress('checking the session personnel…');
    try {
      const artistName = mb.credit(source?.['artist-credit']);
      const info = await discogs.creditsForAlbum({
        title: node.label,
        artistName,
        discogsUrl: mb.externalUrls(source || {}).discogs,
      });
      if (info) {
        node.discogs = info;
        // Only people we don't already have, and only real roles.
        const known = new Set([...graph.nodes.values()].map(n => n.label.toLowerCase()));
        for (const c of info.credits) {
          if (ctx.budget <= 0) break;
          if (c.role === 'Main artist') continue;
          if (known.has(c.name.toLowerCase())) continue;
          const id = `credit:${slug(c.name)}`;
          const person = addNode({
            id, kind: 'person', mbType: null, mbid: null,
            label: c.name, sublabel: c.role,
            unlinked: true,            // no MBID, so this node is a leaf
            depth: node.depth + 1,
          }, { near: node });
          if (!person) continue;
          known.add(c.name.toLowerCase());
          record(ctx, addEdge(person.id, node.id, 'credit', c.role.toLowerCase()),
            person, `${c.role} on ${node.label}`);
        }
      }
    } catch (err) { console.warn('[discogs]', err); }
  }
}

/* ── Songs ──────────────────────────────────────────────────────────── */

async function expandRecording(ctx) {
  const { node, onProgress } = ctx;
  onProgress(`listening to ${node.label}…`);

  const rec = await mb.lookupRecording(node.mbid);
  node.data = rec;
  node.tags = mb.topTags(rec);
  if (!node.sublabel) node.sublabel = mb.credit(rec['artist-credit']);
  node.searchTerm = `${mb.credit(rec['artist-credit'])} ${rec.title}`;
  attachBio(node, mb.externalUrls(rec));

  for (const a of mb.creditArtists(rec['artist-credit'])) {
    if (ctx.budget <= 0) break;
    const kind = artistKind(a);
    const artist = addNode({
      id: nodeId(kind, a.id),
      kind, mbType: 'artist', mbid: a.id,
      label: a.name, sublabel: a.disambiguation || '',
      depth: node.depth + 1,
    }, { near: node });
    if (!artist) continue;
    record(ctx, addEdge(artist.id, node.id, 'performed', 'recorded'), artist, `recorded ${node.label}`);
  }

  linkArtistRelations(ctx, rec);

  // The underlying song, and through it every other version of it — the
  // route from a cover back to the original and out to its siblings.
  for (const rel of mb.relationsOfType(rec, 'work')) {
    if (ctx.budget <= 0) break;
    const w = rel.work;
    if (!w?.id) continue;
    const work = addNode({
      id: nodeId('work', w.id),
      kind: 'work', mbType: 'work', mbid: w.id,
      label: w.title, sublabel: 'the song itself',
      depth: node.depth + 1,
    }, { near: node });
    if (!work) continue;
    record(ctx, addEdge(node.id, work.id, 'wroteWork', 'is a recording of'),
      work, `is one recording of the song "${w.title}"`);
  }

  // Which records carry it.
  for (const r of (rec.releases || []).slice(0, 3)) {
    if (ctx.budget <= 0) break;
    const album = addNode({
      id: nodeId('album', r.id),
      kind: 'album', mbType: 'release', mbid: r.id,
      label: r.title,
      sublabel: mb.year(r.date) || 'release',
      art: releaseArt(r.id),
      depth: node.depth + 1,
    }, { near: node });
    if (!album) continue;
    loadImage(album.art).then(img => { if (!img) album.art = null; emit(); });
    record(ctx, addEdge(node.id, album.id, 'track', 'appears on'), album, `appears on ${r.title}`);
  }

  // Songs in the same style. A recording's own tags are often thin, so fall
  // back to the style of whoever made it — which is usually what someone
  // means by "something else that sounds like this" anyway.
  await addStylisticSongsForRecording(ctx, rec);
}

async function addStylisticSongsForRecording(ctx, rec) {
  const { node, onProgress } = ctx;
  if (ctx.budget <= 0) return;

  let styles = mb.styleTags(rec, 2);

  // Individual recordings are tagged far less often than the people who
  // made them, so fall back to the artist's style. If you arrived here from
  // that artist the lookup is already cached, so this usually costs nothing.
  if (!styles.length) {
    const credited = mb.creditArtists(rec['artist-credit'])[0];
    if (credited?.id) {
      const artist = await mb.lookupArtist(credited.id).catch(() => null);
      if (artist) styles = mb.styleTags(artist, 2);
    }
  }

  const style = styles[0];
  if (!style) return;
  node.styles = styles;

  onProgress(`looking for other ${style}…`);
  try {
    const kin = await mb.recordingsByTag(style, 8);
    let added = 0;
    for (const r of kin) {
      if (ctx.budget <= 0 || added >= 3) break;
      if (r.id === node.mbid) continue;
      if (findByLabel('track', r.title)) continue;
      const track = addNode({
        id: nodeId('track', r.id),
        kind: 'track', mbType: 'recording', mbid: r.id,
        label: r.title,
        sublabel: [r.artist, style].filter(Boolean).join(' · '),
        searchTerm: `${r.artist} ${r.title}`,
        depth: node.depth + 1,
      }, { near: node });
      if (!track) continue;
      added++;
      record(ctx, addEdge(node.id, track.id, 'style', `both ${style}`),
        track, `is another ${style} recording`);
    }
  } catch (err) { console.warn('[style songs]', err); }
}

/* ── Works, labels, studios ─────────────────────────────────────────── */

async function expandWork(ctx) {
  const { node, onProgress } = ctx;
  onProgress(`tracing "${node.label}"…`);

  const work = await mb.lookupWork(node.mbid);
  node.data = work;
  attachBio(node, mb.externalUrls(work));

  linkArtistRelations(ctx, work);

  // Every recorded version — the cover-version view.
  const takes = mb.relationsOfType(work, 'recording').slice(0, 8);
  for (const rel of takes) {
    if (ctx.budget <= 0) break;
    const r = rel.recording;
    if (!r?.id) continue;
    const track = addNode({
      id: nodeId('track', r.id),
      kind: 'track', mbType: 'recording', mbid: r.id,
      label: r.title,
      sublabel: mb.credit(r['artist-credit']) || 'recording',
      depth: node.depth + 1,
    }, { near: node });
    if (!track) continue;
    const who = mb.credit(r['artist-credit']);
    record(ctx, addEdge(track.id, node.id, 'otherTake', 'is a version of'),
      track, who ? `${who} recorded this song` : null);
  }
}

async function expandLabel(ctx) {
  const { node, onProgress } = ctx;
  onProgress(`going through the ${node.label} catalogue…`);

  const label = await mb.lookupLabel(node.mbid).catch(() => null);
  if (label) {
    node.data = label;
    node.tags = mb.topTags(label);
    if (!node.sublabel) node.sublabel = [label.type, label.area?.name].filter(Boolean).join(' · ');
    attachBio(node, mb.externalUrls(label));
  }

  // Other records this label put out — the "everything on Blue Note in '57"
  // thread that makes label nodes worth having at all.
  try {
    const browse = await mb.lookupLabelReleases(node.mbid);
    for (const r of browse.slice(0, 8)) {
      if (ctx.budget <= 0) break;
      const album = addNode({
        id: nodeId('album', r.id),
        kind: 'album', mbType: 'release', mbid: r.id,
        label: r.title,
        sublabel: [mb.credit(r['artist-credit']), mb.year(r.date)].filter(Boolean).join(' · '),
        art: releaseArt(r.id),
        depth: node.depth + 1,
      }, { near: node });
      if (!album) continue;
      loadImage(album.art).then(img => { if (!img) album.art = null; emit(); });
      record(ctx, addEdge(node.id, album.id, 'onLabel', mb.year(r.date) ? `issued · ${mb.year(r.date)}` : 'issued'),
        album, `${node.label} released ${r.title}`);
    }
  } catch (err) { console.warn('[label browse]', err); }
}

async function expandPlace(ctx) {
  const { node, onProgress } = ctx;
  onProgress(`visiting ${node.label}…`);
  const place = await mb.lookupPlace(node.mbid).catch(() => null);
  if (place) {
    node.data = place;
    if (!node.sublabel) node.sublabel = [place.type, place.area?.name].filter(Boolean).join(' · ');
    attachBio(node, mb.externalUrls(place));
  }
}

/* ── Shared plumbing ────────────────────────────────────────────────── */

/** Artist relations hanging off any entity: producers, players, writers. */
function linkArtistRelations(ctx, entity) {
  const { node } = ctx;
  for (const rel of mb.relationsOfType(entity, 'artist')) {
    if (ctx.budget <= 0) break;
    const a = rel.artist;
    if (!a?.id) continue;
    const kind = artistKind(a);
    const target = addNode({
      id: nodeId(kind, a.id),
      kind, mbType: 'artist', mbid: a.id,
      label: a.name, sublabel: a.disambiguation || '',
      depth: node.depth + 1,
    }, { near: node });
    if (!target) continue;
    linkRelation(ctx, node, target, rel);
  }
}

/** Create the edge for a MusicBrainz relation, respecting its direction. */
function linkRelation(ctx, current, other, rel, extra = null) {
  const forward = rel.direction !== 'backward';
  const phrase = describeRelation(rel);
  const kind = REL_EDGE_KIND[rel.type] || 'related';
  const a = forward ? current.id : other.id;
  const b = forward ? other.id : current.id;
  const edge = addEdge(a, b, kind, phrase);
  record(ctx, edge, other, extra, phrase);
}

/** Note a newly-created edge so the annotator can be told about it. */
function record(ctx, edge, other, extra, relationOverride) {
  if (!edge) return;
  ctx.budget--;
  // One note per edge, however many times we touched it this pass.
  if (ctx.added.some(a => a.edge.id === edge.id)) return;
  ctx.added.push({
    edge,
    otherLabel: other.label,
    otherKind: other.kind,
    relation: relationOverride || edge.label || edge.kind,
    extra: extra || undefined,
  });
}

/** Fetch a Wikipedia blurb in the background; never blocks the graph. */
function attachBio(node, urls) {
  node.urls = { ...(node.urls || {}), ...urls };
  if (node.bio) return Promise.resolve(node.bio);
  return summaryFor(urls).then(sum => {
    if (!sum) return null;
    node.bio = sum;
    if (!node.art && sum.image && node.kind !== 'album') node.art = sum.image;
    emit();
    return sum;
  }).catch(() => null);
}

/* ── Detail ─────────────────────────────────────────────────────────── */

/**
 * Fill in everything the detail sheet wants to *say* about a node, as
 * opposed to everything the graph wants to draw around it.
 *
 * This is deliberately separate from `expand`. Expanding adds twenty-odd
 * nodes, and writing a paragraph about every one of them the moment it
 * appears would be slow and, with the model layer on, expensive — most of
 * them are never opened. So the reading matter is fetched for one thing at
 * a time, when you actually open it, and cached on the node afterwards.
 *
 * Adds no nodes and no edges. Safe to call on anything, repeatedly.
 */
export async function detail(node, onProgress = () => {}) {
  if (!node || node.detailing || node.detailed) return;
  node.detailing = true;
  emit();

  try {
    await ensureData(node);
    emit();                                   // facts can show before the prose lands
    await attachBio(node, node.urls || {});
    await maybeProfile(node, onProgress);
    node.detailed = true;
  } catch (err) {
    console.warn('[detail]', node.label, err);
  } finally {
    node.detailing = false;
    emit();
  }
}

const LOOKUP = {
  artist: mb.lookupArtist,
  'release-group': mb.lookupReleaseGroup,
  release: mb.lookupRelease,
  recording: mb.lookupRecording,
  work: mb.lookupWork,
  label: mb.lookupLabel,
  place: mb.lookupPlace,
};

/* Most nodes arrive as a name and an id — everything else about them was
   only ever fetched if you expanded them. Opening one is reason enough to
   look it up properly, and the request cache makes a later expansion free. */
async function ensureData(node) {
  if (node.data || !node.mbid) return;
  const lookup = LOOKUP[node.mbType];
  if (!lookup) return;

  node.data = await lookup(node.mbid);
  node.tags = mb.topTags(node.data);
  if (!node.styles?.length) {
    const styles = mb.styleTags(node.data, 3);
    if (styles.length) node.styles = styles;
  }
  node.urls = { ...(node.urls || {}), ...mb.externalUrls(node.data) };
  if (node.mbType === 'artist' && !node.provisional) node.kind = artistKind(node.data);
}

/* Only when Wikipedia hasn't already answered the question. A well-covered
   band arrives with three paragraphs of sourced prose and needs nothing
   from a model; a B-side or a defunct studio arrives with nothing at all,
   and that is the gap worth paying for. */
async function maybeProfile(node, onProgress) {
  if (node.profile || node.profileTried || !hasLlm()) return;
  if (sentenceCount(node.bio?.extract) >= 5) return;

  node.profileTried = true;
  onProgress('reading up on it…');
  try {
    const text = await profile(
      { label: node.label, kind: kindLabel(node.kind) },
      factLines(node),
      node.bio?.extract || '',
    );
    if (text) { node.profile = text; emit(); }
  } catch (err) {
    console.warn('[profile]', node.label, err);
  }
}

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Names of settings-gated sources, for the UI to report on. */
export const activeSources = () => ({
  musicbrainz: true,
  wikipedia: true,
  coverart: settings().useCoverArt,
  lastfm: hasLastfm(),
  discogs: hasDiscogs(),
  llm: hasLlm(),
});
