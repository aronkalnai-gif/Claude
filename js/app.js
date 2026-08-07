/* Wiring. Everything interesting happens elsewhere; this file's job is to
   connect the search box, the canvas, the sheet and the settings modal to
   each other and stay out of the way. */

import { graph, reset, onChange, emit, nodeList, MAX_NODES } from './state.js';
import { searchAll, rankCandidates } from './sources/musicbrainz.js';
import { makeSeed, expand } from './expand.js';
import { createRenderer } from './graph/render.js';
import { createPanel } from './ui/panel.js';
import { createModal } from './ui/settings.js';
import { KIND, kindLabel } from './model.js';
import { settings } from './config.js';

/* ── Elements ───────────────────────────────────────────────────────── */

const $ = id => document.getElementById(id);

const launch      = $('launch');
const form        = $('search-form');
const input       = $('search-input');
const resultsEl   = $('results');
const suggestions = $('suggestions');
const statusEl    = $('status');
const statusText  = $('status-text');
const seedChip    = $('seed-chip');
const legend      = $('legend');
const sheet       = $('sheet');

/* ── Pieces ─────────────────────────────────────────────────────────── */

const renderer = createRenderer($('graph'), {
  onTapNode: node => select(node.id),
  onTapBackground: () => { graph.selectedId = null; panel.hide(); syncInsets(); emit(); },
  onDoubleTapNode: node => grow(node),
});

const panel = createPanel(sheet, $('sheet-body'), {
  onExpand: node => grow(node),
  onSelect: id => select(id),
  onClose: () => { graph.selectedId = null; panel.hide(); syncInsets(); emit(); },
});

const modal = createModal($('modal'), $('modal-title'), $('modal-body'), $('modal-close'));

onChange(() => {
  renderer.kick();
  if (panel.current) panel.render();
});

/* Keep the camera aware of how much canvas the sheet is covering, so
   "fit" and "centre on this node" never park something underneath it. */
const railOpen = () => window.matchMedia('(min-width: 900px) and (orientation: landscape)').matches;

function syncInsets() {
  const covered = !sheet.hidden && !railOpen();
  // The legend lives bottom-left, which is exactly where the bottom sheet
  // slides in. Nothing is gained by leaving it buried underneath.
  legend.classList.toggle('tucked', covered);

  if (sheet.hidden) return renderer.setInsets({});
  renderer.setInsets(railOpen()
    ? { right: sheet.offsetWidth + 24 }
    : { bottom: Math.min(sheet.offsetHeight, window.innerHeight * 0.55) });
}

new ResizeObserver(syncInsets).observe(sheet);
window.addEventListener('orientationchange', () => setTimeout(syncInsets, 300));

/* ── Search ─────────────────────────────────────────────────────────── */

let searchToken = 0;
let candidates = [];

form.addEventListener('submit', async e => {
  e.preventDefault();
  const query = input.value.trim();
  if (!query) return;
  input.blur();
  await runSearch(query);
});

suggestions.addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  input.value = chip.dataset.q;
  runSearch(chip.dataset.q);
});

resultsEl.addEventListener('click', e => {
  const row = e.target.closest('.result');
  if (!row) return;
  const pick = candidates.find(c => `${c.kind}:${c.mbid}` === row.dataset.id);
  if (pick) start(pick);
});

async function runSearch(query) {
  const token = ++searchToken;
  candidates = [];
  resultsEl.hidden = false;
  resultsEl.innerHTML = `<div class="result"><div class="who"><b>Searching…</b>
    <small>MusicBrainz allows one request a second, so this takes a moment.</small></div></div>`;

  try {
    await searchAll(query, batch => {
      if (token !== searchToken) return;
      candidates = rankCandidates([...candidates, ...batch]);
      drawResults();
    });
    if (token !== searchToken) return;
    if (!candidates.length) {
      resultsEl.innerHTML = `<div class="result"><div class="who"><b>Nothing found</b>
        <small>Try a different spelling, or add the artist's name to an album or song title.</small></div></div>`;
    }
  } catch (err) {
    if (token !== searchToken) return;
    resultsEl.innerHTML = `<div class="result"><div class="who"><b>Search failed</b>
      <small>${esc(err.message || String(err))} — run diagnostics to see which source is unhappy.</small></div></div>`;
  }
}

