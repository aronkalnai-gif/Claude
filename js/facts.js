/* "At a glance": the structured facts, read straight off MusicBrainz.

   This is the layer that works with no API keys at all and never guesses.
   Everything here is a field somebody typed into MusicBrainz, reformatted —
   if a value isn't there, the row simply doesn't appear. That matters,
   because the prose above it in the sheet may be written by a model, and a
   reader deserves one block on the page that is plainly just the record. */

import { fmtDate } from './model.js';
import * as mb from './sources/musicbrainz.js';

const credit = ac => mb.credit(ac);

/**
 * @returns {Array<{label: string, value: string}>}
 */
export function factsFor(node) {
  const d = node?.data;
  if (!d) return [];

  const rows = ({
    artist: artistFacts,
    'release-group': albumFacts,
    recording: songFacts,
    work: workFacts,
    label: labelFacts,
    place: placeFacts,
  }[node.mbType] || (() => []))(d, node);

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
