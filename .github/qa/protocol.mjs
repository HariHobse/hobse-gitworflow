import { createHmac, timingSafeEqual } from 'node:crypto';

export const PROTOCOL = 'hobse-qa-v1';
export const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function normalizeTask(value) {
  const task = String(value || '').trim().toUpperCase();
  if (task.length > 80 || !/^[A-Z][A-Z0-9]*-\d+$/.test(task)) throw new Error('Enter a Task ID such as HOB-117 (maximum 80 characters).');
  return task;
}
export function validateRequest(request) {
  if (request.protocol !== PROTOCOL || !REQUEST_ID.test(request.requestId) || normalizeTask(request.taskId) !== request.taskId ||
    !['promote', 'rollback'].includes(request.action) || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(request.requestedBy) ||
    !/^[a-f0-9]{40}$/.test(request.expectedQa) || !Number.isSafeInteger(request.issuedAt) ||
    (request.selectedCommit && !/^[a-f0-9]{40}$/.test(request.selectedCommit))) throw new Error('Invalid operation request.');
  if (request.action === 'promote' && request.selectedCommit) throw new Error('Commit selection is only available for rollback.');
  return request;
}
export function signRequest(request, secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('QA_REQUEST_SIGNING_SECRET needs at least 32 characters.');
  validateRequest(request);
  const payload = Buffer.from(JSON.stringify(request)).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}
export function verifyRequest(ticket, secret, now = Date.now()) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('The workflow signing secret is not configured.');
  if (typeof ticket !== 'string' || ticket.length > 4096) throw new Error('Invalid operation signature.');
  const [payload, signature, extra] = ticket.split('.');
  if (!payload || !signature || extra) throw new Error('Invalid operation signature.');
  const expected = createHmac('sha256', secret).update(payload).digest();
  const supplied = Buffer.from(signature, 'base64url');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('Invalid operation signature.');
  const request = validateRequest(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
  if (request.issuedAt > now + 60_000 || now - request.issuedAt > 86_400_000) throw new Error('This signed request has expired. Submit a new request.');
  return request;
}
export function runTitle(request) {
  return `QAOP | ${request.taskId} | ${request.action} | ${request.requestId} | @${request.requestedBy}`;
}
export function parseRunTitle(title) {
  const match = String(title || '').match(/^QAOP \| ([A-Z][A-Z0-9]*-\d+) \| (promote|rollback) \| ([0-9a-f-]{36}) \| @([A-Za-z0-9-]+)$/);
  if (!match || !REQUEST_ID.test(match[3])) return null;
  return { taskId: match[1], action: match[2], requestId: match[3], requestedBy: match[4] };
}
