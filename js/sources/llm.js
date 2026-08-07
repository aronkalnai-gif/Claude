/* The storytelling layer.

   The other sources give us the skeleton: X played bass in Y from 1971 to
   1978; this record was cut at Studio Z. True, but flat. This asks Claude
   to turn each of those into the sentence a knowledgeable friend would
   actually say — and, critically, to say *nothing* when it doesn't know
   something worth adding, rather than inventing colour.

   Structured outputs guarantee the response parses, so a stray sentence of
   preamble can never break the UI. */

import { postJSON, SourceError } from '../net.js';
import { settings, hasLlm } from '../config.js';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';

/* Effort and explicit thinking config are only accepted on the newer
   models; Haiku 4.5 rejects `effort` outright. */
const SUPPORTS_EFFORT = /^claude-(opus-5|sonnet-5|opus-4-8)/;

const SYSTEM = `You annotate a music relationship graph. For each connection you are given, write one sentence of real context that makes it interesting to a curious listener.

Ground every sentence in the structured facts supplied. You may add well-established music history you are confident about — a studio's reputation, what a session led to, how a lineup change altered a band's sound, who else was in the room. Prefer the concrete and specific: years, places, records, instruments.

Rules:
- One sentence. Around 15-30 words. No preamble, no "interestingly", no hedging.
- Never invent a fact, date, name or anecdote. If you have nothing beyond what the structured data already states, omit that connection entirely rather than restating the data back.
- Do not begin by naming both parties again — the interface already shows who is connected to whom. Start with the substance.
- Write plainly and in the past tense where appropriate. No exclamation marks.

Return only connections you have something genuine to add to. Returning fewer notes than you were given connections is correct and expected.`;

const SCHEMA = {
  type: 'object',
  properties: {
    notes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id:   { type: 'string', description: 'The exact id of the connection this note is about.' },
          text: { type: 'string', description: 'One sentence of context.' },
        },
        required: ['id', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['notes'],
  additionalProperties: false,
};

/**
 * @param {{label:string, kind:string}} subject  the node being expanded
 * @param {Array<{id:string, other:string, otherKind:string, relation:string, extra?:string}>} connections
 * @returns {Promise<Map<string,string>>} connection id -> sentence
 */
export async function annotate(subject, connections) {
  if (!hasLlm() || !connections.length) return new Map();

  const model = settings().anthropicModel || 'claude-opus-5';

  const lines = connections.map(c =>
    `- id: ${c.id}\n  ${subject.label} — ${c.relation} — ${c.other} (${c.otherKind})` +
    (c.extra ? `\n  also known: ${c.extra}` : ''));

  const body = {
    model,
    max_tokens: 2000,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{
      role: 'user',
      content:
        `Subject: ${subject.label} (${subject.kind})\n\n` +
        `Connections:\n${lines.join('\n')}\n\n` +
        `Write a note for the connections you can genuinely add to.`,
    }],
  };

  if (SUPPORTS_EFFORT.test(model)) {
    // Short, grounded sentences from data we hand over — extended reasoning
    // buys nothing here and costs latency on every tap.
    body.thinking = { type: 'disabled' };
    body.output_config.effort = 'low';
  }

  const res = await postJSON(ENDPOINT, body, {
    headers: {
      'x-api-key': settings().anthropicKey,
      'anthropic-version': '2023-06-01',
      // Required for any browser-originated call; without it the API
      // refuses the request outright.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
  });

  if (res.stop_reason === 'refusal') {
    throw new SourceError('Anthropic', `request declined (${res.stop_details?.category || 'unspecified'})`);
  }

  const text = (res.content || []).find(b => b.type === 'text')?.text;
  if (!text) return new Map();

  let parsed;
  try { parsed = JSON.parse(text); }
  catch { return new Map(); }

  const out = new Map();
  for (const n of parsed.notes || []) {
    if (n?.id && n?.text) out.set(String(n.id), String(n.text).trim());
  }
  return out;
}

/** Used by the diagnostics panel. */
export async function ping() {
  const notes = await annotate(
    { label: 'Cream', kind: 'group' },
    [{ id: 't1', other: 'Eric Clapton', otherKind: 'person', relation: 'played guitar in · 1966 – 1968' }],
  );
  return notes.size ? 'key accepted, model responding' : 'key accepted (model returned no note)';
}
