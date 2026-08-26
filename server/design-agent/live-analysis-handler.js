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
import { projectAllComponentTemplates } from './lib/design-profile.js';

function taggedError(message, stage) {
  const err = new Error(message);
  err.stage = stage;
  return err;
}

export function createLiveDesignAnalysisHandler({
  captureSiteFn = captureSite,
  extractProfileFn = extractDesignProfile,
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
      return { jobId: job.id, componentTemplates: projectAllComponentTemplates(profile, requested) };
    }
    return { jobId: job.id, designProfile: profile };
  };
}
