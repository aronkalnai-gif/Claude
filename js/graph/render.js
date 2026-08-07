/* Canvas renderer and touch handling.

   Canvas rather than SVG because a few hundred nodes with cover art and
   per-frame physics is exactly the case where the DOM starts to hurt on a
   tablet. Everything here is hand-rolled so pinch, pan, tap and node-drag
   can share one pointer pipeline without fighting each other. */

import { graph, nodeList, edgeList, neighbours, emit } from '../state.js';
import { kindColor, edgeStyle } from '../model.js';
import { createLayout } from './layout.js';
import { peekImage, loadImage } from '../sources/coverart.js';

const TAP_SLOP = 12;      // px of movement still counted as a tap
const TAP_TIME = 450;     // ms

export function createRenderer(canvas, { onTapNode, onTapBackground, onDoubleTapNode }) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const layout = createLayout();

  const view = { scale: 1, tx: 0, ty: 0 };
  let width = 0, height = 0, dpr = 1;
  let running = false;
  let lastTap = { t: 0, id: null };

  /* ── Sizing ───────────────────────────────────────────────────────── */

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    kick();
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 260));

  /* ── Coordinate helpers ───────────────────────────────────────────── */

  const toWorld = (sx, sy) => ({
    x: (sx - width / 2 - view.tx) / view.scale,
    y: (sy - height / 2 - view.ty) / view.scale,
  });
  const toScreen = (wx, wy) => ({
    x: wx * view.scale + width / 2 + view.tx,
    y: wy * view.scale + height / 2 + view.ty,
  });

  function nodeAt(sx, sy) {
    const w = toWorld(sx, sy);
    let best = null, bestD = Infinity;
    for (const n of nodeList()) {
      const d = Math.hypot(n.x - w.x, n.y - w.y);
      // Generous hit radius: fingers aren't precise, small nodes are small.
      const hit = Math.max(n.r + 8, 22 / view.scale);
      if (d < hit && d < bestD) { best = n; bestD = d; }
    }
    return best;
  }

  /* ── Pointer handling ─────────────────────────────────────────────── */

  const pointers = new Map();
  let gesture = null;   // 'pan' | 'node' | 'pinch'
  let dragNode = null;
  let start = null;
  let pinchStart = null;

  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2) {
      const [p1, p2] = [...pointers.values()];
      pinchStart = {
        dist: Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1,
        mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
        scale: view.scale, tx: view.tx, ty: view.ty,
      };
      gesture = 'pinch';
      if (dragNode) { dragNode.dragging = false; dragNode = null; }
      return;
    }

    const hit = nodeAt(e.clientX, e.clientY);
    start = { x: e.clientX, y: e.clientY, t: performance.now(), tx: view.tx, ty: view.ty, id: hit?.id || null };
    if (hit) {
      gesture = 'node';
      dragNode = hit;
      hit.dragging = true;
    } else {
      gesture = 'pan';
    }
  });

  canvas.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (gesture === 'pinch' && pointers.size >= 2 && pinchStart) {
      const [p1, p2] = [...pointers.values()];
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      const ratio = dist / pinchStart.dist;
      const next = clamp(pinchStart.scale * ratio, 0.18, 4);
      const actual = next / pinchStart.scale;
      // Keep whatever was between the fingers pinned under them: solve the
      // screen↔world transform for the translation that holds it in place.
      view.scale = next;
      view.tx = mid.x - width / 2 - (pinchStart.mid.x - width / 2 - pinchStart.tx) * actual;
      view.ty = mid.y - height / 2 - (pinchStart.mid.y - height / 2 - pinchStart.ty) * actual;
      kick();
      return;
    }

    if (gesture === 'node' && dragNode) {
      const w = toWorld(e.clientX, e.clientY);
      dragNode.x = w.x; dragNode.y = w.y;
      dragNode.vx = 0; dragNode.vy = 0;
      layout.reheat(0.35);
      kick();
      return;
    }

    if (gesture === 'pan' && start) {
      view.tx = start.tx + (e.clientX - start.x);
      view.ty = start.ty + (e.clientY - start.y);
      kick();
    }
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);

    if (gesture === 'node' && dragNode && start) {
      const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
      const elapsed = performance.now() - start.t;
      dragNode.dragging = false;
      if (moved < TAP_SLOP && elapsed < TAP_TIME) {
        const now = performance.now();
        if (lastTap.id === dragNode.id && now - lastTap.t < 320) {
          onDoubleTapNode?.(dragNode);
          lastTap = { t: 0, id: null };
        } else {
          lastTap = { t: now, id: dragNode.id };
          onTapNode?.(dragNode);
        }
      }
      dragNode = null;
    } else if (gesture === 'pan' && start) {
      const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
      if (moved < TAP_SLOP && performance.now() - start.t < TAP_TIME) onTapBackground?.();
    }

    if (pointers.size === 0) { gesture = null; start = null; pinchStart = null; }
    else if (pointers.size === 1) { gesture = 'pan';
      const [only] = [...pointers.values()];
      start = { x: only.x, y: only.y, t: performance.now(), tx: view.tx, ty: view.ty, id: null };
    }
    kick();
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  // Trackpad / mouse wheel, for when this is open on a desktop.
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0016);
    const next = clamp(view.scale * factor, 0.18, 4);
    const actual = next / view.scale;
    view.tx = e.clientX - width / 2 - (e.clientX - width / 2 - view.tx) * actual;
    view.ty = e.clientY - height / 2 - (e.clientY - height / 2 - view.ty) * actual;
    view.scale = next;
    kick();
  }, { passive: false });

  /* ── Camera ───────────────────────────────────────────────────────── */

  /* The detail panel covers part of the canvas, so "fit" has to mean "fit
     in the part you can actually see" — otherwise half the graph you just
     built lands underneath the sheet. */
  let insets = { top: 0, right: 0, bottom: 0, left: 0 };
  const setInsets = next => { insets = { top: 0, right: 0, bottom: 0, left: 0, ...next }; };

  const viewport = () => ({
    x: insets.left,
    y: insets.top,
    w: Math.max(160, width - insets.left - insets.right),
    h: Math.max(160, height - insets.top - insets.bottom),
  });

  function fitToGraph({ animate = true, padding = 58 } = {}) {
    const nodes = nodeList();
    if (!nodes.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      // Allow for the caption slung under each node.
      minX = Math.min(minX, n.x - (n.hw ?? n.r)); maxX = Math.max(maxX, n.x + (n.hw ?? n.r));
      minY = Math.min(minY, n.y - n.r);           maxY = Math.max(maxY, n.y + n.r + 22);
    }
    const vp = viewport();
    const w = Math.max(maxX - minX, 1), h = Math.max(maxY - minY, 1);
    const scale = clamp(Math.min((vp.w - padding * 2) / w, (vp.h - padding * 2) / h), 0.3, 1.4);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const dest = {
      scale,
      tx: vp.x + vp.w / 2 - width / 2 - cx * scale,
      ty: vp.y + vp.h / 2 - height / 2 - cy * scale,
    };
    animate ? glideTo(dest) : Object.assign(view, dest);
    kick();
  }

  function centerOn(node, { zoom = null } = {}) {
    if (!node) return;
    const scale = zoom ?? clamp(view.scale, 0.55, 1.1);
    const vp = viewport();
    glideTo({
      scale,
      tx: vp.x + vp.w / 2 - width / 2 - node.x * scale,
      ty: vp.y + vp.h / 2 - height / 2 - node.y * scale,
    });
  }

  let glide = null;
  function glideTo(dest) {
    glide = { from: { ...view }, to: dest, t0: performance.now(), dur: 520 };
    kick();
  }

  function stepGlide(now) {
    if (!glide) return false;
    const p = Math.min(1, (now - glide.t0) / glide.dur);
    const e = 1 - Math.pow(1 - p, 3);
    view.scale = glide.from.scale + (glide.to.scale - glide.from.scale) * e;
    view.tx = glide.from.tx + (glide.to.tx - glide.from.tx) * e;
    view.ty = glide.from.ty + (glide.to.ty - glide.from.ty) * e;
    if (p >= 1) glide = null;
    return true;
  }

  /* ── Draw ─────────────────────────────────────────────────────────── */

  function draw(now) {
    ctx.save();
    ctx.fillStyle = '#0B0D12';
    ctx.fillRect(0, 0, width, height);

    // A soft pool of light behind the graph so nodes read as lit objects
    // rather than stickers on a flat field.
    const g = ctx.createRadialGradient(width / 2, height * 0.42, 0, width / 2, height * 0.42, Math.max(width, height) * 0.75);
    g.addColorStop(0, '#141A27');
    g.addColorStop(1, '#0B0D12');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);

    ctx.translate(width / 2 + view.tx, height / 2 + view.ty);
    ctx.scale(view.scale, view.scale);

    const nodes = nodeList();
    const edges = edgeList();
    const sel = graph.selectedId;
    const near = new Set();
    if (sel) { near.add(sel); for (const n of neighbours(sel)) near.add(n.node.id); }

    const byId = new Map(nodes.map(n => [n.id, n]));

    /* Edges */
    ctx.lineCap = 'round';
    for (const e of edges) {
      const a = byId.get(e.a), b = byId.get(e.b);
      if (!a || !b) continue;
      const style = edgeStyle(e.kind);
      const highlighted = sel && (e.a === sel || e.b === sel);
      const dimmed = sel && !highlighted;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = style.color;
      ctx.globalAlpha = dimmed ? 0.09 : (highlighted ? 0.85 : 0.28 + (style.weight * 0.22));
      ctx.lineWidth = (highlighted ? 2.4 : 1.2 + style.weight * 0.9) / Math.max(view.scale, 0.6);
      if (style.dash) ctx.setLineDash(style.dash.map(v => v / Math.max(view.scale, 0.6)));
      ctx.stroke();
      ctx.restore();

    }

    /* Nodes */
    for (const n of nodes) {
      const dimmed = sel && !near.has(n.id);
      const grow = Math.min(1, (now - n.born) / 380);
      const ease = 1 - Math.pow(1 - grow, 3);
      const r = n.r * (0.35 + 0.65 * ease);
      drawNode(ctx, n, r, {
        selected: n.id === sel,
        seed: n.id === graph.seedId,
        alpha: dimmed ? 0.28 : 1,
        scale: view.scale,
      });
    }

    ctx.restore();

    /* Captions are drawn last, in screen space rather than world space.
       Text has to stay a readable size at every zoom level, which means it
       does *not* shrink as you zoom out — so at low zoom the labels collide
       long before the circles do. Placing them here, cheapest-first, and
       dropping any that would overlap something already placed, is what
       keeps a hundred-node web legible instead of a smear of names. */
    // Seed the occupied list with the node circles themselves, so a caption
    // can never end up sitting across someone else's face.
    const placed = nodes.map(n => {
      const p = toScreen(n.x, n.y);
      const r = n.r * view.scale;
      return { x: p.x - r, y: p.y - r, w: r * 2, h: r * 2 };
    });
    const fits = box => {
      for (const p of placed) {
        if (box.x < p.x + p.w && box.x + box.w > p.x && box.y < p.y + p.h && box.y + box.h > p.y) return false;
      }
      placed.push(box);
      return true;
    };

    if (sel) {
      for (const e of edges) {
        if (e.a !== sel && e.b !== sel) continue;
        if (!e.label || view.scale < 0.45) continue;
        const a = byId.get(e.a), b = byId.get(e.b);
        if (!a || !b) continue;
        drawEdgeLabel(a, b, e.label, fits);
      }
    }

    const priority = nodes.slice().sort((x, y) =>
      score(y, sel, near) - score(x, sel, near));
    for (const n of priority) {
      const dimmed = sel && !near.has(n.id);
      const important = n.id === sel || n.id === graph.seedId || near.has(n.id);
      if (!important && view.scale < 0.34) continue;
      if (dimmed && view.scale < 0.55) continue;
      drawLabel(ctx, n, dimmed ? 0.4 : 1, fits);
    }
  }

  /* Which captions get to survive a collision. */
  function score(n, sel, near) {
    if (n.id === sel) return 100;
    if (n.id === graph.seedId) return 90;
    if (near.has(n.id)) return 60 - n.depth;
    return 30 - n.depth * 2 + n.r * 0.1;
  }

  function drawEdgeLabel(a, b, text, fits) {
    const p = toScreen((a.x + b.x) / 2, (a.y + b.y) / 2);
    const label = text.length > 44 ? text.slice(0, 42) + '…' : text;

    ctx.save();
    ctx.font = '500 11px ui-rounded, -apple-system, system-ui, sans-serif';
    const w = ctx.measureText(label).width + 12;
    // Horizontal, never rotated: text angled along a line is charming on a
    // diagram and unreadable on a moving graph.
    if (!fits({ x: p.x - w / 2, y: p.y - 9, w, h: 18 })) { ctx.restore(); return; }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(11,13,18,.9)';
    roundRect(ctx, p.x - w / 2, p.y - 9, w, 18, 5);
    ctx.fill();
    ctx.fillStyle = '#B9C3D2';
    ctx.fillText(label, p.x, p.y + 0.5);
    ctx.restore();
  }

  function drawNode(ctx, n, r, { selected, seed, alpha, scale }) {
    const color = kindColor(n.kind);
    ctx.save();
    ctx.globalAlpha = alpha;

    if (selected || seed) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + (selected ? 9 : 6), 0, Math.PI * 2);
      ctx.fillStyle = hexA(color, selected ? 0.2 : 0.11);
      ctx.fill();
    }

    // Art, if we have it, clipped into the node.
    const img = n.art ? peekImage(n.art) : null;
    // `undefined` means not-yet-decoded. Request it once and remember that
    // we did — this runs every frame, and re-attaching a `.then` each time
    // would fire a hundred redraws the moment the image lands.
    if (img === undefined && n.art && !n.artPending) {
      n.artPending = true;
      loadImage(n.art).then(() => { n.artPending = false; emit(); });
    }

    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);

    if (img) {
      ctx.save();
      ctx.clip();
      const side = r * 2;
      ctx.drawImage(img, n.x - r, n.y - r, side, side);
      ctx.restore();
      ctx.globalAlpha = alpha * 0.35;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = alpha;
    } else {
      const grad = ctx.createLinearGradient(n.x, n.y - r, n.x, n.y + r);
      grad.addColorStop(0, hexA(color, 0.34));
      grad.addColorStop(1, hexA(color, 0.14));
      ctx.fillStyle = grad;
      ctx.fill();
    }

    ctx.lineWidth = (selected ? 2.6 : seed ? 2.2 : 1.5) / Math.max(scale, 0.7);
    ctx.strokeStyle = selected ? '#FFFFFF' : hexA(color, seed ? 0.95 : 0.7);
    ctx.stroke();

    // A quiet initial when there's no art to show.
    if (!img && r > 13) {
      ctx.fillStyle = hexA(color, 0.85);
      ctx.font = `600 ${Math.round(r * 0.9)}px ui-rounded, -apple-system, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((n.label || '?').trim()[0].toUpperCase(), n.x, n.y + r * 0.04);
    }

    if (n.expanding) {
      const t = performance.now() / 380;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 7, t, t + Math.PI * 1.15);
      ctx.strokeStyle = '#FFFFFF';
      ctx.globalAlpha = alpha * 0.8;
      ctx.lineWidth = 2 / Math.max(scale, 0.7);
      ctx.stroke();
    } else if (!n.expanded && !n.unlinked) {
      // A small mark that says "there's more behind this one".
      ctx.beginPath();
      ctx.arc(n.x + r * 0.72, n.y - r * 0.72, 3.6 / Math.max(scale, 0.8), 0, Math.PI * 2);
      ctx.fillStyle = hexA(color, 0.9);
      ctx.fill();
    }

    ctx.restore();
  }

  function drawLabel(ctx, n, alpha, fits) {
    const anchor = toScreen(n.x, n.y);
    const top = anchor.y + n.r * view.scale + 6;
    const withSub = n.sublabel && (n.id === graph.selectedId || n.id === graph.seedId);

    const text = n.label.length > 26 ? n.label.slice(0, 24) + '…' : n.label;
    ctx.save();
    ctx.font = '600 12.5px ui-rounded, -apple-system, system-ui, sans-serif';
    const w = Math.max(ctx.measureText(text).width, 20) + 8;
    const h = withSub ? 32 : 17;
    if (!fits({ x: anchor.x - w / 2, y: top - 2, w, h })) { ctx.restore(); return; }

    // Off-screen captions cost nothing to skip and can't be read anyway.
    if (top > height + 20 || top < -40 || anchor.x < -w || anchor.x > width + w) { ctx.restore(); return; }

    ctx.globalAlpha = alpha;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(11,13,18,.94)';
    ctx.lineJoin = 'round';
    ctx.strokeText(text, anchor.x, top);
    ctx.fillStyle = '#E9EDF4';
    ctx.fillText(text, anchor.x, top);

    if (withSub) {
      const sub = n.sublabel.length > 32 ? n.sublabel.slice(0, 30) + '…' : n.sublabel;
      ctx.font = '400 11px ui-rounded, -apple-system, system-ui, sans-serif';
      ctx.strokeText(sub, anchor.x, top + 15);
      ctx.fillStyle = '#93A0B2';
      ctx.fillText(sub, anchor.x, top + 15);
    }
    ctx.restore();
  }

  /* ── Loop ─────────────────────────────────────────────────────────── */

  function frame(now) {
    const gliding = stepGlide(now);
    const settling = layout.step(nodeList(), edgeList(), graph.seedId);
    draw(now);
    if (gliding || settling) requestAnimationFrame(frame);
    else running = false;
  }

  function kick() {
    if (running) return;
    running = true;
    requestAnimationFrame(frame);
  }

  resize();

  return {
    kick,
    resize,
    fitToGraph,
    centerOn,
    setInsets,
    reheat: (a) => { layout.reheat(a); kick(); },
    get view() { return view; },
  };
}

/* ── Tiny helpers ───────────────────────────────────────────────────── */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
