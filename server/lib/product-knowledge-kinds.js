// The kinds of verified product knowledge a site can hold (migration 176).
// Its own module, not exported from store/data-analyst.js, so routes and
// store can share one list without routes depending on the (heavily
// test-mocked) store module for a constant.
export const PRODUCT_KNOWLEDGE_KINDS = Object.freeze(['capability', 'flow', 'pricing', 'audience', 'proof']);
