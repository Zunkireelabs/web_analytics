import pLimit from 'p-limit';
import { getSiteById } from '../../store/read.js';
import { daysAgoInTz, todayInTz } from '../../util/dates.js';
import { discoverFromSitemaps, crawlSite } from './site-discovery.js';
import { upsertPageInventoryBatch } from '../../store/page-inventory.js';
import { runAgent } from '../runner.js';
import { listAgentMeta } from '../registry.js';
import { createPageCache } from './fetch-cache.js';
import { computeHealthScore } from './health-score.js';
import { safeMessage } from '../../lib/errors.js';
import {
  createAuditRun, updateAuditRunProgress, completeAuditRun, saveAuditPageFindingsBatch, updateAuditPageFinding,
  getAuditPageFindings,
} from '../../store/audit-runs.js';

// The deterministic, non-LLM bulk fan-out engine for Full Site Audit — a
// sibling to orchestrator.js's runOrchestration (fixed agent list, single
// Promise.all) and agentic-orchestrator.js's LLM tool-calling loop (priced
// per completion round), neither of which fits "run N agents against
// potentially thousands of pages." This file owns crawl-graph-driven,
// concurrency-capped, checkpointed execution instead.
//
// Phase 5 scope: proves the engine end-to-end using the existing
// technical-seo.js (extended in this same phase to accept params.pages) —
// no new specialist agents yet. Every agent passed in `agentIds` must
// already support params.pages the same way; agents that don't are simply
// not valid callers here yet (technical-seo.js is, today).

// Pages per agent.run() call — matches the scale every agent's own internal
// unbounded Promise.all fan-out already assumes safe (selectCandidatePages'
// own default batchSize), so chunking at this size doesn't introduce a new
// per-call concurrency risk beyond what already exists.
const CHUNK_SIZE = 20;
// Conservative default for this first skeleton — deliberately not tuned for
// speed yet. Phase 6 measures real wall-clock/politeness against a live site
// before this (or crawl concurrency) gets raised.
const DEFAULT_CHUNK_CONCURRENCY = 2;
const DEFAULT_MAX_PAGES = 2000;
const IMPRESSIONS_WINDOW_DAYS = 30;

function chunkPages(pages, size) {
  const out = [];
  for (let i = 0; i < pages.length; i += size) out.push(pages.slice(i, i + size));
  return out;
}

// A finding built by findings.js's aggregateSystemicFinding() carries
// evidence.affectedCount/checkedCount — a real "N of M pages checked"
// count that's only correct for the ~20-page chunk that produced it. Every
// other chunk with at least one failing page in its own slice produces the
// *same* finding.id again (the id no longer embeds a page), so naive
// keep-first-occurrence dedup (correct for the genuinely idempotent
// site-wide findings below, which recompute an identical value on every
// chunk since they don't read from params.pages at all — orphaned pages,
// sitemap errors, cross-domain-sitemap) would silently keep only one
// chunk's count instead of the true sitewide total. Since chunkPages()
// slices a deduped page list with no overlap, summing each chunk's local
// affectedCount/checkedCount across all its occurrences is exactly the
// sitewide total.
function isAdditiveFinding(f) {
  return f.evidence?.affectedCount != null && f.evidence?.checkedCount != null;
}

function mergeAdditive(prev, next) {
  const affectedCount = prev.evidence.affectedCount + next.evidence.affectedCount;
  const checkedCount = prev.evidence.checkedCount + next.evidence.checkedCount;
  const priority = affectedCount === checkedCount ? 'high' : 'medium';
  const value = (prev.expectedImpact?.value || 0) + (next.expectedImpact?.value || 0);
  // Whichever occurrence's representative page has the higher real
  // impressions keeps its recommendedAction — a single-page draft is only
  // ever an example fix for a sitewide issue, so the most-trafficked real
  // example is the most useful one to keep.
  const prevRep = prev._repImpressions ?? -Infinity;
  const nextRep = next._repImpressions ?? -Infinity;
  const useNext = nextRep > prevRep;
  return {
    ...prev,
    evidence: {
      ...prev.evidence, ...next.evidence,
      affectedCount, checkedCount,
      samplePages: [...(prev.evidence.samplePages || []), ...(next.evidence.samplePages || [])].slice(0, 5),
    },
    whyItMatters: (prev._whyItMattersTemplate || next._whyItMattersTemplate)
      ?.replace('{n}', affectedCount).replace('{c}', checkedCount) ?? prev.whyItMatters,
    priority,
    recommendedAction: useNext ? next.recommendedAction : prev.recommendedAction,
    expectedImpact: { ...prev.expectedImpact, ...next.expectedImpact, value, label: priority === 'high' ? 'High' : 'Medium' },
    _repImpressions: Math.max(prevRep, nextRep),
  };
}

