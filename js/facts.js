/* "At a glance": the structured facts, read straight off MusicBrainz.

   This is the layer that works with no API keys at all and never guesses.
   Everything here is a field somebody typed into MusicBrainz, reformatted —
   if a value isn't there, the row simply doesn't appear. That matters,
   because the prose above it in the sheet may be written by a model, and a
   reader deserves one block on the page that is plainly just the record. */

import { fmtDate } from './model.js';
import { neighbours } from './state.js';
import * as mb from './sources/musicbrainz.js';

const credit = ac => mb.credit(ac);

/**
 * @returns {Array<{label: string, value: string}>}
 */
export function factsFor(node) {
  const d = node?.data;
  if (!d) return [];

  const role = node.role
    ? [{ label: 'Credited as', value: node.role }]
    : [];

  const rows = role.concat(({
    artist: artistFacts,
    'release-group': albumFacts,
    recording: songFacts,
    work: workFacts,
    label: labelFacts,
    place: placeFacts,
  }[node.mbType] || (() => []))(d, node));

  const styles = node.styles?.length ? node.styles : node.tags;
  if (styles?.length) rows.push({ label: 'Style', value: styles.slice(0, 4).join(' · ') });

  return rows.filter(r => r && r.value);
}

/* ── Per kind ───────────────────────────────────────────────────────── */

function artistFacts(d) {
  const person = d.type === 'Person' || d.type === 'Character';
  const ls = d['life-span'] || {};
  const members = (d.relations || []).filter(r => r.type === 'member of band');

  return [
    { label: 'Type', value: [d.type, d.disambiguation].filter(Boolean).join(' · ') },
    { label: 'From', value: d['begin-area']?.name || d.area?.name },
    { label: person ? 'Born' : 'Formed', value: fmtDate(ls.begin) },
    { label: person ? 'Died' : 'Disbanded', value: ls.ended ? fmtDate(ls.end) : '' },
    { label: 'Members on record', value: members.length ? String(members.length) : '' },
    { label: 'Releases listed', value: count(d['release-groups']) },
  ];
}

function albumFacts(d, node) {
  const kinds = [d['primary-type'], ...(d['secondary-types'] || [])].filter(Boolean);
  return [
    { label: 'By', value: credit(d['artist-credit']) },
    { label: 'Type', value: kinds.join(' · ') },
    { label: 'First released', value: fmtDate(d['first-release-date']) },
    { label: 'Label', value: node.labelName },
    { label: 'Recorded at', value: node.studioName },
    { label: 'Tracks', value: node.trackCount ? String(node.trackCount) : '' },
    { label: 'Pressings', value: count(d.releases) },
  ];
}

function songFacts(d) {
  const first = (d.releases || [])
    .slice()
    .sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')))[0];
  return [
    { label: 'By', value: credit(d['artist-credit']) },
    { label: 'Length', value: duration(d.length) },
    { label: 'First issued', value: fmtDate(first?.date) },
    { label: 'Appears on', value: first?.title },
    { label: 'Releases', value: count(d.releases) },
  ];
}

function workFacts(d) {
  const writers = (d.relations || [])
    .filter(r => /composer|lyricist|writer/.test(r.type))
    .map(r => r.artist?.name)
    .filter(Boolean);
  return [
    { label: 'Type', value: d.type },
    { label: 'Written by', value: [...new Set(writers)].slice(0, 4).join(', ') },
    { label: 'Language', value: (d.languages || []).join(', ') || d.language },
    { label: 'Recordings', value: count((d.relations || []).filter(r => r.recording)) },
  ];
}

function labelFacts(d) {
  const ls = d['life-span'] || {};
  return [
    { label: 'Type', value: [d.type, d.disambiguation].filter(Boolean).join(' · ') },
    { label: 'From', value: d.area?.name },
    { label: 'Founded', value: fmtDate(ls.begin) },
    { label: 'Closed', value: ls.ended ? fmtDate(ls.end) : '' },
    { label: 'Label code', value: d['label-code'] ? `LC ${d['label-code']}` : '' },
  ];
}

function placeFacts(d) {
  const ls = d['life-span'] || {};
  return [
    { label: 'Type', value: d.type },
    { label: 'Address', value: d.address },
    { label: 'Area', value: d.area?.name },
    { label: 'Opened', value: fmtDate(ls.begin) },
    { label: 'Closed', value: ls.ended ? fmtDate(ls.end) : '' },
  ];
}

/* ── Formatting ─────────────────────────────────────────────────────── */

const count = list => (Array.isArray(list) && list.length ? String(list.length) : '');

