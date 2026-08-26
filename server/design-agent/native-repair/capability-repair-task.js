// Ports design_task.py's build_capability_repair_task +
// _validate_capability_repair into the native (no Docker) engine. Payload
// shape is UNCHANGED — server/scripts/repair-template-capability.js's
// `derivedTaskPayload` (generatorId, valueKey, templatePath, templateSource,
// dataFilePath, dataFileSource, conventionExamples) needs no changes at all.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { snapshotFiles, diffSnapshots, runSandboxCommand, resolveScopedPath, listSandboxFiles } from './sandbox.js';

// Same prompt content as design_task.py's build_capability_repair_task —
// same grounding rule (only real evidence the payload supplies, never
// invented), same minimal-slot convention when the site has no existing
// example, same explicit two-file scope limit.
export function buildCapabilityRepairPrompt(payload) {
  const {
    generatorId = '(unknown generator)', valueKey = '(unknown value key)',
    templatePath = '(unknown template path)', templateSource = '',
    dataFilePath = '(unknown data file path)', dataFileSource = '',
    conventionExamples = [],
  } = payload || {};

  const lines = [
    'This directory is a real, complete checkout of a client website\'s actual source repository. '
      + 'This is a real code-editing task: use read_file/write_file to edit files, and run_command for the allowed commands.\n',
    `A recommendation of type "${generatorId}" is blocked for every page rendered from ${dataFilePath} via the template `
      + `${templatePath}: there is no existing place on that page for AI-generated content of this kind to render, and no `
      + 'sibling route in this site\'s own configuration already solved it. Your job is to add the SMALLEST new capability '
      + `that lets it render — a new field on the relevant data entries, and a rendering slot in ${templatePath} that displays it.\n`,
    `The real current content of ${templatePath}:\n---\n${templateSource}\n---\n`,
    `The real current content of ${dataFilePath}:\n---\n${dataFileSource}\n---\n`,
  ];

  if (conventionExamples.length) {
    lines.push('This site already expresses AI-managed content elsewhere using this exact convention — match it precisely, do not invent a different shape:\n');
    for (const ex of conventionExamples) lines.push(`From ${ex.path}:\n---\n${ex.snippet}\n---\n`);
  } else {
    lines.push(
      'This site has no existing example of this convention anywhere in the repository. Use this exact, minimal shape '
      + '(a Nunjucks comment naming this generator, then an if-guard, then the output) so it stays machine-readable by this platform later:\n'
      + `{# AI-managed: server/generators/${generatorId}.js #}\n`
      + `{% if <base>.${valueKey} %}\n`
      + `{{ <base>.${valueKey} | safe }}\n`
      + '{% endif %}\n'
      + '— replace <base> with whatever variable this template already uses to reference the current data entry (read the template to find it; never guess a name that doesn\'t appear in it).\n',
    );
  }

  lines.push(
    `Add the field as "${valueKey}" (this exact name — it is what the platform's own generator writes into later) to the `
    + 'data file, matching its existing structure and quoting style exactly. Do NOT populate it with placeholder content on '
    + 'every entry — the field is meant to start absent/empty and be filled in later; the template\'s own if-guard already '
    + 'handles that safely. Only add it to the ONE entry you use to prove the change works end-to-end, if you need a concrete example.\n',
  );
  lines.push(
    `Only touch ${templatePath} and ${dataFilePath} — write_file will refuse anything else. Do not add speculative error `
    + 'handling, comments, or abstractions beyond what this requires.\n',
  );
  lines.push(
    'When you are done, respond with ONLY a JSON object (no prose, no code fence) shaped exactly like:\n'
    + '{"summary": "<one sentence, what you added>", "fieldName": "<the exact field name you added>", "baseVar": "<the exact template variable you guarded on>"}',
  );
  return lines.join('\n');
}

// Same package-manager detection as design_task.py's _detect_build_command/
// _detect_install_command — never assumes npm, never guesses a fallback
// when no "build" script is declared.
export async function detectBuildCommand(sandbox) {
  const pkgPath = resolveScopedPath(sandbox, 'package.json');
  if (!existsSync(pkgPath)) return null;
  let pkg;
  try {
    pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  } catch {
    return null;
  }
  if (!pkg?.scripts?.build) return null;
  if (existsSync(join(sandbox.root, 'pnpm-lock.yaml'))) return { install: ['pnpm', 'install', '--frozen-lockfile'], build: ['pnpm', 'run', 'build'] };
  if (existsSync(join(sandbox.root, 'yarn.lock'))) return { install: ['yarn', 'install', '--frozen-lockfile'], build: ['yarn', 'build'] };
  return { install: ['npm', 'ci'], build: ['npm', 'run', 'build'] };
}

// The independent validation gate — never trusts the agent's own claim.
// Mirrors design_task.py's _validate_capability_repair, but the "only the
// two allowlisted files changed" check here is a REAL second gate, not a
// redundant one: `before` must cover the WHOLE repo tree (see
// native-repair-handler.js), not just the two allowed paths, so a change
// anywhere else is actually visible to diffSnapshots — catching a bug in
// the tool-level allowlist (agent-loop.js's write_file check) rather than
// only ever re-confirming what that check already enforced.
export async function validateCapabilityRepair(sandbox, { templatePath, dataFilePath }, before) {
  const currentFiles = await listSandboxFiles(sandbox, '.');
  const after = await snapshotFiles(sandbox, [...new Set([...Object.keys(before), ...currentFiles])]);
  const changed = diffSnapshots(before, after);
  if (!changed.length) return { ok: false, output: 'Agent made no file changes.' };

  const allowed = new Set([templatePath, dataFilePath].filter(Boolean));
  const unexpected = changed.filter((c) => !allowed.has(c.path));
  if (unexpected.length) {
    return { ok: false, output: `Agent touched file(s) outside the intended scope: ${unexpected.map((c) => c.path).join(', ')}` };
  }

  const dataEdit = changed.find((c) => c.path === dataFilePath);
  if (dataEdit) {
    if (dataFilePath.endsWith('.js') || dataFilePath.endsWith('.mjs')) {
      const check = await runSandboxCommand(sandbox, 'node', ['--check', dataFilePath], { allowlist: ['node'] });
      if (!check.ok) return { ok: false, output: `node --check failed for ${dataFilePath}:\n${check.output}` };
    } else if (dataFilePath.endsWith('.json')) {
      try {
        JSON.parse(dataEdit.newContent);
      } catch (err) {
        return { ok: false, output: `${dataFilePath} is not valid JSON after the change: ${err.message}` };
      }
    }
  }

  const commands = await detectBuildCommand(sandbox);
  if (!commands) return { ok: false, output: 'Could not find a "build" script in this repo\'s package.json — refusing to guess a build command.' };

  const [installCmd, ...installArgs] = commands.install;
  const install = await runSandboxCommand(sandbox, installCmd, installArgs, { allowlist: [installCmd], timeoutMs: 600_000 });
  if (!install.ok) return { ok: false, output: `$ ${commands.install.join(' ')}\n${install.output}` };

  const [buildCmd, ...buildArgs] = commands.build;
  const build = await runSandboxCommand(sandbox, buildCmd, buildArgs, { allowlist: [buildCmd], timeoutMs: 300_000 });
  const output = `$ ${commands.install.join(' ')}\n(installed OK)\n\n$ ${commands.build.join(' ')}\n${build.output}`;
  return { ok: build.ok, output, filesChanged: changed, patch: changed.map((c) => c.patch).join('\n\n') };
}
