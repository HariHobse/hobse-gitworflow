import { writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyRequest } from './protocol.mjs';
import { executeOperation } from './engine.mjs';

let result;
try {
  const request = verifyRequest(process.env.QA_REQUEST_TOKEN, process.env.QA_REQUEST_SIGNING_SECRET);
  const allowed = (process.env.QA_ALLOWED_USERS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(request.requestedBy.toLowerCase())) throw new Error('The signed-in requester is not authorized by the repository policy.');
  if (request.taskId !== process.env.INPUT_TASK_ID || request.action !== process.env.INPUT_ACTION || request.requestId !== process.env.INPUT_REQUEST_ID || request.requestedBy !== process.env.INPUT_REQUESTED_BY) {
    throw new Error('Run metadata does not match the signed operation request.');
  }
  if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('QA operations must execute trusted workflow code from main.');
  if (process.argv.includes('--verify')) {
    console.log('Verified signed requester and operation metadata.');
  } else {
    delete process.env.QA_REQUEST_SIGNING_SECRET;
    delete process.env.QA_REQUEST_TOKEN;
    result = await executeOperation({ repo: process.cwd(), policyDir: resolve('.github/qa'), request, token: process.env.GITHUB_TOKEN, runId: Number(process.env.GITHUB_RUN_ID), runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT || 1) });
  }
} catch (error) {
  result = { schemaVersion: 1, outcome: 'blocked', qaUpdated: false, reason: error.message, commits: [], files: [], checks: [] };
}
if (result) {
  writeFileSync(process.env.QA_RESULT_PATH, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ outcome: result.outcome, reason: result.reason, qaUpdated: result.qaUpdated }));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## ${result.qaUpdated ? 'QA branch updated' : result.outcome}\n\n${result.taskId || 'Request verification'} · ${result.action || 'Blocked'} · requested by @${result.requestedBy || 'unverified'}\n\n${String(result.reason).replaceAll('`', '')}\n\nSee the exact run's result artifact for commits, files, checks, and QA diff.\n`);
  if (!['updated', 'already_in_qa', 'already_processed'].includes(result.outcome)) process.exitCode = 1;
}
