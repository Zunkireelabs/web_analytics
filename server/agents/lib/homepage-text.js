import * as cheerio from 'cheerio';
import { fetchHtml } from './page-content.js';

// Shared by prospect-discovery.js and trial-signup classification
// (server/routes/trial-signup.js) — both need the same real, evidence-
// checkable question answered: "does this OTHER company's own homepage
// contain this real phrase", never inferred from a domain/company name
// alone. SSRF-guarded via fetchHtml itself.
export async function fetchHomepageBodyText(url) {
  const fetched = await fetchHtml(url);
  if (!fetched.ok) return null;
  const $ = cheerio.load(fetched.html);
  $('nav, header, footer, script, style').remove();
  return { url: fetched.url, text: $('body').text().replace(/\s+/g, ' ').trim().toLowerCase() };
}

export function findMatchingPhrase(bodyText, phrases) {
  return (phrases || []).find((p) => p && bodyText.includes(String(p).toLowerCase())) || null;
}
