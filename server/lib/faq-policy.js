// FAQ structured-data policy, kept free of imports so any module (including
// scripts that must stay importable without a database or GitHub client) can
// ask it.
//
// FAQPage JSON-LD must describe questions the page actually shows; search
// engines treat anything else as a violation, and a client's CI may reject it.
// On by default. FAQ_SCHEMA_REQUIRES_VISIBLE=false restores the earlier policy
// of publishing FAQ schema for pages that do not show the questions (the
// sitewide visible-FAQ cap model in scripts/enforce-visible-faq-cap.js).
export function faqSchemaRequiresVisible() {
  return process.env.FAQ_SCHEMA_REQUIRES_VISIBLE !== 'false';
}
