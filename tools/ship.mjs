/* The ship of Odysseus, described once.

   Both the SVG and the PNGs are drawn from this file, so the home-screen
   icon and the favicon can't drift apart. Everything lives in a 512-unit
   square with y pointing down.

   It's a Homeric galley as the black-figure painters drew it: a crescent
   hull with a bronze ram at the waterline, an eye on the bow to see the
   way, banked oars, a single square sail on one yard, and the aphlaston —
   the curled goose-neck stern that is the one detail which makes a Greek
   ship unmistakably Greek. */

export const PALETTE = {
  paperTop: '#FBF7EC',   // centre of the ground
  paperEdge: '#EEE4CF',  // and its edge, so the tile isn't flat
  hull: '#3B4A3D',       // --ink-soft: timber
  sail: '#C4603F',       // --rust: the one warm note, so the sail is the subject
  brail: '#F3EAD6',      // seams, in the paper's own colour
  wave: '#C0B092',       // --rule: the sea, as a hairline
  pupil: '#1F1D18',      // --ink
  eye: '#FBF7EC',
};

/* ── Curves ─────────────────────────────────────────────────────────── */

/* Quadratic bezier, flattened. Both renderers want plain point lists —
   the raster one because it measures distances, the SVG one so that what
   it writes is provably the same outline the PNGs were drawn from. */
function quad([x0, y0], [cx, cy], [x1, y1], steps = 22) {
  const out = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    out.push([
      u * u * x0 + 2 * u * t * cx + t * t * x1,
      u * u * y0 + 2 * u * t * cy + t * t * y1,
    ]);
  }
  return out;
}

/* Chain of quads sharing endpoints, starting from `first`. */
function path(first, ...legs) {
  const pts = [first];
  let from = first;
  for (const [c, to, steps] of legs) {
    pts.push(...quad(from, c, to, steps));
    from = to;
  }
  return pts;
}

/* ── The parts ──────────────────────────────────────────────────────── */

/* Sheer line dips amidships and lifts at both ends; the keel bows the
   other way. The two together give the crescent every ancient hull has.
   Kept shallow — a deep hull reads as a slug at 40px. */
const HULL = path(
  [404, 296],
  [[256, 340], [120, 302]],   // deck, stern to bow
  [[106, 326], [102, 340]],   // stem
  [[92, 342], [84, 346], 6],  // the ram, riding at the waterline
  [[94, 352], [110, 356], 6],
  [[256, 378], [390, 350]],   // keel, bow to stern
  [[406, 330], [404, 296], 8],
);

/* A wale: the strake running the length of the hull. One hairline is
   enough to stop the timber reading as a silhouette. */
const WALE = path([392, 312], [[256, 352], [128, 316]]);

/* Square sail, bellied by a following wind. The swell is slight on
   purpose — push it any further and the sail stops being square. */
const SAIL = path(
  [150, 158],
  [[254, 154], [358, 150], 4],  // head, laced to the yard
  [[366, 216], [352, 282]],     // leech
  [[252, 296], [156, 286]],     // foot
  [[146, 218], [150, 158]],     // luff
);

/* Brailing lines: Greek sails were shortened by gathering them upward on
   vertical ropes, so the seams run up and down, not across. Clipped to
   the sail, which is why they can overshoot it at both ends. */
const BRAILS = [198, 254, 310].map(x =>
  path([x, 146], [[x - 6, 222], [x, 302]]));

const OARS = [
  [[150, 348], [106, 398]],
  [[188, 356], [144, 406]],
  [[226, 362], [182, 412]],
  [[264, 364], [220, 414]],
  [[302, 362], [258, 412]],
  [[340, 354], [296, 404]],
];

const WAVES = [
  path([78, 400], [[172, 391], [262, 399]], [[352, 407], [438, 396]]),
  path([128, 428], [[258, 438], [388, 426]]),
];

/* The stern post, curling up and back over the helmsman. */
const APHLASTON = path(
  [402, 292],
  [[438, 252], [424, 212]],
  [[414, 190], [390, 199]],
);

/* ── The scene, back to front ───────────────────────────────────────── */

export function shapes() {
  return [
    ...WAVES.map(pts => ({ kind: 'stroke', pts, width: 9, color: PALETTE.wave })),

    // Drawn before the hull, so each oar emerges from behind the timber
    // instead of being pasted on top of it.
    ...OARS.map(([a, b]) => ({ kind: 'stroke', pts: [a, b], width: 8, color: PALETTE.hull })),

    { kind: 'poly', pts: HULL, fill: PALETTE.hull },
    { kind: 'stroke', pts: APHLASTON, width: 12, color: PALETTE.hull },
    { kind: 'stroke', pts: WALE, width: 4, color: PALETTE.brail, clip: 'hull' },

    { kind: 'circle', c: [152, 334], r: 12, fill: PALETTE.eye },
    { kind: 'circle', c: [152, 334], r: 5.5, fill: PALETTE.pupil },

    { kind: 'stroke', pts: [[246, 110], [246, 318]], width: 9, color: PALETTE.hull },

    { kind: 'poly', pts: SAIL, fill: PALETTE.sail },
    ...BRAILS.map(pts => ({ kind: 'stroke', pts, width: 4, color: PALETTE.brail, clip: 'sail' })),

    // After the sail: the yard crosses in front of the cloth it carries.
    { kind: 'stroke', pts: [[142, 160], [366, 149]], width: 8, color: PALETTE.hull },
    { kind: 'poly', pts: [[250, 114], [302, 125], [250, 135]], fill: PALETTE.sail },
  ];
}

export const CLIPS = { sail: SAIL, hull: HULL };
