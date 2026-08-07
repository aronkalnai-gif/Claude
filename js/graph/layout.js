/* A small force-directed layout, written by hand.

   At the scale this app works in — a couple of hundred nodes at most — the
   naive O(n²) repulsion is comfortably fast on an iPad, and skipping a
   layout library keeps the whole thing dependency-free and offline-capable.

   The one idea worth knowing: spring rest length is derived from edge
   weight, so a band member sits tight against their band while a
   "sounds a bit like" tie floats out at the edge. The strength of a
   relationship becomes a distance you can read at a glance. */

import { edgeStyle } from '../model.js';

const REPULSION      = 7600;
const REPULSION_MAX  = 560;    // beyond this, nodes stop pushing each other
const SPRING_BASE    = 0.019;
const CENTER_PULL    = 0.0013;
const DAMPING        = 0.86;
const MAX_SPEED      = 22;

/* Nodes carry a caption underneath, so they need more elbow room than
   their circles suggest. Collision treats each one as a box roughly the
   width of its label — without this, the circles sit politely apart while
   the text underneath turns into a pile. */
const LABEL_CHAR_W   = 6.6;
const LABEL_MAX_W    = 150;
const LABEL_BAND_H   = 26;

export function createLayout() {
  let alpha = 1;

  return {
    get alpha() { return alpha; },

    /** Wake the simulation up — called whenever the graph gains nodes. */
    reheat(to = 0.9) { alpha = Math.max(alpha, to); },

    settle() { alpha = 0; },

    /**
     * Advance one frame.
     * @returns {boolean} whether anything is still moving
     */
    step(nodes, edges, pinnedId) {
      if (alpha < 0.005) return false;
      alpha *= 0.988;

      const n = nodes.length;
      if (!n) return false;

      // Repulsion — every node pushes every other apart.
      for (let i = 0; i < n; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < n; j++) {
          const b = nodes[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 > REPULSION_MAX * REPULSION_MAX) continue;
          if (d2 < 1) { // exactly coincident: nudge apart deterministically
            dx = (i - j) * 0.5 + 0.1; dy = 0.3; d2 = dx * dx + dy * dy;
          }
          const d = Math.sqrt(d2);
          const force = REPULSION / d2;
          const fx = (dx / d) * force, fy = (dy / d) * force;
          a.vx -= fx; a.vy -= fy;
          b.vx += fx; b.vy += fy;
        }
      }

      // Springs — pull connected nodes to a rest distance set by how strong
      // the relationship is.
      const byId = new Map(nodes.map(node => [node.id, node]));
      for (const e of edges) {
        const a = byId.get(e.a), b = byId.get(e.b);
        if (!a || !b) continue;
        const style = edgeStyle(e.kind);
        const w = e.weight ?? style.weight;
        const rest = 96 + (1 - w) * 150 + a.r + b.r;
        const k = SPRING_BASE * (0.35 + w);

        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const pull = (d - rest) * k;
        const fx = (dx / d) * pull, fy = (dy / d) * pull;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }

      // Collision, as boxes rather than circles: node plus the caption
      // slung underneath it. Resolve along whichever axis is overlapping
      // least, which nudges things apart without flinging them.
      for (const node of nodes) {
        if (node.hw === undefined || node.hwFor !== node.label) {
          node.hw = Math.max(node.r, Math.min(String(node.label || '').length * LABEL_CHAR_W, LABEL_MAX_W) / 2);
          node.hwFor = node.label;
        }
      }
      /* Two separate constraints, because they fail differently.

         The box keeps captions from stacking, but a box constraint can be
         perfectly satisfied while the circles still intersect — offset the
         pair diagonally and neither axis overlaps even though the discs do.
         So circles get their own hard radial rule, applied first. Three
         sweeps, because pulling one pair apart routinely pushes it into a
         third, and a pile of three is exactly what goes wrong. */
      let collided = false;
      for (let pass = 0; pass < 3; pass++) {
        let touched = false;
        for (let i = 0; i < n; i++) {
          const a = nodes[i];
          for (let j = i + 1; j < n; j++) {
            const b = nodes[j];
            let dx = b.x - a.x, dy = b.y - a.y;

            // 1. Discs may never intersect, at any angle.
            const minD = a.r + b.r + 8;
            const d = Math.hypot(dx, dy);
            if (d < minD) {
              touched = true;
              const ux = d > 0.01 ? dx / d : 1, uy = d > 0.01 ? dy / d : 0;
              const push = (minD - d) / 2;
              a.x -= ux * push; a.y -= uy * push;
              b.x += ux * push; b.y += uy * push;
              dx = b.x - a.x; dy = b.y - a.y;
            }

            // 2. Captions want a box's worth of room around each node.
            const overlapX = (a.hw + b.hw + 10) - Math.abs(dx);
            const overlapY = (a.r + b.r + LABEL_BAND_H) - Math.abs(dy);
            if (overlapX <= 0 || overlapY <= 0) continue;

            touched = true;
            if (overlapX < overlapY) {
              const push = (overlapX / 2) * Math.sign(dx || 1);
              a.x -= push; b.x += push;
            } else {
              const push = (overlapY / 2) * Math.sign(dy || 1);
              a.y -= push; b.y += push;
            }
          }
        }
        if (touched) collided = true;
        else break;
      }

      // Gravity, integration, and the pins.
      let moving = false;
      for (const node of nodes) {
        if (node.id === pinnedId || node.dragging) {
          node.vx = 0; node.vy = 0;
          continue;
        }
        node.vx -= node.x * CENTER_PULL * (1 + node.depth * 0.4);
        node.vy -= node.y * CENTER_PULL * (1 + node.depth * 0.4);

        node.vx *= DAMPING;
        node.vy *= DAMPING;

        const speed = Math.hypot(node.vx, node.vy);
        if (speed > MAX_SPEED) {
          node.vx = (node.vx / speed) * MAX_SPEED;
          node.vy = (node.vy / speed) * MAX_SPEED;
        }

        node.x += node.vx * alpha;
        node.y += node.vy * alpha;
        if (speed > 0.35) moving = true;
      }

      // Collision moves nodes without giving them velocity, so a graph that
      // still has overlaps can look "settled" to the speed check and freeze
      // mid-pile. Keep the simulation awake while anything is still touching.
      if (collided) moving = true;

      if (!moving && alpha < 0.25) alpha = 0;
      return alpha > 0.005;
    },
  };
}
