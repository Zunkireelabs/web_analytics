// SECURITY CHECKS on an agent-written platform repair, run by the independent validation (code-self-repair-task.js)
// BEFORE a PR is opened, on the lines the repair ADDED only. A repair that fails any of them is rejected and the agent
// gets another bounded attempt; nothing here is advisory.
//
//   secret            a credential-shaped string was written into code
//   dangerous-api     new process spawning, dynamic code evaluation, or dumping the whole environment
//   new-network       new outbound network code (a repair of rendering code has no business calling out)
//   weakens-validation  the repair touches a validation threshold, tolerance, or gate switch. Fixing a false failure
//                     is allowed to change HOW something is measured; loosening WHAT counts as a failure is not, so
//                     it is never done autonomously — a person decides that.
const SECRET_PATTERNS = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['API secret key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['hard-coded credential', /(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"\s]{12,}['"]/i],
  ['database URL with credentials', /postgres(?:ql)?:\/\/[^\s'"]+:[^\s'"@]+@(?!localhost)[^\s'"]+/i],
];

const DANGEROUS = [
  ['spawns processes', /\b(?:child_process|execSync|execFileSync|spawnSync|spawn\s*\(|exec\s*\()/],
  ['evaluates dynamic code', /\beval\s*\(|new\s+Function\s*\(/],
  ['reads the whole environment', /Object\.(?:keys|values|entries)\s*\(\s*process\.env\s*\)|JSON\.stringify\s*\(\s*process\.env|\.\.\.\s*process\.env/],
];

const NETWORK = /\b(?:fetch\s*\(\s*['"`]https?:|https?\.request\s*\(|net\.connect\s*\(|new\s+WebSocket\s*\()/;

// A line that sets or reads one of the thresholds/switches that decide what counts as a failure.
const VALIDATION_KNOBS = /\b(?:TOLERANCES|OVERFLOW_TOLERANCE_PX|MIN_TAP_TARGET_PX|MIN_CAPTURE_COVERAGE|RESPONSIVE_GATE_ENFORCE|DESIGN_GATE_MODE|DESIGN_GATE_FAIL_CLOSED|NEWPAGE_RENDER_GATE_ENABLED|h2FontSize|pFontSize|lineHeight|paragraphGap|lineChars)\b/;

function changedLines(patch) {
  const added = []; const removed = [];
  for (const line of String(patch || '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added.push(line.slice(1));
    else if (line.startsWith('-')) removed.push(line.slice(1));
  }
  return { added, removed };
}

const numbersIn = (line) => (line.match(/\d+(?:\.\d+)?/g) || []).map(Number);

/**
 * @param {Array<{path:string, patch:string}>} changed
 * @returns {{ ok:boolean, findings:Array<{path:string, kind:string, detail:string}> }}
 */
export function scanRepairForRisks(changed) {
  const findings = [];
  for (const file of changed || []) {
    const isTest = /\.test\.[cm]?js$/.test(file.path);
    const { added, removed } = changedLines(file.patch);
    for (const line of added) {
      for (const [label, re] of SECRET_PATTERNS) if (re.test(line)) findings.push({ path: file.path, kind: 'secret', detail: `a ${label} was written into the code` });
      if (isTest) continue; // tests may legitimately spawn a browser or hit local fixtures; secrets above still apply
      for (const [label, re] of DANGEROUS) if (re.test(line)) findings.push({ path: file.path, kind: 'dangerous-api', detail: `the repair ${label}` });
      if (NETWORK.test(line)) findings.push({ path: file.path, kind: 'new-network', detail: 'the repair adds outbound network access' });
    }
    // Validation knobs: any edit that changes a number or a switch on a line that mentions one is loosening-or-unknown.
    const knobAdded = added.filter((l) => VALIDATION_KNOBS.test(l));
    const knobRemoved = removed.filter((l) => VALIDATION_KNOBS.test(l));
    if (!isTest && (knobAdded.length || knobRemoved.length)) {
      const before = knobRemoved.flatMap(numbersIn); const after = knobAdded.flatMap(numbersIn);
      const changedNumbers = before.length !== after.length || before.some((n, i) => n !== after[i]);
      const switchChanged = knobAdded.some((l) => /DESIGN_GATE_MODE|RESPONSIVE_GATE_ENFORCE|NEWPAGE_RENDER_GATE_ENABLED|DESIGN_GATE_FAIL_CLOSED/.test(l));
      if (changedNumbers || switchChanged) findings.push({ path: file.path, kind: 'weakens-validation', detail: 'the repair changes a validation threshold or gate switch; that is decided by a person, never autonomously' });
    }
  }
  const seen = new Set();
  const unique = findings.filter((f) => { const k = `${f.path}|${f.kind}|${f.detail}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { ok: unique.length === 0, findings: unique };
}

export function describeFindings(findings) {
  return findings.map((f) => `${f.path}: ${f.kind} — ${f.detail}`).join('\n');
}
