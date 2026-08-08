# Odyssey

Name a song, a record, a band or a person. Odyssey draws the web they sit in —
bandmates, albums, individual songs, the studio the session happened in, the
label that pressed it, the people who produced and played on it, and the
artists that sound like them — and tells you *why* each connection exists.

Tap any node to open it and the web grows from there.

It's a single static page with no build step and no server, designed to be
saved to an iPad home screen and used like a native app.

---

## Getting it onto your iPad

**1. Put it online.** Anywhere that serves static files works. The repo ships a
GitHub Pages workflow, so the simplest path is:

- Repo → **Settings → Pages → Source: GitHub Actions**. This is the one step
  that can't be done from a commit, and it only needs doing once.
- Push to the default branch. The workflow publishes on every such push —
  it reads the default branch's name rather than assuming `main`, so it
  works whatever yours is called.
- Watch it under the **Actions** tab; your URL will be
  `https://<your-username>.github.io/<repo>/`

Every path in the app is relative, so serving it from a repo subpath is fine.

It must be served over **https** (or `localhost`). Service workers, and
several of the APIs, refuse to run otherwise.

**2. Add it to the home screen.** Open the URL in Safari on the iPad →
Share → **Add to Home Screen**. It then launches full-screen with its own
icon, no browser chrome, and works in both orientations.

**3. Connect the optional sources.** Tap the gear → paste whichever keys you
have (see below) → **Save**. Then run **Diagnostics** once to confirm each
source is actually reachable from the device.

### Running it locally

```sh
npx http-server -p 8080 .     # or: python3 -m http.server 8080
open http://localhost:8080
```

---

## What each source contributes

Nothing is required except the first two, which need no signup at all. The app
is fully usable the moment you open it; the optional keys each add a distinct
*kind* of connection rather than just more of the same.

