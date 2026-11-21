import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanRepairForRisks, describeFindings } from './security-checks.js';

const patch = (...lines) => lines.join('\n');
const file = (path, p) => ({ path, patch: p });

test('a plain, safe repair has no findings', () => {
  const r = scanRepairForRisks([file('server/a.js', patch('--- a', '+++ b', '-const x = 1;', '+const x = 2;'))]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, []);
});

test('credential-shaped strings are found, in source and in tests', () => {
  for (const line of [
    "+const k = 'sk-abcdefghijklmnopqrstuvwxyz012345';",
    '+const t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789ab";',
    '+// AKIAABCDEFGHIJKLMNOP',
    '+-----BEGIN RSA PRIVATE KEY-----',
    "+const password = 'correct-horse-battery-staple';",
    "+const url = 'postgres://app:hunter2hunter2@db.prod.example.com/app';",
  ]) {
    for (const path of ['server/a.js', 'server/a.test.js']) {
      const r = scanRepairForRisks([file(path, line)]);
      assert.equal(r.ok, false, `${path}: ${line}`);
      assert.equal(r.findings[0].kind, 'secret');
    }
  }
});

test('a localhost database URL (the test URL) is not a leaked credential', () => {
  assert.equal(scanRepairForRisks([file('server/a.js', "+const u = 'postgres://test:test@localhost:5432/test';")]).ok, true);
});

test('only ADDED lines count: removing a dangerous call is fine', () => {
  assert.equal(scanRepairForRisks([file('server/a.js', patch('-eval(code);', '+run(code);'))]).ok, true);
});

test('dangerous APIs in source are findings; the same in a test file are not', () => {
  for (const line of ['+const { execSync } = require(x);', '+eval(input);', '+const f = new Function("return 1");', '+const all = Object.keys(process.env);', '+const e = { ...process.env };']) {
    const r = scanRepairForRisks([file('server/a.js', line)]);
    assert.equal(r.findings[0]?.kind, 'dangerous-api', line);
    assert.equal(scanRepairForRisks([file('server/a.test.js', line)]).ok, true, `test file: ${line}`);
  }
});

test('new outbound network code is a finding', () => {
  assert.equal(scanRepairForRisks([file('server/a.js', "+await fetch('https://evil.example/x');")]).findings[0].kind, 'new-network');
});

test('changing a validation threshold is NEVER autonomous, in either direction', () => {
  const up = scanRepairForRisks([file('server/x.js', patch('-  h2FontSize: 0.15, pFontSize: 0.10,', '+  h2FontSize: 0.5, pFontSize: 0.10,'))]);
  const down = scanRepairForRisks([file('server/x.js', patch('-const OVERFLOW_TOLERANCE_PX = 2;', '+const OVERFLOW_TOLERANCE_PX = 1;'))]);
  assert.equal(up.findings[0].kind, 'weakens-validation');
  assert.equal(down.findings[0].kind, 'weakens-validation');
});

test('switching a gate to log-only or off is a finding', () => {
  for (const line of ["+process.env.DESIGN_GATE_MODE = 'log';", '+if (process.env.RESPONSIVE_GATE_ENFORCE !== "true") return;']) {
    assert.equal(scanRepairForRisks([file('server/x.js', line)]).findings[0].kind, 'weakens-validation', line);
  }
});

test('a repair that touches a knob line WITHOUT changing a number or switch is allowed (a measurement fix, not a loosening)', () => {
  const r = scanRepairForRisks([file('server/x.js', patch('-  if (off(ref.lineChars, draft.lineChars, tol.lineChars)) add();', '+  if (off(ref.lineChars, draft.lineChars, tol.lineChars) && ok) add();'))]);
  assert.equal(r.ok, true);
});

test('findings are de-duplicated and described one per line', () => {
  const r = scanRepairForRisks([file('server/a.js', patch("+const k = 'sk-abcdefghijklmnopqrstuvwxyz012345';", "+const j = 'sk-abcdefghijklmnopqrstuvwxyz012345';"))]);
  assert.equal(r.findings.length, 1);
  assert.match(describeFindings(r.findings), /^server\/a\.js: secret — /);
});

test('no files, or a missing patch, is simply clean', () => {
  assert.equal(scanRepairForRisks([]).ok, true);
  assert.equal(scanRepairForRisks(null).ok, true);
  assert.equal(scanRepairForRisks([{ path: 'server/a.js' }]).ok, true);
});
