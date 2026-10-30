import { listSavedPicks, setPickStatus, claimPickDay, releaseStuckBuilding } from '../../store/content-picks.js';
import { todayInTz } from '../../util/dates.js';
import { getRecommendationByFindingId } from '../../store/recommendations.js';
import { submitDraftForApproval, updateDraft } from '../../store/drafts.js';
import { listChosenDesignChoices, markDesignChoiceStatus } from '../../store/design-choices.js';
import { generateDraft, approveAndPublishDraftUnattended } from '../../routes/action-center.js';
import { instructionFor } from '../../lib/content-options.js';

// The next-run job for content picks. A person's one click on an option (landing page, translation, blog post) is
// their approval and was only SAVED at the time; this is what builds it. For each saved pick it runs the same chain a
// person's own Approve click runs (generate -> submit -> approve and publish), with the chosen option handed to the
// generator, so the existing checks apply unchanged: the Quality Gate, the real-browser layout check with its repair
// attempts, and the rendering gate. Approvals made back to back land in one shared branch and pull request.
//
// Called from the daily ship run (job.js) inside the site's ship lock. It never throws: one pick failing must not stop
// the others or the rest of the day's work.
const SHIPPED = new Set(['pr_opened', 'implemented', 'merged_to_stage']);
const RETRY_LATER = /rate.?limit|timed out|timeout|ECONN|ETIMEDOUT|try again|design agent|still being (captured|derived)|temporar/i;

export async function buildSavedContentPicks(site, deps = {}) {
  const d = { listSavedPicks, setPickStatus, getRecommendationByFindingId, generateDraft, submitDraftForApproval, approveAndPublishDraftUnattended, ...deps };
  const out = { built: 0, withdrawn: 0, retryLater: 0, left: 0, skipped: null };
  if (!site?.repo_owner || !site?.repo_name) return { ...out, skipped: 'no-repository' };

  const picks = await d.listSavedPicks(site.id);
  for (const pick of picks) {
    const id = pick.finding_id;
    try {
      const rec = await d.getRecommendationByFindingId(site.id, id);
      const instruction = instructionFor(pick.generator_id, pick.option_key);
      if (!rec || !instruction) { await d.setPickStatus(site.id, id, 'withdrawn', ['saved']); out.withdrawn += 1; continue; }
      if (!(await d.setPickStatus(site.id, id, 'building', ['saved']))) continue; // the person changed or cleared it meanwhile

      const draft = await d.generateDraft(site.id, {
        generatorId: pick.generator_id, source: 'content-pick', findingId: id, waitForDesignAgent: true,
        params: { ...(rec.params || {}), designCorrections: instruction },
      });
      if (SHIPPED.has(draft.status)) { await d.setPickStatus(site.id, id, 'shipped', ['building']); out.built += 1; continue; }
      if (!['draft', 'edited'].includes(draft.status)) {
        // A draft already exists and someone is past 'draft' with it (awaiting review, say). Not ours to push out from
        // under them: put the pick back and report it, so nothing is built twice or over a person's review.
        await d.setPickStatus(site.id, id, 'saved', ['building']); out.left += 1; continue;
      }
      if (!(await d.submitDraftForApproval(site.id, draft.id))) throw new Error('The draft was not in a state that could be submitted.');
      await d.approveAndPublishDraftUnattended(site.id, draft.id, { userId: pick.chosen_by ?? null, deferPr: false });
      await d.setPickStatus(site.id, id, 'shipped', ['building']);
      out.built += 1;
    } catch (err) {
      const retry = RETRY_LATER.test(String(err?.message || ''));
      await d.setPickStatus(site.id, id, retry ? 'saved' : 'withdrawn', ['building', 'saved']).catch(() => {});
      if (retry) out.retryLater += 1; else out.withdrawn += 1;
      console.warn(`[pick-runner] site ${site.id} pick ${id}: ${retry ? 'will retry next run' : 'withdrawn'}: ${String(err?.message || err).slice(0, 200)}`);
    }
  }
  return out;
}

