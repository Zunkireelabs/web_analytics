// TEST-ONLY stand-in for design_task.py's "component-templates" mode —
// mirrors fake-design-task.js's contract but also emits a
// componentTemplates payload on the result line, matching what the real
// script reports after extracting the agent's final JSON message (see that
// file's _extract_json_object/_last_agent_message_text). Reads which action
// types were requested from argv[3] (the same JSON-array argv design_task.py
// itself expects in this mode) and echoes back a trivially valid
// {wrapper, row} template per requested type, so tests can assert the
// handler propagated the real requested keys through end to end. argv[4] is
// the same optional agent_fix_memory-lessons JSON design_task.py itself
// reads — logged out (when asked) so tests can assert openhands-handler.js
// actually looked memory up and passed it through.
import fs from 'node:fs';
import crypto from 'node:crypto';

const [, , workspaceDir, mode, actionTypesJson, lessonsJson] = process.argv;
const containerId = `fake-container-${crypto.randomUUID()}`;

if (workspaceDir) {
  if (process.env.DESIGN_AGENT_TEST_WORKSPACE_LOG) fs.writeFileSync(process.env.DESIGN_AGENT_TEST_WORKSPACE_LOG, workspaceDir);
}
console.log(`DESIGN_AGENT_CONTAINER: ${JSON.stringify({ container_id: containerId })}`);
if (process.env.DESIGN_AGENT_TEST_CONTAINER_LOG) fs.writeFileSync(process.env.DESIGN_AGENT_TEST_CONTAINER_LOG, containerId);
if (process.env.DESIGN_AGENT_TEST_LESSONS_LOG) fs.writeFileSync(process.env.DESIGN_AGENT_TEST_LESSONS_LOG, lessonsJson || '');

const actionTypes = actionTypesJson ? JSON.parse(actionTypesJson) : [];
const componentTemplates = {};
for (const actionType of actionTypes) {
  componentTemplates[actionType] = { wrapper: '<div class="stub-wrap">{{ROWS}}</div>', row: `<div class="stub-row">${actionType}</div>` };
}

console.log('DESIGN_AGENT_RESULT: ' + JSON.stringify({
  status: 'ok',
  detail: `stub: component-templates mode, requested=${JSON.stringify(actionTypes)}`,
  componentTemplates,
}));
process.exitCode = 0;
void mode;
