/* Headless smoke test.

   Serves the app locally, stubs every outbound API with fixtures, and
   drives a full session in Chromium: search → pick a result → seed graph →
   expand a node → open the detail sheet. It asserts on the real module
   state (ES modules are per-document singletons, so re-importing gives the
   running instance) and fails on any console error.

   Run with:  NODE_PATH=$(npm root -g) node tools/smoke-test.mjs
   Requires Playwright; the app itself has no dependencies. */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

// ESM ignores NODE_PATH, and Playwright is usually installed globally rather
// than as a dependency of this project (which has none). Resolve it through
// the global root instead of forcing a package.json into the repo.
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  ({ chromium } = require(join(globalRoot, 'playwright')));
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

/* ── Fixtures ───────────────────────────────────────────────────────── */

const ARTIST_ID = '11111111-1111-1111-1111-111111111111';
const BAND_ID   = '22222222-2222-2222-2222-222222222222';
const RG_ID     = '33333333-3333-3333-3333-333333333333';
const REL_ID    = '44444444-4444-4444-4444-444444444444';
const REC_ID    = '55555555-5555-5555-5555-555555555555';
const PLACE_ID  = '66666666-6666-6666-6666-666666666666';
const LABEL_ID  = '77777777-7777-7777-7777-777777777777';

const fixtures = [
  [/ws\/2\/artist\?.*query=/, {
    artists: [{
      id: BAND_ID, name: 'The Testers', type: 'Group', score: 100,
      disambiguation: 'test band', area: { name: 'London' }, 'life-span': { begin: '1966' },
    }],
  }],
  [/ws\/2\/release-group\?.*query=/, {
    'release-groups': [{
      id: RG_ID, title: 'Proof of Concept', 'primary-type': 'Album',
      'first-release-date': '1967-12-05', score: 88,
      'artist-credit': [{ name: 'The Testers', artist: { id: BAND_ID, name: 'The Testers' } }],
    }],
  }],
  [/ws\/2\/recording\?.*query=/, {
    recordings: [{
      id: REC_ID, title: 'Assertion Blues', score: 70,
      'artist-credit': [{ name: 'The Testers', artist: { id: BAND_ID, name: 'The Testers' } }],
      releases: [{ id: REL_ID, title: 'Proof of Concept' }],
    }],
  }],
  [new RegExp(`ws/2/artist/${BAND_ID}`), {
    id: BAND_ID, name: 'The Testers', type: 'Group',
    disambiguation: 'test band', area: { name: 'London' },
    tags: [{ name: 'psychedelic rock', count: 9 }, { name: 'blues rock', count: 4 }],
    relations: [
      { type: 'member of band', direction: 'backward', 'target-type': 'artist',
        begin: '1966', end: '1968', ended: true, attributes: ['guitar', 'founder'],
        artist: { id: ARTIST_ID, name: 'Ada Fixture', type: 'Person' } },
      { type: 'wikidata', direction: 'forward', 'target-type': 'url',
        url: { resource: 'https://www.wikidata.org/wiki/Q4242' } },
    ],
    'release-groups': [
      { id: RG_ID, title: 'Proof of Concept', 'primary-type': 'Album', 'first-release-date': '1967-12-05' },
    ],
  }],
  [new RegExp(`ws/2/artist/${ARTIST_ID}`), {
    id: ARTIST_ID, name: 'Ada Fixture', type: 'Person', area: { name: 'Surrey' },
    tags: [], relations: [], 'release-groups': [],
  }],
  [new RegExp(`ws/2/release-group/${RG_ID}`), {
    id: RG_ID, title: 'Proof of Concept', 'primary-type': 'Album',
    'first-release-date': '1967-12-05',
    'artist-credit': [{ name: 'The Testers', artist: { id: BAND_ID, name: 'The Testers', type: 'Group' } }],
    tags: [{ name: 'psychedelic rock', count: 3 }],
    relations: [],
    releases: [{ id: REL_ID, title: 'Proof of Concept', date: '1967-12-05', country: 'GB' }],
  }],
  [new RegExp(`ws/2/release/${REL_ID}`), {
    id: REL_ID, title: 'Proof of Concept', date: '1967-12-05', country: 'GB',
    'artist-credit': [{ name: 'The Testers', artist: { id: BAND_ID, name: 'The Testers', type: 'Group' } }],
    'label-info': [{ 'catalog-number': 'TST 001', label: { id: LABEL_ID, name: 'Assert Records' } }],
    media: [{ tracks: [
      { position: 1, title: 'Assertion Blues', recording: { id: REC_ID, title: 'Assertion Blues' } },
    ] }],
    relations: [
      { type: 'recorded at', direction: 'forward', 'target-type': 'place', begin: '1967-06-01',
        place: { id: PLACE_ID, name: 'Regression Studios', type: 'Studio', area: { name: 'London' } } },
      { type: 'producer', direction: 'backward', 'target-type': 'artist',
        artist: { id: ARTIST_ID, name: 'Ada Fixture', type: 'Person' } },
    ],
  }],
  [/ws\/2\/release\?label=/, { releases: [] }],
  [/wikidata\.org/, { entities: { Q4242: { sitelinks: { enwiki: { title: 'The Testers' } } } } }],
  [/wikipedia\.org\/api\/rest_v1/, {
    extract: 'The Testers were a fictional English rock group formed in London in 1966.',
    content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/The_Testers' } },
  }],
];

