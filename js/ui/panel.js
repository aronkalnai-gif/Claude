/* The detail sheet.

   The graph shows you *that* things connect; this is where you find out
   why. The "How it connects" list is the point of the whole app, so it
   sits above the biography, not below it. */

import { graph, neighbours } from '../state.js';
import { kindColor, kindLabel, listenLinks } from '../model.js';

export function createPanel(el, body, { onExpand, onSelect, onClose }) {
  let current = null;

  body.addEventListener('click', e => {
    const jump = e.target.closest('button.jump');
    if (jump) { onSelect?.(jump.dataset.id); return; }

    const expand = e.target.closest('[data-act="expand"]');
    if (expand && current) { onExpand?.(current); return; }

    const close = e.target.closest('[data-act="close"]');
    if (close) { onClose?.(); }
  });

  /* Drag-to-dismiss on the phone-sized bottom sheet. */
  const grab = document.getElementById('sheet-grab');
  if (grab) {
    let startY = 0, dy = 0;
    grab.addEventListener('pointerdown', e => {
      grab.setPointerCapture(e.pointerId);
      startY = e.clientY; dy = 0;
      el.style.transition = 'none';
    });
    grab.addEventListener('pointermove', e => {
      if (!grab.hasPointerCapture(e.pointerId)) return;
      dy = Math.max(0, e.clientY - startY);
      el.style.transform = `translateY(${dy}px)`;
    });
    const release = () => {
      el.style.transition = '';
      el.style.transform = '';
      if (dy > 90) onClose?.();
      dy = 0;
    };
    grab.addEventListener('pointerup', release);
    grab.addEventListener('pointercancel', release);
  }

  function hide() { current = null; el.hidden = true; }

  function show(node) {
    if (!node) return hide();
    current = node;
    el.hidden = false;
    render();
  }

  function render() {
    if (!current) return;
    const n = current;
    const color = kindColor(n.kind);
    const links = neighbours(n.id);

    const art = n.art
      ? `<img class="sheet-art" src="${esc(n.art)}" alt="" onerror="this.remove()">`
      : '';

    const bio = n.bio?.extract
      ? `<section>
           <h4>About</h4>
           <p class="bio">${esc(trim(n.bio.extract, 420))}</p>
           ${n.bio.url ? `<div class="listen" style="margin-top:10px"><a href="${esc(n.bio.url)}" target="_blank" rel="noopener">Wikipedia ↗</a></div>` : ''}
         </section>`
      : '';

    const facts = links.length
      ? `<section>
           <h4>How it connects</h4>
           ${links
             .sort((a, b) => rank(a.edge.kind) - rank(b.edge.kind))
             .map(({ edge, node: other, outgoing }) => factRow(n, edge, other, outgoing))
             .join('')}
         </section>`
      : '';

    const tags = n.tags?.length
      ? `<section><h4>Tagged</h4><p class="bio">${n.tags.map(esc).join(' · ')}</p></section>`
      : '';

    const sessionNotes = n.discogs?.notes
      ? `<section><h4>Sleeve notes</h4><p class="bio">${esc(trim(n.discogs.notes, 320))}</p></section>`
      : '';

    const expandLabel = n.expanding ? 'Opening…'
      : n.unlinked ? 'Nothing more to open'
      : n.expanded ? 'Expand again'
      : 'Expand this';

    body.innerHTML = `
      ${art}
      <span class="sheet-kind" style="color:${color}">${esc(kindLabel(n.kind))}</span>
      <h3>${esc(n.label)}</h3>
      ${n.sublabel ? `<p class="sub">${esc(n.sublabel)}</p>` : ''}

      <div class="btn-row">
        <button class="btn primary" data-act="expand"
          ${n.expanding || n.unlinked ? 'disabled' : ''}>${expandLabel}</button>
        <button class="btn" data-act="close">Close</button>
      </div>

      ${n.error ? `<section><h4>Couldn't finish</h4><p class="bio">${esc(n.error)}</p></section>` : ''}
      ${facts}
      ${bio}
      ${sessionNotes}
      ${tags}

      <section>
        <h4>Listen</h4>
        <div class="listen">
          ${listenLinks(n).map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.name)} ↗</a>`).join('')}
        </div>
      </section>
    `;
  }

  function factRow(self, edge, other, outgoing) {
    const color = kindColor(other.kind);
    // Edge labels read subject → object; flip the sentence when we're
    // looking at it from the object's side.
    const phrase = outgoing
      ? `${esc(edge.label || edge.kind)}`
      : `${esc(invert(edge.label || edge.kind))}`;
    return `
      <div class="fact">
        <span class="bar" style="background:${color}"></span>
        <div>
          <button class="jump" data-id="${esc(other.id)}">
            <span class="rel">${phrase} </span><b>${esc(other.label)}</b>
          </button>
          ${edge.lore ? `<span class="lore">${esc(edge.lore)}</span>` : ''}
        </div>
      </div>`;
  }

  return { show, hide, render, get current() { return current; } };
}

/* Strongest ties first — that's the order someone reads them in anyway. */
const ORDER = ['member', 'founded', 'collab', 'credit', 'produced', 'performed',
               'released', 'track', 'recordedAt', 'onLabel', 'wroteWork', 'otherTake',
               'related', 'similar'];
const rank = k => { const i = ORDER.indexOf(k); return i < 0 ? 99 : i; };

/* Turn "played bass in · 1971 – 1978" into something that still reads
   correctly when you're standing on the other end of the arrow. */
function invert(label) {
  const [phrase, ...rest] = String(label).split(' · ');
  const tail = rest.length ? ` · ${rest.join(' · ')}` : '';
  const map = {
    'was a member of': 'counts among its members',
    'released': 'was released by',
    'produced': 'was produced by',
    'engineered': 'was engineered by',
    'mixed': 'was mixed by',
    'mastered': 'was mastered by',
    'composed': 'was composed by',
    'wrote': 'was written by',
    'arranged': 'was arranged by',
    'recorded': 'was recorded by',
    'performed on': 'features',
    'appears on': 'includes',
    'is a recording of': 'was recorded as',
    'is a version of': 'was also recorded as',
    'was recorded at': 'hosted the session for',
    'issued on': 'issued',
    'similar listening': 'similar listening',
  };
  if (map[phrase]) return map[phrase] + tail;
  if (/^played .+ in$/.test(phrase)) return phrase.replace(/^played (.+) in$/, 'had $1 played by') + tail;
  if (/^sang .+ on$/.test(phrase)) return phrase.replace(/^sang (.+) on$/, 'has $1 sung by') + tail;
  if (/^played .+ on$/.test(phrase)) return phrase.replace(/^played (.+) on$/, 'has $1 played by') + tail;
  if (/^co-founded/.test(phrase)) return 'was co-founded by' + tail;
  return label;
}

const trim = (s, n) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + '…' : s);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