function duration(ms) {
  if (!ms || ms < 1000) return '';
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * The same facts as flat lines, for handing to the model that writes the
 * profile. It only ever gets told what MusicBrainz already knows.
 */
export function factLines(node) {
  const lines = factsFor(node).map(f => `${f.label}: ${f.value}`);
  if (node.sublabel) lines.unshift(`Listed as: ${node.sublabel}`);
  const tags = mb.topTags(node.data, 6);
  if (tags.length) lines.push(`Tagged: ${tags.join(', ')}`);
  return lines;
}

/**
 * A description assembled from the catalogue entry, for when there is no
 * article and no key to write one.
 *
 * The alternative was leaving the block out, which is what a sleeve
 * photographer used to get: a name, a job title and two rows. Everything
 * here is a field restated — no inference about what anyone was like, no
 * pronouns, and the last sentence says plainly where it came from.
 */
export function recordSummary(node) {
  if (!node?.data) return '';
  const d = node.data;
  const at = f => factsFor(node).find(r => r.label === f)?.value;
  const out = [];

  const list = xs => xs.length > 1
    ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`
    : xs[0];

  switch (node.mbType) {
    case 'artist': {
      out.push(node.role
        ? `${node.label} appears here as a ${node.role} rather than as a performer.`
        : `${node.label} is listed in MusicBrainz as ${d.type === 'Person' ? 'a person' : `a ${(d.type || 'group').toLowerCase()}`}.`);
      const origin = at('From'), began = at('Formed') || at('Born'), ended = at('Disbanded') || at('Died');
      if (origin || began) {
        out.push([
          origin ? `The catalogue gives ${origin} as the place of origin` : 'The catalogue records',
          began ? `${origin ? ', and ' : ' '}${at('Born') ? 'a birth date of' : 'a start in'} ${began}` : '',
          ended ? `, ending ${ended}` : '',
        ].join('') + '.');
      }
      const releases = at('Releases listed');
      out.push(releases
        ? `${releases} release${releases === '1' ? '' : 's'} are filed under this name.`
        : 'No releases are filed under this name.');
      break;
    }
    case 'release-group':
    case 'release':
      out.push(`${node.label} is ${article(at('Type') || 'a release')} by ${at('By') || 'an unlisted artist'}.`);
      if (at('First released')) out.push(`It was first released ${at('First released')}.`);
      if (at('Label') || at('Recorded at')) {
        out.push([at('Recorded at') && `cut at ${at('Recorded at')}`, at('Label') && `issued on ${at('Label')}`]
          .filter(Boolean).join(', ').replace(/^./, c => c.toUpperCase()) + '.');
      }
      break;
    case 'recording':
      out.push(`${node.label} is a recording credited to ${at('By') || 'an unlisted artist'}.`);
      if (at('Length')) out.push(`It runs ${at('Length')}.`);
      if (at('Appears on')) out.push(`The earliest release carrying it is ${at('Appears on')}${at('First issued') ? `, from ${at('First issued')}` : ''}.`);
      break;
    case 'place':
      out.push(`${node.label} is ${article(at('Type') || 'a place')}${at('Area') ? ` in ${at('Area')}` : ''}.`);
      if (at('Address')) out.push(`Its address is given as ${at('Address')}.`);
      if (at('Opened')) out.push(`It opened ${at('Opened')}${at('Closed') ? ` and closed ${at('Closed')}` : ''}.`);
      break;
    case 'label':
      out.push(`${node.label} is a record label${at('From') ? ` from ${at('From')}` : ''}.`);
      if (at('Founded')) out.push(`It was founded ${at('Founded')}${at('Closed') ? ` and closed ${at('Closed')}` : ''}.`);
      break;
    default:
      return '';
  }

  const links = neighbours(node.id).map(n => n.node.label).slice(0, 3);
  if (links.length) out.push(`On this web it connects to ${list(links)}.`);
  if (at('Style')) out.push(`Listeners have tagged it ${at('Style')}.`);

  out.push('No encyclopedia article was found for this entry, so the above is assembled from the catalogue rather than written.');
  return out.join(' ');
}

const article = s => `${/^[aeiou]/i.test(s) ? 'an' : 'a'} ${s.toLowerCase()}`;

/**
 * The node's own edges, as sentences.
 *
 * These are often the most identifying thing we hold. "Type: Person, From:
 * Paris" describes ten thousand people; "photographed Homogenic, directed
 * the video for Big Time Sensuality" names exactly one — and it's the
 * difference between a model writing the right entry and declining to
 * write one at all.
 */
export function relationLines(node, limit = 12) {
  if (!node?.id) return [];
  return neighbours(node.id)
    .slice(0, limit)
    .map(({ edge, node: other, outgoing }) => {
      const phrase = edge.label || edge.kind;
      // Edge labels read subject → object, and `outgoing` says which end
      // this node is standing on.
      return outgoing
        ? `${node.label} ${phrase} ${other.label}`
        : `${other.label} ${phrase} ${node.label}`;
    });
}