// Reconciles one chunk's findings against everything already persisted for
// this agent earlier in this same run (`writtenById`, mutated in place so
// the next chunk's reconciliation sees this chunk's result). A brand-new id
// needs an INSERT; a repeat of an additive (aggregated-systemic) id needs
// its summed totals written back over the row already created for it; a
// repeat of anything else (a genuinely idempotent site-wide finding, or —
// in practice impossible, since ids are page/group-unique — an exact
// non-additive repeat) is already persisted and needs nothing further,
// same as the old seenFindingIds keep-first behavior.
function reconcileFindings(writtenById, fresh) {
  const toInsert = [];
  const toUpdate = [];
  for (const f of fresh) {
    const existing = writtenById.get(f.id);
    if (!existing) {
      writtenById.set(f.id, f);
      toInsert.push(f);
    } else if (isAdditiveFinding(f) && isAdditiveFinding(existing)) {
      const merged = mergeAdditive(existing, f);
      writtenById.set(f.id, merged);
      toUpdate.push(merged);
    }
  }
  return { toInsert, toUpdate };
}

// The Phase-5 "AuditContext": one fetch cache shared across every chunk call
// within this one audit run (mirrors fetch-cache.js's createPageCache, just
// promoted from "one runOrchestration() call" to "one whole audit run") — no
// page gets fetched twice even though it's spread across many separate
// agent.run() invocations. The richer per-page shared-observation store
// (so agent B can read what agent A already extracted for a URL) is
// deferred to whichever phase first adds a second page-level agent —
// building that collaboration layer now, with only one real consumer, would
// be speculative.
function createAuditContext() {
  return { pageCache: createPageCache() };
}

