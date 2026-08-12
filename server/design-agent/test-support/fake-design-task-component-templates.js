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

// The placeholder tokens each action type's stored template MUST contain —
// the same contract design-drift.js's REQUIRED_PLACEHOLDERS enforces on every
// derived template before it can be saved. This stub used to emit a row with
// no tokens at all, which was harmless only because nothing validated the
// agent's output on the way to storage; now that the worker persists what it
// derives, an invalid stub is indistinguishable from a genuinely broken agent
// run and correctly fails the job. Emitting a template that satisfies the real
// contract is what keeps this fixture a stand-in for a SUCCESSFUL run.
const ROW_TOKENS = {
  faq: ['{{QUESTION}}', '{{ANSWER}}'],
  'qa-content': ['{{QUESTION}}', '{{ANSWER}}'],
  'expand-content': ['{{HEADING}}', '{{BODY}}'],
  'internal-links': ['{{URL}}', '{{ANCHOR_TEXT}}'],
};

const actionTypes = actionTypesJson ? JSON.parse(actionTypesJson) : [];
const componentTemplates = {};
for (const actionType of actionTypes) {
  // content-wrapper is the single-slot shape — one {{BODY}}, no repeating row.
  if (actionType === 'content-wrapper') {
    componentTemplates[actionType] = { wrapper: `<div class="stub-prose" data-action="${actionType}">{{BODY}}</div>` };
    continue;
  }
  const tokens = ROW_TOKENS[actionType] || [];
  // data-action echoes the requested type back so tests can still assert the
  // real requested keys travelled through end to end (that's what this stub is
  // for) while the row also satisfies the placeholder contract above.
  componentTemplates[actionType] = {
    wrapper: '<div class="stub-wrap">{{ROWS}}</div>',
    row: `<div class="stub-row" data-action="${actionType}">${tokens.join(' ')}</div>`,
  };
}

console.log('DESIGN_AGENT_RESULT: ' + JSON.stringify({
  status: 'ok',
  detail: `stub: component-templates mode, requested=${JSON.stringify(actionTypes)}`,
  componentTemplates,
}));
process.exitCode = 0;
void mode;
