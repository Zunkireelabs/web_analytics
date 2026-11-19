// Shared by every provider that gets real cited URLs back (openai web search, perplexity, dataforseo-ai): turns URLs
// into the bare domains stored in ai_prompt_runs.cited_domains. One implementation so "www.x.com" and "x.com" never
// count as two different sources depending on which provider answered.

export function domainOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Unique domains, in the order their first URL appeared (that order is the citation order). */
export function domainsFromUrls(urls) {
  return [...new Set((urls || []).map(domainOf).filter(Boolean))];
}
