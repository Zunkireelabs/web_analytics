import { translateQueries } from '../../report/translate.js';

// English glosses for the keywords the Analyst page lists, so a reviewer can
// tell what a Nepali / Dutch / German / etc. query actually means before
// deciding to act on it.
//
// This is only a view over report/translate.js's shared translation cache
// (the query_translations table): one cache, one prompt, one convention. It
// keeps the non-English entries and drops the rest, so the UI shows a gloss
// only where one helps.
//
// Purely decorative: every failure path returns "no translation" rather than
// throwing, so a flaky lookup can never blank the keyword table.

export const MAX_TERMS_PER_REQUEST = 60;

export async function translateKeywords(terms, { translate = translateQueries } = {}) {
  let resolved;
  try {
    resolved = await translate(terms);
  } catch (err) {
    console.warn(`[keyword-translation] translation lookup failed, showing keywords untranslated: ${err.message}`);
    return {};
  }
  const out = {};
  for (const [term, hit] of resolved || []) {
    const language = String(hit?.language || '').trim();
    const english = String(hit?.translation || '').trim();
    if (!language || !english) continue;
    if (language.toLowerCase() === 'english' || language.toLowerCase() === 'unknown') continue;
    if (english.toLowerCase() === term.toLowerCase()) continue;
    out[term] = { language, english };
  }
  return out;
}
