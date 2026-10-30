// Turns one missing prompt into the same blog-outline draft the ai-recommendation agent's
// "Cover this topic" finding asks for. Shared by the page's "Ship now" button and the daily
// run (job.js runAiVisibilityShipForAllSites) so both do exactly the same thing.
// Deps are injected so this stays unit-testable without a DB or an LLM.
export async function shipPromptDraft(siteId, prompt, { findDraftByTopic, setPromptDraft, setPromptShipError, generate } = {}) {
  try {
    // Never a second post on a question something already covers.
    const existing = await findDraftByTopic(siteId, prompt.prompt_text);
    if (existing) { await setPromptDraft(siteId, prompt.id, existing); return { ok: true, draftId: existing, reused: true }; }
    const gen = generate || (await import('../../routes/action-center.js')).generateDraft;
    const draft = await gen(siteId, {
      generatorId: 'blog-outline',
      params: { topic: prompt.prompt_text, context: `A buyer-style prompt people ask AI engines, where this company is not named (source: ${prompt.source}).` },
      source: 'ai-visibility',
      findingOrigin: 'ai-recommendation',
      findingId: `ai-visibility:prompt:${prompt.id}`,
    });
    await setPromptDraft(siteId, prompt.id, draft.id);
    return { ok: true, draftId: draft.id };
  } catch (err) {
    await setPromptShipError(siteId, prompt.id, err.message).catch(() => {});
    return { ok: false, error: err.message };
  }
}
