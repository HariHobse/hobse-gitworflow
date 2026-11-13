import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { validateRequest } from './protocol.mjs';
import { runChecks } from './check-runner.mjs';

const SHA = /^[a-f0-9]{40}$/;
const LEDGER = '.hobse-qa/state.json';
const protectedPath = file => /^(?:\.git(?:\/|$)|\.github(?:\/|$)|\.hobse-qa(?:\/|$))/.test(file);
export class Blocked extends Error {
  constructor(message, extra = {}) { super(message); Object.assign(this, extra); }
}
const hash = data => createHash('sha256').update(data).digest('hex');
function within(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
function trustedFile(root, path) {
  if (typeof path !== 'string' || !within(root, resolve(root, path))) throw new Blocked('Invalid reviewed patch path.');
  const file = realpathSync(resolve(root, path));
  if (!within(realpathSync(root), file)) throw new Blocked('Reviewed patches must stay inside the trusted policy directory.');
  return file;
}
function safeEnv(extra = {}) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'LANG']) if (process.env[key]) env[key] = process.env[key];
  return { ...env, GIT_TERMINAL_PROMPT: '0', ...extra };
}

export async function executeOperation({ repo, policyDir, request, remote = 'origin', token, runId = null, runAttempt = 1, checkMode = 'docker', gitBin = process.env.GIT_BIN || 'git', beforePush, checkRunner }) {
  validateRequest(request);
  repo = resolve(repo); policyDir = resolve(policyDir);
  const result = { schemaVersion: 1, protocol: request.protocol, requestId: request.requestId, taskId: request.taskId, action: request.action, requestedBy: request.requestedBy,
    runId, runAttempt, requestedQa: request.expectedQa, outcome: 'blocked', reason: null, commits: [], files: [], checks: [], diff: '', qaUpdated: false, startedAt: new Date().toISOString() };
  const tempRoot = mkdtempSync(join(tmpdir(), 'hobse-qa-op-'));
  const candidate = join(tempRoot, 'candidate');
  const authEnv = token ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` } : {};
  const git = (args, cwd = repo, { network = false, allowFailure = false, raw = false, input } = {}) => {
    try {
      return execFileSync(gitBin, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', ...args], { cwd, env: safeEnv(network ? authEnv : {}), input, encoding: raw ? undefined : 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 20 * 1024 * 1024, windowsHide: true });
    } catch (error) {
      if (allowFailure) return null;
      const message = String(error.stderr || error.message).slice(-8000);
      throw new Blocked(message.replace(/AUTHORIZATION[^\r\n]*/gi, 'AUTHORIZATION [redacted]'));
    }
  };
  const cat = (ref, file) => git(['show', `${ref}:${file}`], repo, { allowFailure: true });
  const stateAt = ref => {
    const text = cat(ref, LEDGER);
    if (text === null) return { schemaVersion: 1, tasks: {}, requests: {} };
    try {
      const state = JSON.parse(text);
      if (state.schemaVersion !== 1 || !state.tasks || !state.requests) throw new Error();
      return state;
    } catch { throw new Blocked('QA has an invalid operation ledger. Owner review is required.'); }
  };
  const changes = (from, to, cwd = candidate) => git(['diff', '--name-only', '-z', from, to], cwd).split('\0').filter(Boolean);
  let worktreeAdded = false;
  let pushAttempted = false;
  try {
    const config = JSON.parse(readFileSync(join(policyDir, 'checks.json'), 'utf8'));
    const { devBranch, qaBranch } = config;
    if (typeof devBranch !== 'string' || typeof qaBranch !== 'string' || !/^[A-Za-z0-9_/-]+$/.test(devBranch) || !/^[A-Za-z0-9_/-]+$/.test(qaBranch) || devBranch === qaBranch || /\.\.|\/\//.test(devBranch + qaBranch)) throw new Blocked('Invalid DEV/QA branch configuration.');
    git(['fetch', '--no-tags', remote, `+refs/heads/${devBranch}:refs/remotes/${remote}/${devBranch}`, `+refs/heads/${qaBranch}:refs/remotes/${remote}/${qaBranch}`], repo, { network: true });
    const qaRef = `refs/remotes/${remote}/${qaBranch}`;
    const devRef = `refs/remotes/${remote}/${devBranch}`;
    const base = git(['rev-parse', qaRef]).trim();
    result.qaBefore = base;
    if (base !== request.expectedQa) throw new Blocked('QA advanced after this request was submitted. Refresh and submit a new request.');
    const state = stateAt(base);
    if (state.requests[request.requestId]) {
      result.outcome = 'already_processed'; result.reason = 'This request was already recorded in QA.'; return result;
    }
    const task = state.tasks[request.taskId] || { entries: [], status: 'not_promoted' };
    const active = task.entries.filter(entry => entry.active);
    for (const entry of active) {
      if (!SHA.test(entry.source) || !SHA.test(entry.qaCommit) || git(['merge-base', '--is-ancestor', entry.qaCommit, base], repo, { allowFailure: true }) === null) {
        throw new Blocked('The active task ledger no longer matches QA history. Owner review is required.');
      }
    }
    let planned = [];
    if (request.action === 'promote') {
      const manifestPath = join(policyDir, 'tasks', `${request.taskId}.json`);
      if (!existsSync(manifestPath)) throw new Blocked('A reviewed task-only patch or reviewed task-only commit manifest is needed. Commit messages alone cannot establish line ownership.');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.taskId !== request.taskId || !Array.isArray(manifest.commits) || !manifest.commits.length) throw new Blocked('Invalid task review manifest.');
      const order = git(['rev-list', '--topo-order', '--reverse', '--no-merges', devRef]).trim().split('\n').filter(Boolean);
      const approved = new Map();
      for (const entry of manifest.commits) {
        if (!SHA.test(entry.source) || approved.has(entry.source) || !order.includes(entry.source) ||
          entry.review?.taskOnly !== true || typeof entry.review?.reviewedBy !== 'string' || !entry.review.reviewedBy.trim()) throw new Blocked('Every source commit needs an exact DEV SHA and an explicit task-only ownership review.');
        if (!['commit', 'patch'].includes(entry.mode)) throw new Blocked('Each reviewed source needs commit or patch mode.');
        approved.set(entry.source, entry);
      }
      // Discover exact Task IDs only; HOB-11 never matches HOB-111.
      for (const source of order) {
        const message = git(['show', '-s', '--format=%B', source]);
        const prefix = message.trim().match(/^([A-Za-z][A-Za-z0-9]*-\d+)(?=$|[\s:])/);
        const trailers = [...message.matchAll(/^Task-ID:\s*([A-Za-z][A-Za-z0-9]*-\d+)\s*$/gmi)];
        const belongs = prefix?.[1].toUpperCase() === request.taskId || trailers.some(match => match[1].toUpperCase() === request.taskId);
        if (belongs && !approved.has(source)) throw new Blocked('A task source commit has no task-only review. Supply its reviewed commit or patch before promotion.', { sourceCommit: source });
      }
      planned = order.filter(source => approved.has(source)).map(source => approved.get(source)).filter(entry => !active.some(item => item.source === entry.source));
      if (!planned.length) { result.outcome = 'already_in_qa'; result.reason = 'Already in QA.'; result.commits = active; return result; }
      for (const entry of planned) {
        if (!task.entries.some(item => item.source === entry.source)) {
          const ancestor = git(['merge-base', '--is-ancestor', entry.source, base], repo, { allowFailure: true }) !== null;
          const legacyPick = git(['log', '-1', '--format=%H', '--fixed-strings', `--grep=(cherry picked from commit ${entry.source})`, base]).trim();
          if (ancestor || legacyPick) throw new Blocked('Rollback unavailable: source changes exist in legacy QA history without a reliable active ledger. An owner-reviewed baseline is required.', { sourceCommit: entry.source });
        }
      }
    } else {
      if (!active.length) throw new Blocked('Rollback unavailable: no reliably mapped active QA commits exist for this task. Historical workflow titles are insufficient.');
      planned = request.selectedCommit ? active.filter(entry => entry.qaCommit === request.selectedCommit) : [...active];
      if (!planned.length) throw new Blocked('That exact commit is no longer active for this task. Refresh History and select an active commit.');
      const qaOrder = git(['rev-list', '--reverse', base]).trim().split('\n');
      planned.sort((a, b) => qaOrder.indexOf(b.qaCommit) - qaOrder.indexOf(a.qaCommit));
    }
    git(['worktree', 'add', '--detach', candidate, base]); worktreeAdded = true;
    git(['config', 'user.name', 'Hobse QA automation'], candidate);
    git(['config', 'user.email', 'hobse-qa@users.noreply.github.com'], candidate);
    const operations = [];
    for (const entry of planned) {
      const before = git(['rev-parse', 'HEAD'], candidate).trim();
      if (request.action === 'rollback') {
        if (git(['revert', '--no-edit', entry.qaCommit], candidate, { allowFailure: true }) === null) {
          const files = git(['diff', '--name-only', '--diff-filter=U'], candidate).trim().split('\n').filter(Boolean);
          throw new Blocked('Blocked: rollback conflicts with current QA. Resolve it through a separately reviewed change.', { sourceCommit: entry.source, conflictingCommit: entry.qaCommit, conflictFiles: files });
        }
        const rollbackCommit = git(['rev-parse', 'HEAD'], candidate).trim();
        operations.push({ source: entry.source, qaCommit: entry.qaCommit, rollbackCommit, active: false });
      } else {
        let picked = false;
        if (entry.mode === 'commit') picked = git(['cherry-pick', '-x', entry.source], candidate, { allowFailure: true }) !== null;
        if (!picked) {
          const conflicts = git(['diff', '--name-only', '--diff-filter=U'], candidate).trim().split('\n').filter(Boolean);
          git(['cherry-pick', '--abort'], candidate, { allowFailure: true });
          // A fallback is a separately reviewed task-only patch, never ours/theirs.
          if (!entry.patch) throw new Blocked('Blocked: the task conflicts with current QA. A reviewed task-only patch is needed.', { sourceCommit: entry.source, conflictFiles: conflicts });
          const patch = readFileSync(trustedFile(policyDir, entry.patch));
          if (!/^[a-f0-9]{64}$/.test(entry.patchSha256 || '') || hash(patch) !== entry.patchSha256) throw new Blocked('The reviewed task-only patch checksum does not match.', { sourceCommit: entry.source });
          if (git(['apply', '--check', '--index', '-'], candidate, { allowFailure: true, input: patch }) === null ||
            git(['apply', '--index', '-'], candidate, { allowFailure: true, input: patch }) === null) {
            throw new Blocked('Blocked: the reviewed task-only patch does not apply cleanly to current QA.', { sourceCommit: entry.source, conflictFiles: conflicts });
          }
          git(['commit', '-m', `${request.taskId}: reviewed task-only patch\n\nSource-Commit: ${entry.source}\nRequested-By: ${request.requestedBy}`], candidate);
        }
        const qaCommit = git(['rev-parse', 'HEAD'], candidate).trim();
        const files = changes(before, qaCommit);
        if (!files.length) throw new Blocked('No task-only changes could be established for this source. Owner review is required.', { sourceCommit: entry.source });
        if (files.some(protectedPath)) throw new Blocked('A task change cannot modify workflow, Git, or QA-ledger infrastructure.', { sourceCommit: entry.source });
        operations.push({ source: entry.source, qaCommit, active: true, mode: picked ? 'commit' : 'patch',
          ...(!picked ? { patch: entry.patch, patchSha256: entry.patchSha256 } : {}), reviewedBy: entry.review.reviewedBy, files });
      }
    }
    const codeHead = git(['rev-parse', 'HEAD'], candidate).trim();
    result.files = changes(base, codeHead);
    if (result.files.some(protectedPath)) throw new Blocked('Operation touches protected infrastructure.');
    result.diff = git(['diff', '--no-ext-diff', '--no-color', base, codeHead], candidate).slice(0, 500_000);
    result.commits = operations;
    const checksInput = { files: result.files, checks: config.checks };
    try {
      if (checkRunner) result.checks = await checkRunner({ candidate, policyDir, ...checksInput });
      else if (checkMode === 'process') result.checks = runChecks({ candidate, policyDir, ...checksInput, env: safeEnv() });
      else {
        // Archive the candidate without .git. Tests cannot access host credentials,
        // mutate Git state, talk to a network, or see the host process namespace.
        const snapshot = join(tempRoot, 'snapshot'); mkdirSync(snapshot);
        const archive = git(['archive', '--format=tar', codeHead], candidate, { raw: true });
        execFileSync('tar', ['-xf', '-', '-C', snapshot], { input: archive, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        const inputDir = join(tempRoot, 'input'); mkdirSync(inputDir);
        writeFileSync(join(inputDir, 'check-input.json'), JSON.stringify(checksInput));
        const checked = spawnSync('docker', ['run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=256', '--memory=1g', '--cpus=2', '--tmpfs=/tmp:rw,noexec,nosuid,size=256m',
          '--mount', `type=bind,src=${snapshot},dst=/candidate,readonly`, '--mount', `type=bind,src=${policyDir},dst=/policy,readonly`, '--mount', `type=bind,src=${inputDir},dst=/input,readonly`,
          '--workdir=/candidate', '--user=1000:1000', 'hobse-qa-checks:local', 'node', '/policy/check-runner.mjs', '--container'], { env: safeEnv(), encoding: 'utf8', timeout: 600_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
        let report;
        try { report = JSON.parse((checked.stdout || '').trim()); } catch { throw new Error(`Check sandbox failed: ${(checked.stderr || checked.error?.message || '').slice(-8000)}`); }
        result.checks = report.checks || [];
        if (checked.status !== 0 || !report.passed) throw Object.assign(new Error(report.reason || 'Candidate checks failed.'), { checks: result.checks });
      }
    } catch (error) { throw new Blocked(error.message, { checks: error.checks || result.checks }); }
    if (!result.checks.length || result.checks.some(check => !check.passed) || !result.checks.some(check => check.kind === 'test')) throw new Blocked('No passing behavioral check evidence was produced.');
    if (git(['rev-parse', 'HEAD'], candidate).trim() !== codeHead || git(['status', '--porcelain'], candidate).trim()) throw new Blocked('Checks modified candidate code or Git state. No push was made.');
    for (const operation of operations) {
      if (request.action === 'promote') {
        const existing = task.entries.find(entry => entry.source === operation.source);
        if (existing) Object.assign(existing, operation); else task.entries.push(operation);
      } else Object.assign(task.entries.find(entry => entry.source === operation.source), { active: false, rollbackCommit: operation.rollbackCommit });
    }
    const remaining = task.entries.filter(entry => entry.active).length;
    task.status = remaining === task.entries.length ? 'active' : remaining ? 'partially_rolled_back' : 'fully_rolled_back';
    state.tasks[request.taskId] = task;
    state.requests[request.requestId] = { taskId: request.taskId, action: request.action, runId };
    result.outcome = 'updated'; result.reason = 'QA branch updated'; result.completedAt = new Date().toISOString(); result.codeHead = codeHead;
    const record = { ...result, qaUpdated: true, taskState: task.status, policySha256: hash(readFileSync(join(policyDir, 'checks.json'))) };
    const recordPath = `.hobse-qa/operations/${request.requestId}.json`;
    mkdirSync(join(candidate, '.hobse-qa', 'operations'), { recursive: true });
    writeFileSync(join(candidate, LEDGER), JSON.stringify(state, null, 2) + '\n');
    writeFileSync(join(candidate, recordPath), JSON.stringify(record, null, 2) + '\n');
    git(['add', '--', LEDGER, recordPath], candidate);
    git(['commit', '-m', `QA operation ${request.requestId}\n\nTask-ID: ${request.taskId}\nAction: ${request.action}\nRequested-By: ${request.requestedBy}\nActions-Run: ${runId || 'fixture'}`], candidate);
    const finalHead = git(['rev-parse', 'HEAD'], candidate).trim();
    await beforePush?.({ candidate, base, result });
    git(['fetch', '--no-tags', remote, `+refs/heads/${qaBranch}:${qaRef}`], repo, { network: true });
    if (git(['rev-parse', qaRef]).trim() !== base) throw new Blocked('QA advanced during validation. The candidate was not pushed. Refresh and submit again.');
    pushAttempted = true;
    if (git(['push', remote, `${finalHead}:refs/heads/${qaBranch}`], repo, { network: true, allowFailure: true }) === null) {
      throw new Blocked('The normal fast-forward push did not return success. Check the exact run and remote ledger before retrying; a lost network acknowledgment cannot establish whether Git accepted it.');
    }
    // Confirm a successful push using the remote ref, not the local commit alone.
    const remoteHead = git(['ls-remote', remote, `refs/heads/${qaBranch}`], repo, { network: true }).trim().split(/\s/)[0];
    if (!SHA.test(remoteHead) || git(['fetch', '--no-tags', remote, `+refs/heads/${qaBranch}:${qaRef}`], repo, { network: true, allowFailure: true }) === null ||
      git(['merge-base', '--is-ancestor', finalHead, qaRef], repo, { allowFailure: true }) === null) {
      result.outcome = 'push_unconfirmed'; result.reason = 'Push returned success, but remote confirmation failed. Inspect the exact run before retrying.'; return result;
    }
    result.qaUpdated = true; result.qaAfter = finalHead; result.taskState = task.status;
    return result;
  } catch (error) {
    result.outcome = pushAttempted ? 'push_unconfirmed' : error instanceof Blocked ? 'blocked' : 'failed';
    result.reason = pushAttempted ? `Push outcome unconfirmed. ${error.message}` : error.message;
    for (const field of ['sourceCommit', 'conflictingCommit', 'conflictFiles', 'checks']) if (error[field]) result[field] = error[field];
    result.qaUpdated = false;
    return result;
  } finally {
    if (worktreeAdded) git(['worktree', 'remove', '--force', candidate], repo, { allowFailure: true });
    if (within(tmpdir(), tempRoot) && tempRoot.startsWith(join(tmpdir(), 'hobse-qa-op-'))) rmSync(tempRoot, { recursive: true, force: true });
  }
}
