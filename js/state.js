/* The graph itself: nodes, edges, and who's listening for changes.

   Deliberately dumb — it stores and dedupes, it doesn't decide. All the
   judgement about what deserves to be on screen lives in expand.js. */

import { kindRadius } from './model.js';

const listeners = new Set();

export const graph = {
  nodes: new Map(),   // id -> node
  edges: new Map(),   // key -> edge
  seedId: null,
  selectedId: null,
};

export const MAX_NODES = 220;

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit() { for (const fn of listeners) fn(); }

export const nodeList = () => [...graph.nodes.values()];
export const edgeList = () => [...graph.edges.values()];

export function reset() {
  graph.nodes.clear();
  graph.edges.clear();
  graph.seedId = null;
  graph.selectedId = null;
  emit();
}

export const nodeId = (kind, mbid) => `${kind}:${mbid}`;

/**
 * Add a node, or return the existing one. Nodes are never duplicated: a
 * musician who turns up as a band member, a producer and a similar artist
 * is one node with three edges, which is exactly the point of the app.
 */
export function addNode(spec, { near = null } = {}) {
  const existing = graph.nodes.get(spec.id);
  if (existing) {
    // Later sightings often carry better information than the first.
    if (spec.art && !existing.art) existing.art = spec.art;
    if (spec.sublabel && !existing.sublabel) existing.sublabel = spec.sublabel;
    if (spec.kind && existing.provisional && !spec.provisional) {
      existing.kind = spec.kind;
      existing.provisional = false;
      existing.r = kindRadius(spec.kind);
    }
    if (typeof spec.depth === 'number') existing.depth = Math.min(existing.depth, spec.depth);
    return existing;
  }

  if (graph.nodes.size >= MAX_NODES) return null;

  // Seed new nodes in a ring around whatever pulled them in, so the force
  // simulation starts from something sane rather than a single hot point.
  const angle = Math.random() * Math.PI * 2;
  const dist = 90 + Math.random() * 70;
  const node = {
    sublabel: '',
    searchTerm: spec.label,
    depth: 0,
    expanded: false,
    expanding: false,
    art: null,
    bio: null,
    tags: [],
    provisional: false,
    data: null,
    ...spec,
    r: kindRadius(spec.kind),
    x: (near ? near.x : 0) + Math.cos(angle) * dist,
    y: (near ? near.y : 0) + Math.sin(angle) * dist,
    vx: 0, vy: 0,
    born: performance.now(),
  };
  graph.nodes.set(node.id, node);
  return node;
}

const edgeKey = (a, b, kind) => (a < b ? `${a}|${b}|${kind}` : `${b}|${a}|${kind}`);

export function addEdge(aId, bId, kind, label, { lore = null, weight = null } = {}) {
  if (!aId || !bId || aId === bId) return null;
  if (!graph.nodes.has(aId) || !graph.nodes.has(bId)) return null;

  const key = edgeKey(aId, bId, kind);
  const existing = graph.edges.get(key);
  if (existing) {
    if (label && label.length > (existing.label || '').length) existing.label = label;
    if (lore && !existing.lore) existing.lore = lore;
    return existing;
  }

  const edge = { id: key, a: aId, b: bId, kind, label: label || '', lore, weight, born: performance.now() };
  graph.edges.set(key, edge);
  return edge;
}

/**
 * Find an existing node of a kind by its title.
 *
 * The same song legitimately exists in MusicBrainz under several ids — the
 * single that carried it and the recording on the album are different
 * entities with different MBIDs. To a listener they are one song, and
 * seeing the title twice on the web is just confusing, so callers use this
 * to attach to whichever node got there first.
 */
export function findByLabel(kind, label) {
  const want = String(label || '').trim().toLowerCase();
  if (!want) return null;
  for (const n of graph.nodes.values()) {
    if (n.kind === kind && n.label.trim().toLowerCase() === want) return n;
  }
  return null;
}

/** Every edge touching a node, with the node on the other end resolved. */
export function neighbours(id) {
  const out = [];
  for (const e of graph.edges.values()) {
    if (e.a === id) out.push({ edge: e, node: graph.nodes.get(e.b), outgoing: true });
    else if (e.b === id) out.push({ edge: e, node: graph.nodes.get(e.a), outgoing: false });
  }
  return out.filter(n => n.node);
}

export const degree = id => neighbours(id).length;
