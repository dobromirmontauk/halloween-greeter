import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createServer} from '../server.mjs';
import {ROOT} from '../src/lib/paths.mjs';
import {DEFAULT_WORLD_PROMPT_FILE} from '../src/voice/gemini-live.mjs';
import {DEFAULT_ZONES_FILE} from '../src/presence/person-detector.mjs';

test('layout: server boots, serves / /api/status and every public asset; root-relative files resolve', async () => {
  assert.equal(ROOT, resolve(import.meta.dirname, '..'));
  for (const f of [DEFAULT_WORLD_PROMPT_FILE, DEFAULT_ZONES_FILE, resolve(ROOT, 'detector', 'detect.py'), resolve(ROOT, 'scripts', 'replay', 'run.mjs'), resolve(ROOT, 'docs', 'JOKES.md')])
    assert.ok(existsSync(f), f);
  const server = createServer({env: {}});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async p => { const res = await fetch(base + p); await res.arrayBuffer(); return res.status; };
    assert.equal(await get('/'), 200);
    assert.equal(await get('/visits.html'), 200);
    assert.equal(await get('/api/status'), 200);
    for (const f of readdirSync(resolve(ROOT, 'public')).filter(f => f !== 'index.html'))
      assert.equal(await get('/' + f), 200, f);
  } finally {
    await server.stopAutomation();
    await new Promise(r => server.close(r));
  }
});