| Source | Key needed | What it adds |
|---|---|---|
| **MusicBrainz** | — | The backbone. Band membership with instruments and date ranges, producer/engineer credits, which studio a session happened in, which label pressed it, singles, tracklists, the song-behind-the-recording that links covers to originals, and — via its tag index — other artists and songs working in the same style. |
| **Wikipedia** | — | The prose — the article's whole lead section, which is usually five or six sentences rather than the one the REST summary endpoint returns. Resolved via the Wikidata id MusicBrainz already stores, so it lands on the right article instead of guessing from a name. |
| **Cover Art Archive** | — | Sleeve art on album and single nodes. |
| **Last.fm** | free key | An artist's most-played songs, which is a better answer to "what are they known for" than whatever happened to get pressed as a single; and tags that fill in a style for artists MusicBrainz hasn't tagged yet. [Get a key](https://www.last.fm/api/account/create) |
| **Discogs** | free token | Session personnel: the sidemen and engineers on older records, where MusicBrainz often thins out. [Generate a token](https://www.discogs.com/settings/developers) |
| **Claude** | API key | Two jobs. It turns each structured relationship into a sentence of real context, and it writes the five-or-six-sentence entry for the songs, studios and small labels Wikipedia has no article for — which is most songs. Grounded in the facts it's given, and instructed to write less rather than invent. [Console](https://console.anthropic.com/settings/keys) |

### About the keys

They're stored in this browser's local storage on this device, and sent only to
the service each one belongs to. That's the trade for having no server: it's
the right call for a personal app on your own iPad, and the wrong one for a
site you share. Use keys you're willing to rotate, and don't host this on a
domain other people use.

The Claude notes cost roughly a fraction of a cent per expansion — one request
per tap, short structured output, extended thinking off.

---

## How it works

```
index.html
css/app.css
js/
  app.js                 wiring: search box ↔ canvas ↔ sheet ↔ settings
  state.js               the graph store — nodes, edges, dedupe
  model.js               node kinds, edge kinds, and relationship → English
  net.js                 per-host throttling, caching, honest errors
  config.js              settings and keys
  expand.js              the heart: given one thing, what belongs beside it,
                         plus what to read about it when you open it
  facts.js               "at a glance": MusicBrainz fields, reformatted
  graph/layout.js        hand-rolled force simulation
  graph/render.js        canvas renderer, pinch/pan/tap/drag
  ui/panel.js            the detail sheet
  ui/settings.js         settings form + on-device diagnostics
  sources/*.js           one file per data source
tools/
  ship.mjs               the logo, as coordinates: Odysseus's galley
  make-icons.mjs         draws ship.mjs to icons/*.png and icon.svg
  smoke-test.mjs         headless end-to-end test
```

A few decisions worth knowing about:

**Throttling is not optional.** MusicBrainz allows one request per second and
enforces it with 503s. `net.js` runs a serial queue per host and caches
everything for a fortnight, so re-opening a node you've already visited is
instant and free.

**Every source is allowed to fail.** A dead Last.fm key costs you the
similarity edges, not the band members. Expansion catches per-source and keeps
whatever it managed to gather.

**Edge weight is distance.** A bandmate sits tight against their band; a
"sounds a bit like" tie floats out at the edge. The strength of a relationship
is something you can read at a glance without touching anything.

**Placeholders are refused at the door.** MusicBrainz keeps special-purpose
entities that stand in for the *absence* of an artist — a compilation is
credited to Various Artists, an untitled field recording to `[unknown]`, a
spoken interlude to `[dialogue]`. They are bookkeeping, and they are poison
here: Various Artists alone stands in for hundreds of thousands of
compilations, so opening it joins Elvis Presley to Madonna to Bruce
Springsteen by way of nothing at all. Every node `expand.js` creates passes
through one wrapper that drops them, because a rule enforced at eleven of
twelve call sites is not a rule. The ids are a belt; the naming convention
is the braces — except for the ska band `[spunge]`, so a bracketed name only
counts as a stub when MusicBrainz hasn't typed it as a group.

**A button that does nothing shouldn't be offered.** Expansion is
deterministic over cached data, so a pass that added nothing means the next
one would add nothing either. When that happens the node is marked closed,
the button reads "Nothing more to open", and the little dot that says
"there's more here" comes off it on the canvas.

**Reading matter is fetched when you open something, not when it appears.**
One expansion adds twenty-odd nodes and most are never opened, so writing a
paragraph about each on arrival would be slow and — with the model layer on —
expensive. `detail()` runs for one node at a time, when you tap it, and
caches on the node afterwards. It looks a node up properly even if you never
expanded it, which is why tapping a name you've never opened still fills a
sheet.

**One paragraph, and you can always tell who wrote it.** The About block is
Wikipedia's lead section when there's a real article, and Claude's entry when
there isn't — never both, and the model is only asked at all when Wikipedia
gave fewer than five sentences. A model-written paragraph says so underneath
in as many words. Below it, "At a glance" is nothing but MusicBrainz fields
reformatted: no source has been asked to interpret anything, an absent value
just omits its row, and it works with no API keys at all. That block exists
so there's always one part of the page a reader knows is simply the record.

**Stylistic, not statistical.** Connections between artists who never met
come from shared *style* — MusicBrainz tags, queried through its search
index — not from co-listening data. "People who play this also play that"
describes an audience, and an audience overlap is often an accident of era
or playlist rather than anything you can hear. A tag only earns an edge if
it's specific enough to be a claim about the music: "hard bop" and
"psychedelic folk" qualify, "rock" doesn't. A useful side effect is that
stylistic connections need no API key at all.

Style is the one thing on the graph that isn't a documented fact, and it
gets two shapes. Other *artists* working the same seam are drawn with
"both hard bop". Individual *songs* by people with no connection to the
artist at all — pure "you might like this" — are drawn with "in the same
style", never "released", and always carrying whoever actually recorded
them: an unqualified song beside a band would imply an authorship the data
doesn't support. Anything genuinely by the artist is filtered out of that
set, because a song they recorded is a fact about them and belongs on a
factual edge instead. Both kinds are dashed, and sort below every
documented relationship in the panel.

**Songs come from two directions.** Last.fm knows which songs people actually
play; MusicBrainz knows which ones were pressed as singles, at no extra
request since the artist lookup already carries them. The same song often
exists under both a single's id and a recording's id, so nodes converge by
title — one song, one dot, however many identifiers it has.

**It's printed, not rendered.** Warm paper, an old-style serif, terracotta for
emphasis, hairline rules. The graph uses the same ground and a muted
naturalist palette so the web and the page read as one object rather than a
diagram pasted onto a UI. The whole palette lives in one place — `THEME` and
`KIND` in `js/model.js` — and the canvas and the stylesheet both draw from it.

**Captions are collision-culled in screen space.** Text has to stay readable at
every zoom, which means it doesn't shrink as you zoom out — so labels collide
long before the circles do. They're placed most-important-first, and any that
would overlap something already placed is dropped.

---

## Development

```sh
node tools/smoke-test.mjs     # end-to-end run in headless Chromium
node tools/make-icons.mjs     # regenerate icons/ from tools/ship.mjs
```

The icon is a Homeric galley — crescent hull, bronze ram, banked oars, one
square sail, and the curled aphlaston stern. It lives in `tools/ship.mjs`
as plain coordinates, and both the PNGs and `icon.svg` are drawn from that
one description, so the home-screen icon and the favicon can't drift apart.
Edit the ship by moving a number and re-running the command. The 40px mark
on the launch screen is a separate, simplified drawing inlined in
`index.html`: at that size the eye and the rigging close up, so it keeps
only the silhouette.

The smoke test serves the app, stubs every outbound API with fixtures, and
drives a full session — search, seed, expand an album, open the sheet —
asserting on the real module state and failing on any console error. It needs
Playwright available (globally is fine); the app itself has no dependencies.

---

## Known limits

- **Discogs may refuse browser requests.** Its API asks callers to identify
  themselves with a custom `User-Agent`, and browsers forbid any page from
  setting that header. If Discogs credits never appear, run Diagnostics — it
  will say so explicitly. Everything else works regardless.
- **Node budget.** A graph stops at 220 nodes and each expansion adds at most
  26, of which at most 10 are people — otherwise a large lineup would use up
  the whole expansion before any records or songs appeared. Past that it
  stops being a picture and starts being a hairball.
- **An artist expansion makes three sequential MusicBrainz calls** (the
  lookup, then one each for kindred artists and kindred songs), and the rate
  limit means roughly a second between them. Nodes are drawn as each lands
  rather than all at the end.
- **Stylistic kinship needs a specific tag.** An artist tagged only "rock", or
  not tagged at all, gets no style edges — a tie that broad says nothing about
  the music. A Last.fm key helps here, since its tags cover more artists.
- **Songs need either a Last.fm key or a discography with singles in it.**
  Artists whose catalogue MusicBrainz only lists as albums will show songs
  once you open one of those albums, rather than straight off the artist.
- **Search takes a couple of seconds.** It's three MusicBrainz queries — one
  each for artists, albums and songs — and the rate limit means they run in
  sequence. Results fill in as each one lands.
