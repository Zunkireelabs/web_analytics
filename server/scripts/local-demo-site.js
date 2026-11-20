// Dev tool: a tiny stand-in for the demo client's own website, on this machine only, so the Content previews can load that site's web
// fonts the way they do for a real client (they read the font links from the site's home page). It serves one page and nothing else.
//   node server/scripts/local-demo-site.js   (then seed-local-actions.js points the demo project's website at it)
import http from 'node:http';

const PORT = Number(process.env.DEMO_SITE_PORT || 4010);
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Zennly (local demo site)</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Fraunces:wght@600&family=Noto+Sans+Devanagari:wght@400;600&display=swap">
</head><body style="font-family:'DM Sans',sans-serif;background:#fbf8f3;color:#1c2b2a;padding:48px"><h1 style="font-family:Fraunces,serif">Zennly</h1><p>Local demo site for previews. Nothing here is real.</p></body></html>`;

http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); })
  .listen(PORT, '127.0.0.1', () => console.log(`Local demo site on http://localhost:${PORT}`));
