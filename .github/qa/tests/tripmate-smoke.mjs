import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

// No AI API calls or real credentials: these routes complete before the
// outbound API path. The immutable candidate is served only on loopback.
const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
const port = reserve.address().port; await new Promise(done => reserve.close(done));
const sessions = mkdtempSync(join(tmpdir(), 'hobse-php-test-'));
let output = '';
const php = spawn('php', ['-d', `session.save_path=${sessions}`, '-S', `127.0.0.1:${port}`, '-t', process.cwd()], { stdio: ['ignore', 'pipe', 'pipe'] });
php.stdout.on('data', data => { output += data; }); php.stderr.on('data', data => { output += data; });
const base = `http://127.0.0.1:${port}`;
try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { await fetch(base, { signal: AbortSignal.timeout(500) }); ready = true; break; } catch { await new Promise(done => setTimeout(done, 50)); }
  }
  assert.ok(ready, `PHP application did not start: ${output}`);
  const home = await fetch(`${base}/index.php`);
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /<form\b/i);
  assert.doesNotMatch(html, /(?:Fatal error|Warning:|Parse error)/);
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    const target = match[1];
    if (/^(?:https?:|data:|#|\/\/)/.test(target)) continue;
    const file = resolve(target.replace(/^\//, '').split('?')[0]);
    assert.ok(file.startsWith(process.cwd()) && existsSync(file), `Missing local runtime dependency: ${target}`);
    assert.equal((await fetch(new URL(target, base))).status, 200, target);
  }
  for (const scenario of [
    { body: '{broken', status: 400, key: 'error' },
    { body: '{}', status: 422, key: 'error' },
    { body: '{"action":"reset"}', status: 200, key: 'messages' },
  ]) {
    const response = await fetch(`${base}/chat.php`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: scenario.body });
    assert.equal(response.status, scenario.status);
    const text = await response.text();
    assert.doesNotMatch(text, /(?:Fatal error|Warning:|Parse error)/);
    const data = JSON.parse(text);
    assert.ok(Object.hasOwn(data, scenario.key));
    if (scenario.key === 'messages') assert.deepEqual(data.messages, []);
  }
  console.log('TripMate home, local assets, invalid JSON, empty input and reset behavior passed.');
} finally {
  php.kill(); await once(php, 'exit').catch(() => {});
  rmSync(sessions, { recursive: true, force: true });
}
