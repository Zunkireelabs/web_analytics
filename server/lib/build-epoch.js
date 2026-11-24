// WHEN THIS BUILD STARTED. A deploy or a restart is the moment the platform's own code may have changed, so it is the signal that "this failed before" may no longer be true.
//
// Used by the capability-gap logic: a failed draft from before this build says nothing about what the current code does, so it does not count toward a gap, and a
// capability-gap block made before this build is lifted when the gap does not show again (action-center-reconciler.js). A defect that is really still there re-forms
// the gap after a few new failures and blocks again, once per build, so nothing retries on a timer.
export const BUILD_STARTED_AT = new Date();
