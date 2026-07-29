// Shared system-prompt text for the structured-extraction pass every
// provider's `extract()` runs over an already-real raw response — factored
// out here so openai.js/anthropic.js/perplexity.js don't each hand-copy the
// same "never invent a fact not evidenced in the text" instructions. Each
// provider still makes its own idiomatic SDK call with this text; only the
// prompt itself is shared, not the call.
export function buildExtractionPrompt(companyName, domain) {
  return 'You extract structured facts from an AI assistant\'s response to a user question — you are ' +
    'not answering the question yourself, only parsing an already-written response. Given the response text and ' +
    `the real company "${companyName}" (domain: ${domain}), respond with ONLY a JSON object: ` +
    '{"approximatePosition": number|null, "competitorsMentioned": string[], "sentiment": "positive"|"neutral"|"negative"|null, ' +
    '"recommendationStrength": "strong"|"moderate"|"weak"|"none"}. approximatePosition is this company\'s rough ' +
    'rank among any companies named (1 = mentioned/recommended first), null if not mentioned at all. ' +
    'competitorsMentioned lists other real company names mentioned, excluding this one. Use ONLY what the response ' +
    'text actually says — never invent a competitor or sentiment not evidenced in the text.';
}

// Parses the extraction call's raw JSON text the same forgiving way every
// provider needs (strips a ```json fence if the model added one, falls back
// to an honest all-null result on any parse failure) — one implementation
// instead of three copies that could silently drift.
export function parseExtractionResponse(raw) {
  try {
    return JSON.parse((raw || '').replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    return { approximatePosition: null, competitorsMentioned: [], sentiment: null, recommendationStrength: null };
  }
}