function drawResults() {
  resultsEl.innerHTML = candidates.map(c => {
    const color = KIND[c.kind]?.color || '#8FA3B8';
    return `<button class="result" data-id="${esc(c.kind)}:${esc(c.mbid)}">
      <span class="kind" style="background:${hexA(color, .16)};color:${color}">${esc(kindLabel(c.kind))}</span>
      <span class="who"><b>${esc(c.label)}</b>${c.sublabel ? `<small>${esc(c.sublabel)}</small>` : ''}</span>
    </button>`;
  }).join('');
}

/* ── Graph lifecycle ────────────────────────────────────────────────── */

async function start(candidate) {
  reset();
  panel.hide();
  const seed = makeSeed(candidate);
  if (!seed) return;

  launch.classList.add('leaving');
  setTimeout(() => { launch.hidden = true; launch.classList.remove('leaving'); }, 320);

  seedChip.hidden = false;
  seedChip.textContent = candidate.label;
  drawLegend();
  renderer.reheat(1);

  await grow(seed, { fit: true, select: true });
}

async function grow(node, { fit = true, select: selectAfter = false } = {}) {
  if (!node || node.expanding) return;
  if (nodeList().length >= MAX_NODES) {
    return status(`That's ${MAX_NODES} nodes — start a new search to keep it readable.`, { error: true, hold: 4000 });
  }

  status(`Opening ${node.label}…`);
  renderer.reheat(0.85);

  try {
    await expand(node, msg => status(msg));
    status('');
    drawLegend();
    if (selectAfter) select(node.id, { center: false });
    if (fit) setTimeout(() => renderer.fitToGraph(), 420);
  } catch (err) {
    status(err?.message || 'That lookup failed', { error: true, hold: 5000 });
  }
}

function select(id, { center = true } = {}) {
  const node = graph.nodes.get(id);
  if (!node) return;
  graph.selectedId = id;
  panel.show(node);
  syncInsets();                 // the sheet just changed how much canvas is visible
  if (center) renderer.centerOn(node);
  emit();
}

/* ── Chrome ─────────────────────────────────────────────────────────── */

let statusTimer = null;
function status(msg, { error = false, hold = 0 } = {}) {
  clearTimeout(statusTimer);
  if (!msg) { statusEl.hidden = true; return; }
  statusEl.hidden = false;
  statusEl.classList.toggle('error', error);
  statusText.textContent = msg;
  if (hold) statusTimer = setTimeout(() => { statusEl.hidden = true; }, hold);
}

function drawLegend() {
  const present = new Set(nodeList().map(n => n.kind));
  if (!present.size) { legend.hidden = true; return; }
  legend.hidden = false;
  legend.innerHTML = [...present]
    .map(k => `<span><i style="background:${KIND[k]?.color || '#8FA3B8'}"></i>${esc(kindLabel(k))}</span>`)
    .join('');
}

$('btn-home').onclick = () => {
  searchToken++;
  reset();
  panel.hide();
  seedChip.hidden = true;
  legend.hidden = true;
  status('');
  resultsEl.hidden = true;
  launch.hidden = false;
  input.value = '';
  setTimeout(() => input.focus(), 80);
};

$('btn-recenter').onclick = () => renderer.fitToGraph();
$('btn-settings').onclick = () => modal.openSettings();
$('launch-settings').onclick = () => modal.openSettings();
$('launch-diag').onclick = () => modal.openDiagnostics();

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('modal').hidden) modal.hide();
  else if (!sheet.hidden) { graph.selectedId = null; panel.hide(); syncInsets(); emit(); }
});

/* Nudge first-timers toward the sources that make this app good. */
if (!settings().lastfmKey && !settings().anthropicKey) {
  setTimeout(() => {
    if (!launch.hidden) status('Works out of the box · connect Last.fm or Claude for more', { hold: 7000 });
  }, 1400);
}

setTimeout(() => { if (!launch.hidden) input.focus(); }, 300);

/* ── Offline shell ──────────────────────────────────────────────────── */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* fine without it */ });
  });
}

/* ── Helpers ────────────────────────────────────────────────────────── */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
