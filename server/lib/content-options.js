// The options a person can pick between for each kind of content the agent finds. One catalog, read by the API (which
// validates a pick against it and sends it to the Content page) and by the scheduled run that builds the chosen
// option, so the words on the screen and the thing that gets built can never drift apart.
//
// These are the real choices the generators can act on, not screenshots of the client's site: the Content page draws
// a simple wireframe for each. No option claims anything about a particular client's site.
export const CONTENT_OPTIONS = {
  'landing-page': {
    type: 'landing', label: 'Landing pages',
    options: [
      { key: 'A', name: 'Benefits and steps', note: 'A headline, three benefits, then how it works.' },
      { key: 'B', name: 'Form first', note: 'The enquiry form sits at the top so visitors can act straight away.' },
      { key: 'C', name: 'Stories and proof', note: 'Leads with two client stories, then the call to action. Warmer and longer.' },
    ],
  },
  translation: {
    type: 'translation', label: 'Translations',
    options: [
      { key: 'A', name: 'Same layout', note: 'Your page exactly as it is, with the words translated.' },
      { key: 'B', name: 'Room for longer words', note: 'Headings and buttons can grow, because many languages run longer than English.', tag: 'Recommended' },
      { key: 'C', name: 'Shorter wording', note: 'The translation is tightened so it fits your layout without any change.' },
    ],
  },
  'blog-outline': {
    type: 'blog', label: 'Blog posts',
    options: [
      { key: 'A', name: 'Guide with headings', note: 'A classic guide: an introduction, then clear sections.' },
      { key: 'B', name: 'Short answer first', note: 'Opens with a two-line answer that Google and AI tools can quote.', tag: 'Best for quick answers' },
      { key: 'C', name: 'Question and answer', note: 'Built as a list of the questions people actually ask.' },
    ],
  },
};

export const optionKeysFor = (generatorId) => (CONTENT_OPTIONS[generatorId]?.options || []).map((o) => o.key);

// A pick is valid only for a generator that has options, and only for one of its option keys.
export function validatePick({ generatorId, optionKey } = {}) {
  if (!CONTENT_OPTIONS[generatorId]) return { ok: false, error: 'That kind of content has no options to pick from.' };
  if (!optionKeysFor(generatorId).includes(optionKey)) return { ok: false, error: 'That is not one of the options for this content.' };
  return { ok: true };
}

// What the generator is told about the option a person picked. It goes in through `designCorrections`, the channel the
// design repair loop already uses to hand a generator its most recent instruction (generators append it last).
export function instructionFor(generatorId, optionKey) {
  const o = CONTENT_OPTIONS[generatorId]?.options.find((x) => x.key === optionKey);
  if (!o) return null;
  return `THE PERSON APPROVING THIS CHOSE A STRUCTURE — follow it: "${o.name}". ${o.note} Keep every fact grounded exactly as before; this changes how the content is organised, never what is claimed.`;
}

// Approving several picks at once (the Approve button under the list): every one is checked before any is saved, so a
// batch is never half-saved because one entry was wrong. Returns the first problem, with its position.
export function validatePickBatch(list) {
  if (!Array.isArray(list) || list.length === 0) return { ok: false, error: 'Select an option first.' };
  if (list.length > 100) return { ok: false, error: 'That is too many at once.' };
  const seen = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const { findingId, generatorId, optionKey } = list[i] || {};
    if (!findingId || typeof findingId !== 'string') return { ok: false, index: i, error: 'One of the selections has no item.' };
    if (seen.has(findingId)) return { ok: false, index: i, error: 'The same item was selected twice.' };
    seen.add(findingId);
    const check = validatePick({ generatorId, optionKey });
    if (!check.ok) return { ok: false, index: i, error: check.error };
  }
  return { ok: true };
}
