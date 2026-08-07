/* Settings and diagnostics.

   The diagnostics panel exists because this app talks to five independent
   services straight from the browser, and when one of them says no, the
   browser's own error messages are famously unhelpful. Running the checks
   on the device tells you exactly which source is unhappy and why. */

import { settings, saveSettings } from '../config.js';
import { clearCache, cacheSize, getJSON } from '../net.js';
import { loadImage } from '../sources/coverart.js';
import * as lastfm from '../sources/lastfm.js';
import * as discogs from '../sources/discogs.js';
import * as llm from '../sources/llm.js';

export function createModal(root, titleEl, bodyEl, closeBtn) {
  closeBtn.addEventListener('click', hide);
  root.addEventListener('click', e => { if (e.target === root) hide(); });

  function hide() { root.hidden = true; }

  function openSettings() {
    titleEl.textContent = 'Settings';
    root.hidden = false;
    renderSettings();
  }

  function openDiagnostics() {
    titleEl.textContent = 'Diagnostics';
    root.hidden = false;
    renderDiagnostics();
  }

  /* ── Settings form ────────────────────────────────────────────────── */

  function renderSettings() {
    const s = settings();
    bodyEl.innerHTML = `
      <div class="note">
        <b>Where your keys live.</b> They're stored in this browser's local
        storage on this device only — nothing is sent anywhere except to the
        service the key belongs to. That's the trade for having no server to
        run. Use keys you're happy to rotate, and don't put this app on a
        domain you share with other people.
      </div>

      <div class="field">
        <label for="f-lastfm">Last.fm API key</label>
        <span class="hint">Adds an artist's most-played songs, and fills in a
          style for artists MusicBrainz hasn't tagged yet.
          <a href="https://www.last.fm/api/account/create" target="_blank" rel="noopener">Get one free ↗</a></span>
        <input id="f-lastfm" type="text" inputmode="latin" autocomplete="off"
          spellcheck="false" value="${esc(s.lastfmKey)}" placeholder="32-character key">
      </div>

      <div class="field">
        <label for="f-discogs">Discogs personal token</label>
        <span class="hint">Adds session personnel — the sidemen and engineers
          on older records.
          <a href="https://www.discogs.com/settings/developers" target="_blank" rel="noopener">Generate a token ↗</a></span>
        <input id="f-discogs" type="text" autocomplete="off" spellcheck="false"
          value="${esc(s.discogsToken)}" placeholder="personal access token">
      </div>

      <div class="field">
        <label for="f-anthropic">Anthropic API key</label>
        <span class="hint">Writes a sentence of real context for each
          connection instead of just showing the raw relationship.
          <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">Console ↗</a></span>
        <input id="f-anthropic" type="password" autocomplete="off" spellcheck="false"
          value="${esc(s.anthropicKey)}" placeholder="sk-ant-…">
      </div>

      <div class="field">
        <label for="f-model">Model</label>
        <span class="hint">Opus writes the best notes. Haiku is quicker and cheaper.</span>
        <select id="f-model">
          <option value="claude-opus-5"   ${sel(s.anthropicModel, 'claude-opus-5')}>Claude Opus 5 — best notes</option>
          <option value="claude-sonnet-5" ${sel(s.anthropicModel, 'claude-sonnet-5')}>Claude Sonnet 5 — balanced</option>
          <option value="claude-haiku-4-5"${sel(s.anthropicModel, 'claude-haiku-4-5')}>Claude Haiku 4.5 — fastest</option>
        </select>
      </div>

      <div class="field">
        <label>Sources</label>
        ${toggle('useLastfm', 'Last.fm songs & tags', s.useLastfm)}
        ${toggle('useDiscogs', 'Discogs credits', s.useDiscogs)}
        ${toggle('useLlm', 'Written context', s.useLlm)}
        ${toggle('useCoverArt', 'Cover art', s.useCoverArt)}
      </div>

      <div class="btn-row">
        <button class="btn primary" id="s-save">Save</button>
        <button class="btn" id="s-diag">Diagnostics</button>
      </div>
      <div class="btn-row">
        <button class="btn" id="s-clear">Clear cached lookups (${cacheSize()})</button>
      </div>
    `;

    bodyEl.querySelector('#s-save').onclick = () => {
      saveSettings({
        lastfmKey: val('#f-lastfm'),
        discogsToken: val('#f-discogs'),
        anthropicKey: val('#f-anthropic'),
        anthropicModel: val('#f-model'),
        useLastfm: checked('useLastfm'),
        useDiscogs: checked('useDiscogs'),
        useLlm: checked('useLlm'),
        useCoverArt: checked('useCoverArt'),
      });
      hide();
    };
    bodyEl.querySelector('#s-diag').onclick = openDiagnostics;
    bodyEl.querySelector('#s-clear').onclick = e => {
      clearCache();
      e.target.textContent = 'Cache cleared';
      e.target.disabled = true;
    };
  }

  const val = q => bodyEl.querySelector(q).value.trim();
  const checked = name => bodyEl.querySelector(`input[data-t="${name}"]`).checked;
  const sel = (a, b) => (a === b ? 'selected' : '');

  const toggle = (name, label, on) => `
    <label style="display:flex;align-items:center;gap:10px;font-weight:400;margin:9px 0">
      <input type="checkbox" data-t="${name}" ${on ? 'checked' : ''}
        style="width:auto;accent-color:#C4603F;transform:scale(1.2)">
      <span>${esc(label)}</span>
    </label>`;

  /* ── Diagnostics ──────────────────────────────────────────────────── */

  async function renderDiagnostics() {
    const checks = buildChecks();
    bodyEl.innerHTML = `
      <p class="hint" style="margin:0 0 18px;color:var(--ink-dim);font-size:14px;line-height:1.55">
        Each source is contacted for real, from this device. A failure here is
        the actual reason something isn't appearing in the graph.
      </p>
      <div class="diag" id="diag-list">
        ${checks.map((c, i) => `
          <div class="diag-row" id="d${i}">
            <span class="dotmark"></span>
            <div class="what"><b>${esc(c.name)}</b><small>checking…</small></div>
          </div>`).join('')}
      </div>
      <div class="btn-row">
        <button class="btn" id="d-back">Back to settings</button>
      </div>`;

    bodyEl.querySelector('#d-back').onclick = openSettings;

    for (let i = 0; i < checks.length; i++) {
      const row = bodyEl.querySelector(`#d${i}`);
      if (!row) return;   // panel closed mid-run
      const c = checks[i];
      if (c.skip) {
        row.className = 'diag-row skip';
        row.querySelector('small').textContent = c.skip;
        continue;
      }
      try {
        const detail = await c.run();
        if (!row.isConnected) return;
        row.className = 'diag-row ok';
        row.querySelector('small').textContent = detail || 'working';
      } catch (err) {
        if (!row.isConnected) return;
        row.className = 'diag-row fail';
        row.querySelector('small').textContent = err?.message || String(err);
      }
    }
  }

  function buildChecks() {
    const s = settings();
    return [
      {
        name: 'MusicBrainz — search',
        run: async () => {
          const d = await getJSON('https://musicbrainz.org/ws/2/artist?query=miles%20davis&fmt=json&limit=1',
            { cache: false, retries: 1 });
          if (!d.artists?.length) throw new Error('no results returned');
          return `found "${d.artists[0].name}"`;
        },
      },
      {
        name: 'MusicBrainz — relationships',
        run: async () => {
          // Resolve the test subject by search rather than hardcoding an
          // MBID, so this check can never fail for the wrong reason.
          const found = await getJSON('https://musicbrainz.org/ws/2/artist?query=artist:Cream%20AND%20type:group&fmt=json&limit=1',
            { cache: false, retries: 1 });
          const artist = found.artists?.[0];
          if (!artist) throw new Error('search returned nothing to look up');
          const d = await getJSON(`https://musicbrainz.org/ws/2/artist/${artist.id}?inc=artist-rels&fmt=json`,
            { cache: false, retries: 1 });
          const rels = (d.relations || []).length;
          if (!rels) throw new Error('lookup worked but returned no relationships');
          return `${rels} relationships on ${d.name}`;
        },
      },
      {
        name: 'MusicBrainz — style search',
        run: async () => {
          const d = await getJSON('https://musicbrainz.org/ws/2/artist?query=tag%3A%22hard%20bop%22&fmt=json&limit=3',
            { cache: false, retries: 1 });
          const names = (d.artists || []).map(a => a.name);
          if (!names.length) throw new Error('tag search returned nothing');
          return `hard bop → ${names.slice(0, 2).join(', ')}`;
        },
      },
      {
        name: 'Wikipedia — summaries',
        run: async () => {
          const d = await getJSON('https://en.wikipedia.org/api/rest_v1/page/summary/Miles_Davis',
            { cache: false, retries: 1 });
          if (!d.extract) throw new Error('no extract in response');
          return `${d.extract.length} characters of prose`;
        },
      },
      {
        name: 'Cover Art Archive',
        skip: s.useCoverArt ? null : 'switched off in settings',
        run: async () => {
          const found = await getJSON('https://musicbrainz.org/ws/2/release-group?query=Abbey%20Road%20AND%20artist:Beatles&fmt=json&limit=3',
            { cache: false, retries: 1 });
          const groups = found['release-groups'] || [];
          if (!groups.length) throw new Error('no test album to fetch art for');
          for (const g of groups) {
            const img = await loadImage(`https://coverartarchive.org/release-group/${g.id}/front-250`);
            if (img) return `loaded ${img.naturalWidth}×${img.naturalHeight} for "${g.title}"`;
          }
          throw new Error('no art returned for any test album');
        },
      },
      {
        name: 'Last.fm — songs & tags',
        skip: !s.lastfmKey ? 'no key set' : (!s.useLastfm ? 'switched off in settings' : null),
        run: lastfm.ping,
      },
      {
        name: 'Discogs — credits',
        skip: !s.discogsToken ? 'no token set' : (!s.useDiscogs ? 'switched off in settings' : null),
        run: discogs.ping,
      },
      {
        name: `Anthropic — ${s.anthropicModel}`,
        skip: !s.anthropicKey ? 'no key set' : (!s.useLlm ? 'switched off in settings' : null),
        run: llm.ping,
      },
    ];
  }

  return { openSettings, openDiagnostics, hide };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
