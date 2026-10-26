export default function webmcpDetection({ $, mcpManifest }) {
  const hasManifest = !!(mcpManifest && mcpManifest.present);
  const hasDeclarativeTag = $('script[type="application/webmcp+json"]').length > 0;

  if (!hasManifest && !hasDeclarativeTag) {
    return {
      id: 'webmcp-detection',
      title: 'WebMCP Tools',
      category: 'agentic',
      passed: null,
      score: 0,
      maxScore: 0,
      message: 'No WebMCP manifest (/.well-known/mcp.json) or declarative tool tags detected.',
      recommendation:
        'Not applicable for most sites today — WebMCP is an emerging, low-adoption standard. Optional if you want to be forward-looking: publish a manifest at /.well-known/mcp.json describing invocable actions (e.g. "add to cart", "submit form") that AI agents can call directly.',
    };
  }

  const foundVia = [
    hasManifest ? '/.well-known/mcp.json manifest' : null,
    hasDeclarativeTag ? 'a declarative <script type="application/webmcp+json"> tag' : null,
  ].filter(Boolean).join(' and ');

  return {
    id: 'webmcp-detection',
    title: 'WebMCP Tools',
    category: 'agentic',
    passed: true,
    score: 1,
    maxScore: 1,
    message: `WebMCP tools detected via ${foundVia}.`,
    recommendation: 'No action needed.',
  };
};