export async function runFullSiteAudit(siteId, {
  triggeredBy = 'manual',
  maxPages = DEFAULT_MAX_PAGES,
  maxDepth,
  crawlConcurrency,
  chunkConcurrency = DEFAULT_CHUNK_CONCURRENCY,
  // Every agent here must accept params.pages the same way technical-seo.js
  // does — an agent that doesn't (still most of them) is simply not a valid
  // addition to this default list yet.
  agentIds = ['technical-seo', 'security-headers', 'internal-linking', 'duplicate-content', 'accessibility', 'mobile-usability', 'content-gap'],
  onStarted,
} = {}) {
  const site = await getSiteById(siteId);
  const auditRun = await createAuditRun({ siteId, mode: 'full', triggeredBy });
  onStarted?.(auditRun);

  try {
    const [sitemapUrls, crawledUrls] = await Promise.all([
      discoverFromSitemaps(site).catch((err) => {
        console.error(`[bulk-audit] site ${siteId} sitemap fetch failed:`, err.message);
        return [];
      }),
      crawlSite(site, {
        maxPages,
        ...(maxDepth != null ? { maxDepth } : {}),
        ...(crawlConcurrency != null ? { concurrency: crawlConcurrency } : {}),
      }).catch((err) => {
        console.error(`[bulk-audit] site ${siteId} crawl failed:`, err.message);
        return [];
      }),
    ]);
    const pages = [...new Set([...sitemapUrls, ...crawledUrls])].slice(0, maxPages);

    // Same canonical page ledger runSiteDiscoveryIfDue writes to (job.js) —
    // a Full Site Audit's discovery is real, current data worth keeping,
    // not thrown away after this run.
    await Promise.all([
      upsertPageInventoryBatch(siteId, sitemapUrls, 'sitemap'),
      upsertPageInventoryBatch(siteId, crawledUrls, 'crawl'),
    ]);
    await updateAuditRunProgress(auditRun.id, { pagesDiscovered: pages.length });

    if (!pages.length) {
      await completeAuditRun(auditRun.id, { status: 'completed', agentIdsRun: [] });
      return { auditRunId: auditRun.id, pagesDiscovered: 0, pagesAudited: 0, findingsWritten: 0 };
    }

    const ctx = createAuditContext();
    const chunks = chunkPages(pages, CHUNK_SIZE);
    const limit = pLimit(chunkConcurrency);
    const end = todayInTz(site.timezone);
    const start = daysAgoInTz(site.timezone, IMPRESSIONS_WINDOW_DAYS);

    // Distinct pages that got at least one agent's audit — not a sum across
    // agents. With multiple agents in agentIds, the same page chunk is
    // audited once per agent, so summing pageChunk.length per (agent,chunk)
    // call would let pagesAudited exceed pagesDiscovered (confirmed: 2
    // agents over 20 pages produced pagesAudited=40) — misleading on the
    // report view, which shows "audited" as coverage of "discovered."
    const auditedPages = new Set();
    let findingsWritten = 0;
    // Note: pagesAudited (auditedPages.size) always reads the live shared
    // set, never a stale per-chunk closure value, so it's monotonically
    // non-decreasing in application state — but concurrent chunks' DB
    // writes can resolve out of order, so the persisted
    // audit_runs.pages_audited can flicker backward mid-run, and — contrary
    // to what an earlier version of this comment claimed — is NOT
    // guaranteed to settle on the correct final total on its own (confirmed
    // live: a completed run persisted pages_audited=40 over
    // pages_discovered=20). The authoritative final write after this whole
    // loop finishes (below) is what actually makes the terminal value
    // correct; mid-run flicker itself is still harmless/cosmetic.

    for (const agentId of agentIds) {
      // Everything this agent has had persisted so far in this run, keyed
      // by finding.id — lets each new chunk's reconcileFindings() tell a
      // brand-new finding apart from a repeat of an aggregated-systemic one
      // that needs its counts merged into the row already written for it.
      const writtenById = new Map();
      // Chunks themselves run concurrently (chunkConcurrency), but their DB
      // writes are chained strictly in resolution order — required so a
      // later chunk's UPDATE (merging into an existing row) can never land
      // before the earlier chunk's INSERT that created that row.
      let writeChain = Promise.resolve();
      await Promise.all(chunks.map((pageChunk) => limit(async () => {
        let out;
        try {
          out = await runAgent(agentId, { siteId, start, end, pageCache: ctx.pageCache, params: { pages: pageChunk } }, { persist: false });
        } catch (err) {
          console.error(`[bulk-audit] agent "${agentId}" failed for a chunk in site ${siteId}:`, err.message);
          return;
        }
        pageChunk.forEach((p) => auditedPages.add(p));
        const fresh = out.facts?.findings || [];
        if (fresh.length) {
          writeChain = writeChain.then(async () => {
            const { toInsert, toUpdate } = reconcileFindings(writtenById, fresh);
            if (toInsert.length) {
              await saveAuditPageFindingsBatch(auditRun.id, siteId, agentId, toInsert);
              findingsWritten += toInsert.length;
            }
            await Promise.all(toUpdate.map((f) => updateAuditPageFinding(auditRun.id, f.id, f)));
          });
        }
        await updateAuditRunProgress(auditRun.id, { pagesAudited: auditedPages.size });
      })));
      await writeChain;
    }

    const pagesAudited = auditedPages.size;
    // Authoritative final write — the per-chunk updateAuditRunProgress calls
    // above race under concurrency (chunkConcurrency), so the last DB commit
    // to land isn't guaranteed to be the one with the largest pagesAudited
    // value (confirmed live: a completed run persisted pages_audited=40 over
    // pages_discovered=20). This final write, using the authoritative
    // in-memory auditedPages.size after every chunk has resolved, always
    // wins regardless of write-ordering.
    await updateAuditRunProgress(auditRun.id, { pagesAudited });

    // Real health score for this audit's own findings — same
    // category-weighted computeHealthScore() Command Center uses, applied
    // to a read of what was just persisted rather than an in-memory
    // accumulator, so it reflects exactly what audit_page_findings holds.
    // Best-effort: a scoring failure shouldn't fail an otherwise-successful
    // audit, so this degrades to a null score (same "not computed" honesty
    // as the column's nullable default) rather than throwing. Also null
    // (never a fabricated "100/100 perfect" from zero findings) when every
    // agent invocation actually failed — pagesAudited === 0 here means no
    // agent successfully audited even one page, so there's no real signal
    // to score, not a genuinely clean site.
    const healthScore = pagesAudited === 0 ? null : await (async () => {
      try {
        const rows = await getAuditPageFindings(auditRun.id, { limit: 5000 });
        const findings = rows.map((r) => ({
          id: r.finding_id, agentId: r.agent_id, priority: r.priority,
          evidence: r.evidence, expectedImpact: r.expected_impact,
        }));
        const agents = await listAgentMeta();
        const categoryByAgentId = new Map(agents.map((m) => [m.id, { category: m.category }]));
        return computeHealthScore(findings, new Set(), categoryByAgentId).score;
      } catch (err) {
        console.error(`[bulk-audit] health score computation failed for audit ${auditRun.id}:`, err.message);
        return null;
      }
    })();
    await completeAuditRun(auditRun.id, { status: 'completed', agentIdsRun: agentIds, healthScore });
    return { auditRunId: auditRun.id, pagesDiscovered: pages.length, pagesAudited, findingsWritten, healthScore };
  } catch (err) {
    const { message } = safeMessage(`bulk-audit:${auditRun.id}`, err, 'This audit run could not finish — our team has been notified.');
    await completeAuditRun(auditRun.id, { status: 'failed', errorMessage: message }).catch(() => {});
    throw err;
  }
}

// Fire-and-forget variant for the HTTP trigger (server/routes/site-audit.js):
// resolves with the audit_runs id as soon as that row exists, while the
// actual crawl+audit keeps running in the background — an HTTP request
// shouldn't block for what could be over an hour. If site/DB setup fails
// before the row even exists, that error is real and has nowhere else to
// go, so it's surfaced to the caller; once the row exists, any later
// failure is already recorded on it (runFullSiteAudit's own catch), so it's
// just logged here rather than thrown into a caller with nothing left to do
// with it.
export function startFullSiteAudit(siteId, opts = {}) {
  return new Promise((resolve, reject) => {
    let auditRunId = null;
    runFullSiteAudit(siteId, { ...opts, onStarted: (run) => { auditRunId = run.id; resolve(run.id); } })
      .catch((err) => {
        if (auditRunId == null) reject(err);
        else console.error(`[bulk-audit] background audit ${auditRunId} for site ${siteId} ended with an error (already recorded on the row):`, err.message);
      });
  });
}
