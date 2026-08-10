#!/usr/bin/env node
// TEST-ONLY stand-in for the real `docker` binary — openhands-handler.js's
// `dockerBin` is injectable specifically so tests can point the backstop
// cleanup (`docker rm -f <id>`) at this instead of a real Docker daemon.
// No real container is ever touched by openhands-handler.test.js.
//
// If DESIGN_AGENT_TEST_DOCKER_LOG is set, appends every invocation's args
// (one line, space-joined) so a test can assert exactly which container id
// the backstop tried to remove, and how many times.
import fs from 'node:fs';

const args = process.argv.slice(2);
if (process.env.DESIGN_AGENT_TEST_DOCKER_LOG) {
  fs.appendFileSync(process.env.DESIGN_AGENT_TEST_DOCKER_LOG, args.join(' ') + '\n');
}
process.exitCode = 0;
