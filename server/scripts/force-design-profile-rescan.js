#!/usr/bin/env node
// One-time catch-up after a fix to HOW the design profile is derived —
// server/job.js's normal weekly queueDesignProfileRescanForAllSites only
// re-derives a profile once it turns 7 days stale, which is correct for
// routine drift-detection but means a genuine bug fix in the derivation
// itself (a capture-cap change, a correction-pass fix) would otherwise sit
// unapplied to every EXISTING profile for up to a week.
//
// This bypasses the staleness check only (queueDesignProfileRescanForSite's
// `force` option) — every other precondition still applies: a site needs
// `auto_remediation_enabled`, a connected repo, and an existing usable
// profile (a site with none yet is queueDesignAgentDerivationForSite's job,
// unaffected by this). Safe to run more than once: a site with an
// already-queued rescan is skipped, same de-dupe as the routine weekly path.
//
// Usage: node server/scripts/force-design-profile-rescan.js
import 'dotenv/config';
import { queueDesignProfileRescanForAllSites } from '../job.js';

const { queued } = await queueDesignProfileRescanForAllSites({ force: true });
console.log(`Queued ${queued} design-profile rescan(s).`);
process.exit(0);
