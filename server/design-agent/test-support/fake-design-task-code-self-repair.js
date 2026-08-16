// TEST-ONLY stand-in for design_task.py's "code-self-repair" mode — proves
// createCodeSelfRepairHandler's workspaceSource/buildArgs/mapResult wiring
// end to end without a real Docker/OpenHands run. Mirrors
// fake-design-task-component-templates.js's contract for the other modes.
import fs from 'node:fs';
import crypto from 'node:crypto';

const [, , workspaceDir, mode, payloadJson] = process.argv;
const containerId = `fake-container-${crypto.randomUUID()}`;
const payload = payloadJson ? JSON.parse(payloadJson) : {};

if (workspaceDir && process.env.DESIGN_AGENT_TEST_WORKSPACE_LOG) fs.writeFileSync(process.env.DESIGN_AGENT_TEST_WORKSPACE_LOG, workspaceDir);
console.log(`DESIGN_AGENT_CONTAINER: ${JSON.stringify({ container_id: containerId })}`);
if (process.env.DESIGN_AGENT_TEST_CONTAINER_LOG) fs.writeFileSync(process.env.DESIGN_AGENT_TEST_CONTAINER_LOG, containerId);
if (process.env.DESIGN_AGENT_TEST_PAYLOAD_LOG) fs.writeFileSync(process.env.DESIGN_AGENT_TEST_PAYLOAD_LOG, payloadJson || '');

console.log('DESIGN_AGENT_RESULT: ' + JSON.stringify({
  status: 'ok',
  detail: `stub: code-self-repair mode for ${payload.generatorId}:${payload.reason}`,
  rootCause: 'stub root cause',
  summary: 'stub summary',
  testsPassed: true,
  testOutput: '$ node --test stub.test.js\n# pass 1',
  patch: 'diff --git a/server/stub.js b/server/stub.js\n--- a/server/stub.js\n+++ b/server/stub.js\n@@ -1 +1 @@\n-old\n+new\n',
  filesChanged: [{ path: 'server/stub.js', newContent: 'new\n' }],
}));
process.exitCode = 0;
void mode;