// The next-run job for DESIGN CHOICES on fixes. The agent could not fit the block into the site's design, so it asked; a
// person picked one of the site's own templates. This builds the fix again with exactly that template: it generates the
// draft, sets `designTemplate` on its content (the builder, marker-merge.js, renders the block with that template), then
// runs the same submit -> approve and publish chain, so the real-browser layout check and its repairs still apply. If it
// still cannot be built, the choice goes back to the person (needs_choice) instead of being forgotten.
export async function buildChosenDesignChoices(site, deps = {}) {
  const d = { listChosenDesignChoices, markDesignChoiceStatus, getRecommendationByFindingId, generateDraft, updateDraft, submitDraftForApproval, approveAndPublishDraftUnattended, ...deps };
  const out = { built: 0, backToPerson: 0, retryLater: 0, skipped: null };
  if (!site?.repo_owner || !site?.repo_name) return { ...out, skipped: 'no-repository' };

  for (const choice of await d.listChosenDesignChoices(site.id)) {
    const id = choice.id;
    try {
      const rec = await d.getRecommendationByFindingId(site.id, choice.finding_id);
      if (!rec) { await d.markDesignChoiceStatus(site.id, id, 'needs_choice', ['chosen']); out.backToPerson += 1; continue; }
      if (!(await d.markDesignChoiceStatus(site.id, id, 'building', ['chosen']))) continue; // taken back meanwhile

      const draft = await d.generateDraft(site.id, { generatorId: choice.generator_id, params: rec.params || {}, source: 'design-choice', findingId: choice.finding_id, waitForDesignAgent: true });
      if (SHIPPED.has(draft.status)) { await d.markDesignChoiceStatus(site.id, id, 'shipped', ['building']); out.built += 1; continue; }
      if (!['draft', 'edited'].includes(draft.status)) { await d.markDesignChoiceStatus(site.id, id, 'chosen', ['building']); continue; } // a person is reviewing one: not ours

      const withChoice = await d.updateDraft(site.id, draft.id, { content: { ...(draft.content || {}), designTemplate: choice.chosen_option } });
      if (!withChoice) throw new Error('The draft could not take the chosen layout.');
      if (!(await d.submitDraftForApproval(site.id, draft.id))) throw new Error('The draft was not in a state that could be submitted.');
      await d.approveAndPublishDraftUnattended(site.id, draft.id, { userId: null, deferPr: false });
      await d.markDesignChoiceStatus(site.id, id, 'shipped', ['building']);
      out.built += 1;
    } catch (err) {
      const retry = RETRY_LATER.test(String(err?.message || ''));
      await d.markDesignChoiceStatus(site.id, id, retry ? 'chosen' : 'needs_choice', ['building', 'chosen']).catch(() => {});
      if (retry) out.retryLater += 1; else out.backToPerson += 1;
      console.warn(`[pick-runner] site ${site.id} design choice ${id}: ${retry ? 'will retry next run' : 'back to the person'}: ${String(err?.message || err).slice(0, 200)}`);
    }
  }
  return out;
}

// What the daily ship run calls. Approving on the screen only saves; THIS builds, once per day per project: it claims the
// day first, so whatever is approved after the day's run waits for tomorrow's run and never adds another commit on top of
// today's. Content picks and chosen design choices are built together, in the day's one branch and pull request.
export async function buildApprovedForToday(site, deps = {}) {
  const d = { claimPickDay, releaseStuckBuilding, buildSavedContentPicks, buildChosenDesignChoices, todayInTz, ...deps };
  await d.releaseStuckBuilding(site.id).catch(() => {});
  const day = d.todayInTz(site.timezone || 'UTC');
  if (!(await d.claimPickDay(site.id, day))) return { skipped: 'already-built-today', day };
  const picks = await d.buildSavedContentPicks(site);
  const choices = await d.buildChosenDesignChoices(site);
  return { day, picks, choices };
}
