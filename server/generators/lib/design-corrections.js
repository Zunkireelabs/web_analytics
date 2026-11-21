// The repair-feedback channel, in one place.
//
// When a draft is checked against the real site (a layout check, a render
// comparison, a quality gate) and something is wrong, the autonomous repair
// step (design-repair.js) regenerates it with a plain-language correction in
// params.designCorrections. That only works if the generator actually puts it
// in front of the model — and most of them did not: direct-answer, faq,
// qa-content, refresh-content and missing-page-create never read it, so a
// "repair" regenerated the same content and failed identically. Every
// LLM-writing generator now routes its user prompt through this one helper so
// the channel cannot silently go unread again.
//
// Appended LAST: the most recent instruction is the one the model weighs most,
// the same ordering landing-page.js already used.
export function withDesignCorrections(user, params) {
  const c = params && typeof params.designCorrections === 'string' ? params.designCorrections.trim() : '';
  return c ? `${user}\n\n${c}` : user;
}
