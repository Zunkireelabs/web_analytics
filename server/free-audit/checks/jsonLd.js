function parseJsonLdBlocks($) {
  const blocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    try {
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (item && typeof item === 'object') blocks.push(item);
        if (item && Array.isArray(item['@graph'])) {
          for (const g of item['@graph']) {
            if (g && typeof g === 'object') blocks.push(g);
          }
        }
      }
    } catch {
      // ignore malformed JSON-LD blocks
    }
  });
  return blocks;
}

function typesOf(block) {
  const t = block['@type'];
  if (!t) return [];
  return Array.isArray(t) ? t : [t];
}

export { parseJsonLdBlocks, typesOf };