/* ── Harness ────────────────────────────────────────────────────────── */

const server = createServer((req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  const file = join(ROOT, path === '/' ? 'index.html' : path);
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});

await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });

const errors = [];
page.on('console', m => {
  if (m.type() !== 'error') return;
  const t = m.text();
  // Missing cover art is a normal outcome, not a fault.
  if (/coverartarchive/.test(t) || (/Failed to load resource/.test(t) && /404/.test(t))) return;
  errors.push(t);
});
page.on('pageerror', e => errors.push(`uncaught: ${e.message}`));

let apiCalls = 0;
await page.route('**/*', route => {
  const url = route.request().url();
  if (url.startsWith(base)) return route.continue();
  apiCalls++;
  if (/coverartarchive\.org/.test(url)) return route.fulfill({ status: 404, body: '' });
  const hit = fixtures.find(([re]) => re.test(url));
  if (hit) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(hit[1]) });
  return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
});

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const state = () => page.evaluate(async () => {
  const m = await import('./js/state.js');
  return {
    nodes: m.nodeList().map(n => ({ id: n.id, kind: n.kind, label: n.label, expanded: n.expanded })),
    edges: m.edgeList().map(e => ({ kind: e.kind, label: e.label })),
    selected: m.graph.selectedId,
  };
});

try {
  await page.goto(base, { waitUntil: 'networkidle' });
  check('app boots', await page.isVisible('#launch'));

  await page.fill('#search-input', 'The Testers');
  await page.click('#search-go');
  await page.waitForSelector('.result[data-id]', { timeout: 20000 });
  await page.waitForTimeout(3500);   // let all three searches land

  const kinds = await page.$$eval('.result .kind', els => els.map(e => e.textContent.trim()));
  check('search returns mixed entity types', kinds.length >= 3, kinds.join(', '));

  await page.click('.result[data-id^="group:"]');
  await page.waitForFunction(async () => {
    const m = await import('./js/state.js');
    return m.nodeList().length > 1;
  }, null, { timeout: 20000 });
  await page.waitForTimeout(1500);

  let s = await state();
  check('seed expands into a graph', s.nodes.length >= 3, `${s.nodes.length} nodes, ${s.edges.length} edges`);
  check('band membership is captured',
    s.edges.some(e => e.kind === 'member'),
    s.edges.find(e => e.kind === 'member')?.label || 'missing');
  check('membership reads with instrument and dates',
    /guitar/.test(s.edges.find(e => e.kind === 'member')?.label || ''),
    s.edges.find(e => e.kind === 'member')?.label);
  check('album discovered from the band', s.nodes.some(n => n.kind === 'album'));
  check('launch screen dismissed', await page.isHidden('#launch'));
  check('legend reflects what is on screen', await page.isVisible('#legend'));

  // Select the album node and expand it — exercises the release path, which
  // is where studios and labels come from.
  const album = s.nodes.find(n => n.kind === 'album');
  await page.evaluate(async id => {
    const m = await import('./js/state.js');
    const { expand } = await import('./js/expand.js');
    m.graph.selectedId = id;
    m.emit();
    await expand(m.graph.nodes.get(id), () => {});
  }, album.id);
  await page.waitForTimeout(1200);

  s = await state();
  check('album expansion finds the studio', s.nodes.some(n => n.kind === 'place'),
    s.nodes.filter(n => n.kind === 'place').map(n => n.label).join(', '));
  check('album expansion finds the label', s.nodes.some(n => n.kind === 'label'));
  check('album expansion finds a track', s.nodes.some(n => n.kind === 'track'));
  check('studio edge carries a date',
    /1967/.test(s.edges.find(e => e.kind === 'recordedAt')?.label || ''),
    s.edges.find(e => e.kind === 'recordedAt')?.label);
  check('producer credit captured', s.edges.some(e => e.kind === 'produced'));

  // Detail sheet.
  await page.evaluate(async id => {
    const m = await import('./js/state.js');
    m.graph.selectedId = id;
    m.emit();
  }, album.id);
  await page.evaluate(() => document.getElementById('sheet').hidden = false);
  await page.waitForTimeout(200);

  const seedId = await page.evaluate(async () => (await import('./js/state.js')).graph.seedId);
  const sheetHtml = await page.evaluate(async id => {
    const { createPanel } = await import('./js/ui/panel.js');
    const m = await import('./js/state.js');
    const el = document.getElementById('sheet'), body = document.getElementById('sheet-body');
    const p = createPanel(el, body, {});
    p.show(m.graph.nodes.get(id));
    return body.innerHTML;
  }, seedId);
  check('detail sheet renders connections', /How it connects/.test(sheetHtml));
  check('detail sheet renders Wikipedia prose', /fictional English rock group/.test(sheetHtml));
  check('detail sheet offers listening links', /music\.apple\.com/.test(sheetHtml));

  // Canvas actually painted something.
  const painted = await page.evaluate(() => {
    const c = document.getElementById('graph');
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4 * 97) if (d[i] > 60 || d[i + 1] > 60 || d[i + 2] > 60) lit++;
    return lit;
  });
  check('canvas is drawing the graph', painted > 20, `${painted} lit samples`);

  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  check('API calls were throttled and cached', apiCalls > 0 && apiCalls < 40, `${apiCalls} outbound requests`);
} catch (err) {
  check('test run completed', false, err.message);
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
