// The live-site replacement for openhands-handler.js's OpenHands/Docker
// analysis path. Same job interface worker.js's processOneJob expects
// (async handler(job) -> outcome), same job kind ('design_generate',
// params.mode 'design-profile' | 'component-templates' | 'consistency-scan')
// and the exact same consumer contract (outcome.designProfile /
// outcome.componentTemplates / outcome.consistencyFindings) — so this drops
// in as worker.js's handler with no change to job creation, queueing,
// retry, or persistence anywhere else in the platform. What's
// gone is the sibling Docker container and the OpenHands agent loop: this
// is a plain async function that loads the site's real live pages in a
// headless browser and asks the model to classify/synthesize what it sees,
// one bounded call, no sandbox to crash.
//
// design-profile mode always pays for the Playwright capture (it's the only
// way to see whether the live site changed) but only pays for the LLM
// resynthesis when that fresh capture shows real drift from the stored
// profile — outcome.skippedProfileDerivation tells worker.js to persist
// only a refreshed lastCheckedAt instead of a full re-derivation.
import { captureSite } from './live-analysis/capture.js';
import { segmentSite } from './live-analysis/segment.js';
import { extractDesignProfile } from './live-analysis/profile-extract.js';
import { compareSectionsToProfile } from './live-analysis/consistency-check.js';
import { summarizeResponsive, detectResponsiveIssues } from './live-analysis/responsive-analysis.js';
import { composeGeneratedExpandLayout } from './live-analysis/compose-expand-layout.js';
import { projectAllComponentTemplates } from './lib/design-profile.js';
import { getSiteById } from '../store/read.js';
import { safeMessage } from '../lib/errors.js';

function taggedError(message, stage) {
  const err = new Error(message);
  err.stage = stage;
  return err;
}

