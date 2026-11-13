import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { extname, resolve } from 'node:path';

export function runChecks({ candidate, policyDir, files, checks, run = spawnSync, env = process.env }) {
  if (!Array.isArray(checks) || !checks.length) throw new Error('Configure project lint and behavioral tests in checks.json.');
  const sourceFiles = files.filter(file => ['.php', '.js', '.mjs', '.html', '.css', '.sql'].includes(extname(file).toLowerCase()));
  for (const file of sourceFiles) {
    for (const kind of ['lint', 'test']) {
      if (!checks.some(check => check.kind === kind && check.extensions?.includes(extname(file).toLowerCase()))) {
        throw new Error(`No ${kind} check is configured for ${file}. Configure a project-compatible check before pushing.`);
      }
    }
  }
  // Even asset-only changes must pass the configured behavioral suite.
  const selected = checks.filter(check => check.kind === 'test' || sourceFiles.some(file => check.extensions?.includes(extname(file).toLowerCase())));
  if (!selected.some(check => check.kind === 'test')) throw new Error('A behavioral test suite is required; syntax checks alone are insufficient.');
  const evidence = [];
  for (const check of selected) {
    if (!['lint', 'test'].includes(check.kind) || typeof check.name !== 'string' || !Array.isArray(check.command) || !check.command.length || check.command.some(arg => typeof arg !== 'string')) {
      throw new Error('Invalid configured check. Commands must be argument arrays.');
    }
    // Deleted files still need behavioral coverage, but cannot be syntax-linted.
    const targets = check.perFile ? sourceFiles.filter(file => check.extensions.includes(extname(file).toLowerCase()) && existsSync(resolve(candidate, file))) : [null];
    for (const file of targets) {
      const args = check.command.map(arg => arg.replaceAll('{candidate}', candidate).replaceAll('{policy}', policyDir).replaceAll('{file}', file ? resolve(candidate, file) : ''));
      const result = run(args[0], args.slice(1), { cwd: candidate, env, encoding: 'utf8', timeout: check.timeoutMs || 120_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
      const output = `${result.stdout || ''}${result.stderr || ''}`.slice(-16_000);
      const record = { name: check.name, kind: check.kind, file, passed: result.status === 0 && !result.error, output };
      evidence.push(record);
      if (!record.passed) {
        const error = new Error(`Check failed: ${check.name}${file ? ` (${file})` : ''}. ${output || result.error?.message || 'Command failed.'}`);
        error.checks = evidence;
        throw error;
      }
    }
  }
  return evidence;
}

if (process.argv[2] === '--container') {
  try {
    const input = JSON.parse(readFileSync('/input/check-input.json', 'utf8'));
    const result = runChecks({ candidate: '/candidate', policyDir: '/policy', ...input });
    console.log(JSON.stringify({ passed: true, checks: result }));
  } catch (error) {
    console.log(JSON.stringify({ passed: false, reason: error.message, checks: error.checks || [] }));
    process.exitCode = 1;
  }
}
