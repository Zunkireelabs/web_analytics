// The live-site replacement for openhands-handler.js's OpenHands/Docker
// analysis path. Same job interface worker.js's processOneJob expects
// (async handler(job) -> outcome), same job kind/mode ('design_generate',
// params.mode 'design-profile' | 'component-templates') and the exact same
// consumer contract (outcome.designProfile / outcome.componentTemplates) —
// so this drops in as worker.js's handler with no change to job creation,
// queueing, retry, or persistence anywhere else in the platform. What's
// gone is the sibling Docker container and the OpenHands agent loop: this
// is a plain async function that loads the site's real live pages in a
// headless browser and asks the model to classify/synthesize what it sees,
// one bounded call, no sandbox to crash.
import { captureSite } from './live-analysis/capture.js';
import { segmentSite } from './live-analysis/segment.js';
import { extractDesignProfile } from './live-analysis/profile-extract.js';
import { composeGeneratedExpandLayout } from './live-analysis/compose-expand-layout.js';
import { projectAllComponentTemplates } from './lib/design-profile.js';

function taggedError(message, stage) {
  const err = new Error(message);
  err.stage = stage;
  return err;
}

export function createLiveDesignAnalysisHandler({
  captureSiteFn = captureSite,
  extractProfileFn = extractDesignProfile,
  composeExpandLayoutFn = composeGeneratedExpandLayout,
} = {}) {
  return async function liveDesignAnalysisHandler(job) {
    const pageUrl = job.params?.pageUrl;
    if (!pageUrl) throw taggedError('No target page URL was provided for this design analysis job.', 'input_validation');

    const capture = await captureSiteFn(pageUrl).catch((err) => {
      throw taggedError(`Could not load the live site to analyze its design: ${err.message}`, 'live_capture');
    });
    if (!capture.pages?.length) {
      throw taggedError('Could not load any page of the live site — it may be unreachable or blocking automated requests.', 'live_capture');
    }

    const segmented = segmentSite(capture);
    const profile = await extractProfileFn(segmented, { siteId: job.site_id }).catch((err) => {
      throw taggedError(`Design profile extraction failed: ${err.message}`, 'result_validation');
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