export function createLiveDesignAnalysisHandler({
  captureSiteFn = captureSite,
  extractProfileFn = extractDesignProfile,
  composeExpandLayoutFn = composeGeneratedExpandLayout,
  getSiteByIdFn = getSiteById,
} = {}) {
  return async function liveDesignAnalysisHandler(job) {
    const pageUrl = job.params?.pageUrl;
    if (!pageUrl) throw taggedError('No target page URL was provided for this design analysis job.', 'input_validation');

    // Fetched once, up front, so its known page inventory (url_file_map.pages
    // — populated at onboarding, independent of anything this crawl finds
    // linked from the homepage) can be handed to the capture as extra
    // candidates. Reused below instead of re-fetching per mode branch.
    //
    // This closes a real discovery gap, not a hypothetical one: confirmed on
    // chayceproperties.com, whose /faq/ and /news/ pages are real, correctly
    // classifiable pages that simply aren't linked from the homepage at
    // all — no depth of homepage-only crawling can ever find a page nothing
    // on the homepage points to.
    const site = await getSiteByIdFn(job.site_id).catch(() => null);
    const knownUrls = Object.keys(site?.url_file_map?.pages || {})
      .map((path) => { try { return new URL(path, pageUrl).href; } catch { return null; } })
      .filter(Boolean);

    const capture = await captureSiteFn(pageUrl, { knownUrls }).catch((err) => {
      const { message } = safeMessage('live-analysis-handler.capture', err, 'Could not load the live site to analyze its design');
      throw taggedError(message, 'live_capture');
    });
    if (!capture.pages?.length) {
      throw taggedError('Could not load any page of the live site — it may be unreachable or blocking automated requests.', 'live_capture');
    }

    const segmented = segmentSite(capture);

    // Whole-site consistency scan (agents/lib/design-consistency.js): a
    // fresh capture compared against the site's ALREADY-STORED profile —
    // deliberately never re-derives a new profile here (that is a separate,
    // much more expensive LLM-synthesis job, design-profile mode above/
    // below). A site with no usable stored profile has nothing to compare
    // against; queueConsistencyScanForSite (job.js) already guards this
    // before ever creating the job, so reaching here without one is an
    // input-validation fault, not a normal "nothing to do" outcome.
    if (job.params?.mode === 'consistency-scan') {
      const site = await getSiteByIdFn(job.site_id);
      const storedProfile = site?.url_file_map?.siteRoot?.designProfile;
      if (!storedProfile) throw taggedError('No stored design profile to compare against — derive one first.', 'input_validation');
      // Class-level drift (does this section look like the rest of the site)
      // and measured responsive defects (does this page actually work at
      // 390px) are both "this page is inconsistent with what it should be",
      // they are just evidenced differently — so they travel as one findings
      // list through one persistence path rather than the responsive half
      // growing a second, parallel lifecycle.
      const findings = [
        ...compareSectionsToProfile(storedProfile, segmented, { responsive: capture.responsive }),
        ...detectResponsiveIssues(capture.responsive),
      ];
      return { jobId: job.id, consistencyFindings: findings, pagesScanned: segmented.length };
    }

    // design-profile mode: before paying for the expensive LLM re-derivation,
    // check whether the fresh capture actually shows any meaningful drift
    // from the site's currently-stored profile. A brand-new site (no stored
    // profile yet) has nothing to compare against and always gets the full
    // derivation. This reuses compareSectionsToProfile — the exact same
    // "does this section still look like the rest of the site" primitive
    // consistency-scan mode already runs, just pointed at the fresh capture
    // instead of a routed-findings list — so the weekly Playwright visit
    // still happens every week (that's the only way to detect drift at
    // all), but the LLM call only fires when it found something real.
    if (job.params?.mode === 'design-profile') {
      const site = await getSiteByIdFn(job.site_id);
      const storedProfile = site?.url_file_map?.siteRoot?.designProfile;
      if (storedProfile) {
        const drift = compareSectionsToProfile(storedProfile, segmented, { responsive: capture.responsive });
        if (!drift.length) {
          console.log(`[design-agent] site ${job.site_id}: design-profile rescan found no structural drift vs. the stored profile — skipping LLM re-derivation, refreshing lastCheckedAt only.`);
          return { jobId: job.id, designProfile: storedProfile, skippedProfileDerivation: true };
        }
        console.log(`[design-agent] site ${job.site_id}: design-profile rescan found ${drift.length} drift finding(s) (${[...new Set(drift.map((f) => f.id))].join(', ')}) — running full LLM re-derivation.`);
      } else {
        console.log(`[design-agent] site ${job.site_id}: no stored design profile yet — running full LLM derivation.`);
      }
    }

    const profile = await extractProfileFn(segmented, {
      siteId: job.site_id,
      responsiveMeasured: summarizeResponsive(capture.responsive),
    }).catch((err) => {
      const { message } = safeMessage('live-analysis-handler.extractProfile', err, 'Design profile extraction failed');
      throw taggedError(message, 'result_validation');
    });

    if (job.params?.mode === 'component-templates') {
      const requested = (job.params.componentKeys || []).filter((k) => k !== '__design-profile__');
      const componentTemplates = projectAllComponentTemplates(profile, requested);

      // A generated layout is a strict upgrade over the plain projection, not
      // a different concept — same {wrapper,row} shape, same persistence
      // slot, same downstream verification. It replaces the projected
      // entry in-place only when validateGeneratedExpandLayout confirms it
      // uses no class outside this site's own real vocabulary; any failure
      // (non-Tailwind site, no usable profile, model output that didn't
      // validate even after one retry) is swallowed inside
      // composeGeneratedExpandLayout, and the plain projection above ships
      // exactly as it always has.
      if (requested.includes('expand-content')) {
        const generated = await composeExpandLayoutFn(profile, { siteId: job.site_id }).catch((err) => {
          console.warn(`[design-agent] site ${job.site_id}: expand-content layout generation threw — keeping the plain projected template (${err.message}).`);
          return null;
        });
        // `source` is inert to every existing reader (design-drift.js's
        // validatePlaceholders/stampTemplateVerification and marker-merge.js's
        // renderers only ever read .wrapper/.row) — added purely so
        // design-review.js can tell a reviewer this template's markup
        // structure was composed by the model, not just this site's own
        // observed pattern reused verbatim.
        if (generated) componentTemplates['expand-content'] = { ...generated, source: 'generated-layout' };
      }

      return { jobId: job.id, componentTemplates };
    }
    return { jobId: job.id, designProfile: profile };
  };
}
