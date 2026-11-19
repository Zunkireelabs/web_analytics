// Real lines from superrank-web-prod on Kangchenjunga (read 2026-11-18), unchanged. Crawler addresses are public.
// REAL_BOT: OAI-SearchBot, address 51.8.102.237 (inside OpenAI's published 51.8.102.0/24).
// REAL_META: Meta's web indexer. REAL_OWN: our own opportunity agent (address is the Docker gateway).
export const REAL_BOT = '172.18.0.3 - - [17/Nov/2026:19:28:09 +0000] "GET /robots.txt HTTP/1.1" 200 650 "-" "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36; compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot" "51.8.102.237"';
export const REAL_META = '172.18.0.3 - - [17/Nov/2026:20:58:13 +0000] "GET /blog/robots-txt-for-ai-crawlers-gptbot-claudebot-perplexitybot HTTP/1.1" 200 12290 "-" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 (compatible; meta-webindexer/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler))" "57.141.20.79"';
export const REAL_OWN = '172.18.0.3 - - [18/Nov/2026:01:31:49 +0000] "GET /blog/robots-txt-for-ai-crawlers-gptbot-claudebot-perplexitybot HTTP/1.1" 200 12290 "-" "Mozilla/5.0 (compatible; ZunkireeAnalyticsBot/1.0; +opportunity-agent)" "172.18.0.1"';

// The mistake a whole-line search makes: an ordinary visitor reading the blog post whose ADDRESS contains the bot names.
export const SLUG_VISITOR = '172.18.0.3 - - [17/Nov/2026:10:00:00 +0000] "GET /blog/robots-txt-for-ai-crawlers-gptbot-claudebot-perplexitybot HTTP/1.1" 200 12290 "https://www.google.com/" "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" "203.0.113.9"';

// Shapes copied from the real vendor files (fetched 2026-11-18), shortened.
export const SEARCHBOT_JSON = JSON.stringify({ creationTime: '2026-01-02T11:00:00.000000', prefixes: [{ ipv4Prefix: '51.8.102.0/24' }, { ipv4Prefix: '4.227.36.0/25' }] });
export const ANTHROPIC_JSON = JSON.stringify({ creationTime: '2026-10-20T00:00:00Z', prefixes: [{ ipv4Prefix: '216.73.216.0/22' }, { ipv4Prefix: '34.162.230.222/32' }] });
export const GOOGLE_JSON = JSON.stringify({ creationTime: '2026-11-17T15:45:58.000000', prefixes: [{ ipv6Prefix: '2001:4860:4801:10::/64' }, { ipv4Prefix: '66.249.64.0/27' }] });
