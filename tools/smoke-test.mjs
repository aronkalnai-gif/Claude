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
const SINGLE_ID = '88888888-8888-8888-8888-888888888888';
const KIN_A     = 'aaaaaaaa-0000-0000-0000-000000000001';
const KIN_B     = 'aaaaaaaa-0000-0000-0000-000000000002';
// MusicBrainz's real special-purpose ids, plus a bracketed name it doesn't
// have an id for — the naming convention has to carry those on its own.
const VARIOUS   = '89ad4ac3-39f7-470e-963a-56509c546377';
const UNKNOWN   = '125ec42a-7229-4250-afc5-e057484327fe';
const DISNEY    = 'cccccccc-0000-0000-0000-00000000000d';
// And the counter-example: a real band whose name is in brackets.
const SPUNGE    = 'cccccccc-0000-0000-0000-00000000000e';
// The sleeve photographer — real credit, no music of his own.
const SHOOTER   = 'cccccccc-0000-0000-0000-00000000000f';

const fixtures = [
  // Songs in a style, by strangers. Includes one recording by the seed band
  // itself and one whose title is already on the graph — both must be
  // filtered out rather than drawn.
  [/ws\/2\/recording\?.*tag/, {
    recordings: [
      { id: 'bbbbbbbb-0000-0000-0000-000000000001', title: 'Fixture Drift', score: 95,
        'artist-credit': [{ name: 'Mock Turtle Soup', artist: { id: KIN_A, name: 'Mock Turtle Soup' } }] },
      { id: 'bbbbbbbb-0000-0000-0000-000000000002', title: 'Regression', score: 93,
        'artist-credit': [{ name: 'The Stub Sessions', artist: { id: KIN_B, name: 'The Stub Sessions' } }] },
      { id: 'bbbbbbbb-0000-0000-0000-000000000003', title: 'Own Work', score: 91,
        'artist-credit': [{ name: 'The Testers', artist: { id: BAND_ID, name: 'The Testers' } }] },
      { id: 'bbbbbbbb-0000-0000-0000-000000000004', title: 'Second Stranger', score: 90,
        'artist-credit': [{ name: 'Mock Turtle Soup', artist: { id: KIN_A, name: 'Mock Turtle Soup' } }] },
    ],
  }],
  // Stylistic kinship: a tag query, answered with two artists in that style
  // plus the seed itself (which must be filtered out).
  [/ws\/2\/artist\?.*tag/, {
    artists: [
      { id: BAND_ID, name: 'The Testers', type: 'Group', score: 100 },
      // Placeholders are tagged with everything, so a tag search is exactly
      // where they turn up. None of these may reach the graph.
      { id: VARIOUS, name: 'Various Artists', type: 'Other', score: 99 },
      { id: UNKNOWN, name: '[unknown]', type: 'Other', score: 98 },
      { id: DISNEY, name: '[Disney]', type: 'Other', score: 97 },
      { id: KIN_A, name: 'Mock Turtle Soup', type: 'Group', score: 92 },
      { id: SPUNGE, name: '[spunge]', type: 'Group', score: 90 },
      { id: KIN_B, name: 'The Stub Sessions', type: 'Group', score: 88 },
    ],
  }],
  [/ws\/2\/artist\?.*query=/, {
    artists: [
      {
        id: BAND_ID, name: 'The Testers', type: 'Group', score: 100,
        disambiguation: 'test band', area: { name: 'London' }, 'life-span': { begin: '1966' },
      },
      // Searching a common word surfaces this constantly. It must never be
      // offered as something you can start a graph from.
      { id: VARIOUS, name: 'Various Artists', type: 'Other', score: 99 },
    ],
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
    'life-span': { begin: '1966', end: '1972', ended: true },
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
      { id: SINGLE_ID, title: 'Regression', 'primary-type': 'Single', 'first-release-date': '1967-08-01' },
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
      // Same title as the single above, under a different MBID — exactly the
      // shape that used to draw one song twice.
      { position: 2, title: 'Regression', recording: { id: '99999999-9999-9999-9999-999999999999', title: 'Regression' } },
    ] }],
    relations: [
      { type: 'recorded at', direction: 'forward', 'target-type': 'place', begin: '1967-06-01',
        place: { id: PLACE_ID, name: 'Regression Studios', type: 'Studio', area: { name: 'London' } } },
      { type: 'producer', direction: 'backward', 'target-type': 'artist',
        artist: { id: ARTIST_ID, name: 'Ada Fixture', type: 'Person' } },
      // The Sednaoui case: credited on the record, not a musician.
      { type: 'photography', direction: 'backward', 'target-type': 'artist',
        artist: { id: SHOOTER, name: 'Lens Cap', type: 'Person' } },
    ],
  }],
  [new RegExp(`ws/2/artist/${SHOOTER}`), {
    id: SHOOTER, name: 'Lens Cap', type: 'Person', area: { name: 'Paris' },
    tags: [], 'release-groups': [],
    relations: [
      { type: 'photography', direction: 'forward', 'target-type': 'release',
        release: { id: REL_ID, title: 'Proof of Concept' } },
    ],
  }],
  [/ws\/2\/release\?label=/, { releases: [] }],
  [/wikidata\.org/, { entities: { Q4242: { sitelinks: { enwiki: { title: 'The Testers' } } } } }],
  // The lead section, as the Action API returns it — several sentences, so
  // the sheet has something worth reading and the profile layer stays out
  // of the way.
  [/en\.wikipedia\.org\/w\/api\.php/, {
    query: {
      pages: {
        4242: {
          pageid: 4242,
          title: 'The Testers',
          fullurl: 'https://en.wikipedia.org/wiki/The_Testers',
          extract:
            'The Testers were a fictional English rock group formed in London in 1966. ' +
            'The band was built around guitarist Ada Fixture and a rhythm section drawn from the city\'s club circuit. ' +
            'Their second album, Regression, was cut over three weeks at Regression Studios in the summer of 1967. ' +
            'Contemporary reviewers noted the group\'s unusually dry drum sound, which the engineer achieved by damping the kit with tea towels. ' +
            'They disbanded in 1972 after a final tour of the Low Countries. ' +
            'Reissues in the 1990s brought the catalogue back into print and a modest cult following with it.',
          thumbnail: { source: 'https://upload.wikimedia.org/testers.jpg' },
        },
      },
    },
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

/* Poll from Node rather than using page.waitForFunction.
   waitForFunction evaluates the predicate in the page and checks the result
   for truthiness — and an async predicate returns a *Promise*, which is
   always truthy. Every such wait therefore succeeds on its first tick and
   waits for nothing. Reading module state needs a dynamic import, so the
   predicate has to be async; polling here keeps the await honest. */
async function waitFor(label, predicate, timeout = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await page.evaluate(predicate)) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const state = () => page.evaluate(async () => {
  const m = await import('./js/state.js');
  return {
    nodes: m.nodeList().map(n => ({ id: n.id, kind: n.kind, label: n.label, sublabel: n.sublabel, expanded: n.expanded })),
    edges: m.edgeList().map(e => ({ kind: e.kind, label: e.label, a: e.a, b: e.b })),
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

  // Checked while the list is still on screen — it's gone once we click.
  const offered = await page.$$eval('.result', els => els.map(e => e.textContent.trim()));
  check('placeholders are not offered as something to search for',
    !offered.some(t => /Various Artists/.test(t)),
    offered.join(' / ').slice(0, 90));

  await page.click('.result[data-id^="group:"]');
  // Wait for the expansion to actually finish rather than for the first
  // nodes to appear: it makes several sequential MusicBrainz calls, and the
  // rate limit means the last of them lands seconds after the first.
  await waitFor('the seed expansion to finish', async () => {
    const m = await import('./js/state.js');
    return m.graph.nodes.get(m.graph.seedId)?.expanded === true;
  });
  await page.waitForTimeout(400);

  let s = await state();
  check('seed expands into a graph', s.nodes.length >= 3, `${s.nodes.length} nodes, ${s.edges.length} edges`);
  check('band membership is captured',
    s.edges.some(e => e.kind === 'member'),
    s.edges.find(e => e.kind === 'member')?.label || 'missing');
  check('membership reads with instrument and dates',
    /guitar/.test(s.edges.find(e => e.kind === 'member')?.label || ''),
    s.edges.find(e => e.kind === 'member')?.label);
  check('album discovered from the band', s.nodes.some(n => n.kind === 'album'));
  check('individual songs surface alongside the albums',
    s.nodes.some(n => n.kind === 'track'),
    s.nodes.filter(n => n.kind === 'track').map(n => n.label).join(', '));
  check('stylistic kin are found by style, not by audience',
    s.edges.some(e => e.kind === 'style'),
    s.edges.find(e => e.kind === 'style')?.label || 'no style edge');
  check('the style edge names the shared style',
    /psychedelic rock/.test(s.edges.find(e => e.kind === 'style')?.label || ''),
    s.edges.find(e => e.kind === 'style')?.label);
  check('the seed is not listed as its own stylistic kin',
    s.edges.filter(e => e.kind === 'style').every(e => e.a !== e.b) &&
    s.nodes.filter(n => n.label === 'The Testers').length === 1,
    s.edges.filter(e => e.kind === 'style').map(e => `${e.a}→${e.b}`).join(' '));
  check('unrelated songs that merely sound alike are offered',
    s.nodes.some(n => n.label === 'Fixture Drift'),
    s.edges.find(e => /in the same style/.test(e.label || ''))?.label || 'none');
  check('such a song is not presented as the artist\'s own work',
    /in the same style/.test(
      s.edges.find(e => e.b === s.nodes.find(n => n.label === 'Fixture Drift')?.id)?.label || ''));
  check('and it names who actually recorded it',
    /Mock Turtle Soup/.test(s.nodes.find(n => n.label === 'Fixture Drift')?.sublabel || ''),
    s.nodes.find(n => n.label === 'Fixture Drift')?.sublabel);
  check('a style match by the artist themselves is not offered as a stranger',
    !s.nodes.some(n => n.label === 'Own Work'));

  // MusicBrainz placeholders. Left alone they connect everything to
  // everything: Various Artists alone stands in for hundreds of thousands
  // of compilations.
  const stubs = s.nodes.filter(n =>
    /^(various artists|\[unknown\]|\[Disney\]|\[no artist\]|\[dialogue\])$/i.test(n.label));
  check('MusicBrainz placeholders never reach the graph',
    stubs.length === 0,
    stubs.length ? stubs.map(n => n.label).join(', ') : 'none of Various Artists, [unknown], [Disney]');
  check('a real band whose name is in brackets is kept',
    s.nodes.some(n => n.label === '[spunge]'));
  check('no co-listening edges remain',
    !s.edges.some(e => e.kind === 'similar'));
  check('a song carries how it was released',
    /single/.test(s.edges.find(e => e.kind === 'performed')?.label || ''),
    s.edges.find(e => e.kind === 'performed')?.label);
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
  check('one song is not drawn twice under two MBIDs',
    s.nodes.filter(n => n.kind === 'track' && n.label === 'Regression').length === 1,
    `${s.nodes.filter(n => n.kind === 'track').map(n => n.label).join(', ')}`);

  // Let the layout finish, then check nothing is piled up. A second
  // expansion lands on an already-cooled graph, which is exactly the case
  // where new nodes used to freeze wherever they were seeded.
  await page.waitForTimeout(9000);
  const pileup = await page.evaluate(async () => {
    const m = await import('./js/state.js');
    const nodes = m.nodeList();
    let overlaps = 0, worst = 0;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        const need = a.r + b.r;
        if (d < need) { overlaps++; worst = Math.max(worst, need - d); }
      }
    }
    return { overlaps, worst: Math.round(worst), n: nodes.length };
  });
  check('nothing is piled up after a second expansion',
    pileup.overlaps === 0,
    `${pileup.overlaps} overlapping pairs across ${pileup.n} nodes` +
    (pileup.worst ? `, worst ${pileup.worst}px` : ''));

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

  // The whole point of the About section is that there's something to read.
  const prose = (sheetHtml.match(/<p class="bio">([\s\S]*?)<\/p>/) || [])[1] || '';
  const sentences = (prose.match(/[^.!?]+[.!?]/g) || []).length;
  check('about section runs to several sentences', sentences >= 5, `${sentences} sentences`);

  check('at a glance lists structured facts',
    /At a glance/.test(sheetHtml) && /Formed/.test(sheetHtml) && /London/.test(sheetHtml));

  // Opening something you never expanded should still fill its sheet — this
  // is the path that runs with no API keys at all.
  const cold = await page.evaluate(async () => {
    const m = await import('./js/state.js');
    const { detail } = await import('./js/expand.js');
    const { factsFor } = await import('./js/facts.js');
    const person = [...m.graph.nodes.values()].find(n => n.kind === 'person' && !n.data);
    if (!person) return { skipped: true };
    await detail(person);
    return { rows: factsFor(person), label: person.label };
  });
  // Non-musical credits. The relation has to name itself, and the person
  // must not be offered three search links that lead nowhere.
  const crew = await page.evaluate(async () => {
    const m = await import('./js/state.js');
    const { detail } = await import('./js/expand.js');
    const { canListen } = await import('./js/model.js');
    const { createPanel } = await import('./js/ui/panel.js');
    const shooter = [...m.graph.nodes.values()].find(n => n.label === 'Lens Cap');
    if (!shooter) return { missing: true };
    await detail(shooter);

    const el = document.getElementById('sheet'), body = document.getElementById('sheet-body');
    const p = createPanel(el, body, {});
    p.show(shooter);
    const own = body.innerHTML;

    // And the same edge read from the record's side.
    const album = [...m.graph.nodes.values()].find(n => n.label === 'Proof of Concept');
    p.show(album);
    const fromAlbum = body.innerHTML;

    return {
      role: shooter.role,
      sublabel: shooter.sublabel,
      listen: canListen(shooter),
      albumListens: canListen(album),
      edge: [...m.graph.edges.values()].find(e => e.kind === 'offstage')?.label,
      own, fromAlbum,
    };
  });

  check('a non-musical credit says what it was',
    crew.edge === 'photographed', crew.edge || 'no offstage edge');
  check('and it reads correctly from the other end',
    /was photographed by/.test(crew.fromAlbum || ''),
    (crew.fromAlbum?.match(/was photographed by[^<]*/) || ['not found'])[0]);
  check('the person is labelled by what they actually did',
    crew.role === 'photographer' && crew.sublabel === 'photographer', crew.sublabel);
  check('someone with no music of their own is offered nowhere to listen',
    crew.listen === false && !/music\.apple\.com/.test(crew.own || ''));
  check('while a record still is', crew.albumListens === true);

  // With no article and no model key, the sheet still has to say something.
  const summary = (crew.own?.match(/<p class="bio">([\s\S]*?)<\/p>/) || [])[1] || '';
  check('a non-musician still gets a description',
    /photographer rather than as a performer/.test(summary) &&
    (summary.match(/[^.!?]+[.!?]/g) || []).length >= 4,
    `${(summary.match(/[^.!?]+[.!?]/g) || []).length} sentences`);
  check('and it says where it came from',
    /assembled from the catalogue rather than written/.test(summary));

  // A node with nothing behind it must stop offering a button that does
  // nothing. Ada Fixture's lookup has no relations and no releases.
  const dead = await page.evaluate(async () => {
    const m = await import('./js/state.js');
    const { expand } = await import('./js/expand.js');
    const person = [...m.graph.nodes.values()].find(n => n.label === 'Ada Fixture');
    if (!person) return { missing: true };
    await expand(person).catch(() => {});
    const { createPanel } = await import('./js/ui/panel.js');
    const p = createPanel(document.getElementById('sheet'), document.getElementById('sheet-body'), {});
    p.show(person);
    const btn = document.querySelector('#sheet-body [data-act="expand"]');
    return { unlinked: !!person.unlinked, label: btn?.textContent.trim(), disabled: !!btn?.disabled };
  });
  check('a node with nothing behind it stops offering to expand',
    dead.unlinked && dead.disabled && /Nothing more to open/.test(dead.label || ''),
    dead.missing ? 'Ada Fixture not in the graph' : `button: "${dead.label}", disabled: ${dead.disabled}`);

  check('opening an unexpanded node fetches its own facts',
    !cold.skipped && cold.rows.length >= 2 && cold.rows.some(r => /Surrey/.test(r.value)),
    cold.skipped ? 'no unexpanded person in the graph'
                 : `${cold.label}: ${cold.rows.map(r => `${r.label} ${r.value}`).join(', ')}`);

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
