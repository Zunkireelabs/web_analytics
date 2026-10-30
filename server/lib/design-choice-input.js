import { hasDesignOptions, designOptionsFor } from './fix-design-options.js';

// When the layout repair loop (action-center.js, approveAndPublishDraft) gives up on a block, this decides whether there
// is a real choice to put to a person and, if so, what to record. null means "no choice to offer": the failure is
// reported the way it always was. Pure, so the decision is tested without a browser or a database.
//
// There is a real choice only when the site has at least two of its OWN templates that can show this block differently
// (see fix-design-options.js), and the draft was not already built with a template a person picked: a picked layout that
// still breaks must not loop back to the same question forever.
export function designChoiceInputFor({ draft, componentTemplates, attempts = [] }) {
  if (!draft?.finding_id || !hasDesignOptions(draft.action_type)) return null;
  if (draft.content?.designTemplate) return null;
  const options = designOptionsFor(draft.action_type, componentTemplates);
  if (!options.length) return null;

  const page = draft.input?.page || draft.content?.page || null;
  const path = (() => { try { return page ? new URL(page, 'https://x.invalid').pathname : null; } catch { return null; } })();
  const n = attempts.length;
  return {
    findingId: draft.finding_id, generatorId: draft.action_type, draftId: draft.id,
    title: `Add an FAQ block${path ? ` to ${path}` : ''}`, pageUrl: page,
    reason: `The agent tried ${n ? `${n} time${n === 1 ? '' : 's'}` : 'several times'} to add this without changing how your page looks, and could not. Nothing was published and your site is unchanged. Pick which of your site's own layouts it should use.`,
    attempts, options,
  };
}

// The reason shown on the card when the layout repair loop gave up and the site has no second layout to offer. A layout
// cannot be fixed by the automatic recovery rounds (they re-check a page that has not changed), so this goes to a
// person straight away instead of cycling. Worded to say what was tried and what would unblock it.
export function layoutNeedsPersonReason({ draft, attempts = [] }) {
  const n = attempts.length;
  const page = draft?.input?.page || draft?.content?.page || null;
  const path = (() => { try { return page ? new URL(page, 'https://x.invalid').pathname : null; } catch { return null; } })();
  return `Needs a person: the agent tried ${n ? `${n} time${n === 1 ? '' : 's'}` : 'several times'} to fit this${path ? ` into ${path}` : ''} without changing how your page looks, and could not. `
    + 'This site has no other layout the agent could try for this block. Add a second layout for it, or have someone look at the page.';
}
