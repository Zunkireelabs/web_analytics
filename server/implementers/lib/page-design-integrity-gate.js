import { getFileContent } from '../../github/client.js';
import { checkEditDesignIntegrity, pageDesignIntegrityMode, capturedClasses, pathKey } from '../../design-agent/lib/live-design-validation.js';
// Deliberately NOT importing design-drift.js: github-ops.js imports this gate, and design-drift's
// import graph (stores, db) must not be pulled into every module that pushes a branch.
const getDesignProfile = (site) => site?.url_file_map?.siteRoot?.designProfile || null;

// FINAL DESIGN-INTEGRITY GATE — the last check before ANY edit to an existing page becomes
// a commit. Placed in pushDraftBranch, beside the rendering gate and the section-
// preservation gate, because every implementer funnels through that one function: no
// generator or merge strategy can skip it and no future one has to opt in.
//
// What it checks. Only what the edit ADDS to a markup file, compared with the design that
// file already has: the file's own classes (from the base branch), the site's captured design
// vocabulary, its verified component templates and this page's captured sections. A class
// none of those contain, an inline colour/font/spacing style, or a new <style>/<script> means
// the edit extends the design instead of preserving it.
//
// What it deliberately does NOT do (documented gap, not an oversight):
//   * net-new files — there is no before-state; new pages are governed by the frontend
//     design gates (completeness + render comparison) and the structured-content renderer;
//   * non-markup files (robots, sitemap, nginx, llms.txt…);
//   * fail closed on its own plumbing: an unreadable base is "we learned nothing", same
//     contract as the section-preservation gate, never a block.
//
// PAGE_DESIGN_INTEGRITY: 'enforce' (default) blocks, 'log' records and ships, 'off' skips.
// Every decision, passes included, is recorded as evidence in log AND enforce mode so false
// positives can be measured (design-review-store.js).
const MARKUP_FILE = /\.(html?|jsx|tsx|astro|njk|liquid|md|mdx|vue|svelte|php|ejs|hbs|handlebars)$/i;
// Edits whose job IS to add a script (structured data, analytics) — the script rule is waived for them.
const SCRIPT_PERMITTED_ACTION_TYPES = new Set(['schema', 'schema-repair', 'analytics-install']);

export async function validatePageDesignIntegrity(site, draft, files, {
  fetchFile = getFileContent, ref = null, mode = pageDesignIntegrityMode(), record = null,
} = {}) {
  if (mode === 'off') return { ok: true, skipped: 'off' };
  const baseRef = ref || site?.repo_default_branch || 'main';
  const profile = getDesignProfile(site);
  const templates = site?.url_file_map?.siteRoot?.componentTemplates;

  for (const file of files) {
    if (!MARKUP_FILE.test(file.path || '')) continue;
    const existing = await fetchFile(site, file.path, baseRef).catch(() => ({ unreadable: true }));
    if (existing?.unreadable) continue; // plumbing failure: we learned nothing (fail open, as the section gate does)
    if (!existing?.content) {
      // NET-NEW page file. There is no before-state, so the vocabulary is the SITE's: its captured
      // design, verified templates and every captured page's own classes. Starts in log mode
      // (PAGE_DESIGN_INTEGRITY_NEW_FILES=log|enforce|off) so false positives are measured before it blocks;
      // the rendered check for new pages is the frontend render gate (enforced in production).
      const newMode = String(process.env.PAGE_DESIGN_INTEGRITY_NEW_FILES ?? 'log').toLowerCase();
      if (newMode === 'off') continue;
      const siteVocab = new Set();
      for (const pg of profile?.pages || []) for (const c of capturedClasses(pg.sections)) siteVocab.add(c);
      const v = checkEditDesignIntegrity({ before: '', after: file.content, profile, componentTemplates: templates, extraVocabulary: [...siteVocab], allowScripts: SCRIPT_PERMITTED_ACTION_TYPES.has(draft?.action_type) });
      if (record) {
        await Promise.resolve(record(site.id, { kind: 'integrity-new-file', actionType: draft?.action_type, draftId: draft?.id ?? null, path: file.path, mode: newMode, ok: v.ok, issues: v.issues.map((i) => ({ type: i.type, classes: (i.classes || []).slice(0, 12) })) })).catch(() => {});
      }
      if (!v.ok && newMode === 'enforce') {
        return { ok: false, reason: 'page-design-integrity-failed', path: file.path, issues: v.issues, error: `This new page would introduce design the site does not have: ${v.issues.map((i) => i.detail).join(' ')}` };
      }
      continue;
    }

    // This page's captured classes, if the capture recorded it.
    const pagePath = draft?.input?.page || draft?.content?.page || null;
    const captured = (profile?.pages || []).find((p) => pagePath && pathKey(p.url) === pathKey(pagePath));
    const verdict = checkEditDesignIntegrity({
      before: existing.content, after: file.content, profile, componentTemplates: templates,
      extraVocabulary: captured ? [...capturedClasses(captured.sections)] : null,
      allowScripts: SCRIPT_PERMITTED_ACTION_TYPES.has(draft?.action_type),
    });
    if (record) {
      await Promise.resolve(record(site.id, {
        kind: 'integrity', actionType: draft?.action_type, draftId: draft?.id ?? null, path: file.path, mode,
        ok: verdict.ok, issues: verdict.issues.map((i) => ({ type: i.type, classes: (i.classes || []).slice(0, 12) })),
      })).catch(() => {});
    }
    if (!verdict.ok) {
      const summary = verdict.issues.map((i) => i.detail).join(' ');
      console.warn(`[page-design-integrity] ${mode} — ${file.path}: ${summary}`);
      if (mode === 'enforce') {
        return {
          ok: false, reason: 'page-design-integrity-failed', path: file.path, issues: verdict.issues,
          error: `This edit would extend this page's design instead of preserving it: ${summary}`,
        };
      }
    }
  }
  return { ok: true };
}
