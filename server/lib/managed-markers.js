// The Action Center's own SEOAI:*:START/END marker comments (and the
// legacy single-line "# SEOAI:x" / "<!-- SEOAI:x -->" forms) are
// infrastructure, not organic page content — an empty
// `<!-- SEOAI:FAQ:START --><!-- SEOAI:FAQ:END -->` marker literally
// contains the substring "FAQ"/"SCHEMA"/etc, which would otherwise falsely
// trip a keyword- or structure-based detector into thinking a page's OWN
// tool-injected content is something a human/template author put there
// (confirmed in practice: /contact/ went from a clean 'none'/90%-confidence
// read to a false 'weak' escalation the moment its marker was added).
// Shared by every detector that needs to look at only what a page's real
// author actually wrote — implementers/lib/render-inspector.js's
// scanVisibleFaqSignals/hasVisibleFaqSignal, and generators (faq.js,
// qa-content.js) deciding whether a page already has real organic content
// they must not silently duplicate or fabricate over.
const MANAGED_MARKER_PATTERN = /<!--\s*SEOAI:\w+:START\s*-->[\s\S]*?<!--\s*SEOAI:\w+:END\s*-->|(?:#\s*SEOAI:\w+\s*|<!--\s*SEOAI:\w+\s*-->)/gi;

export function stripManagedMarkers(fileContent) {
  return fileContent.replace(MANAGED_MARKER_PATTERN, '');
}
