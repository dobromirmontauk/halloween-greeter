import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {createServer} from '../server.mjs';
import {describeHandles} from '../scripts/test-leak-guard.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverHandles = () => describeHandles().handles.filter(h => /Server|ChildProcess|Socket/.test(h) && !/WriteStream|ReadStream/.test(h));

test('createServer().close() leaves no listening servers or child processes', async () => {
  const before = serverHandles().length;
  const server = createServer({env: {}});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/status`);
  await res.arrayBuffer();
  await server.stopAutomation();
  await new Promise(r => server.close(r));
  await new Promise(r => setTimeout(r, 50));
  assert.ok(serverHandles().filter(h => /listening|ChildProcess/.test(h)).length <= before, JSON.stringify(describeHandles()));
});

test('a created server lets a plain node process exit by itself', async () => {
  const code = `import {createServer} from './server.mjs';
const s=createServer({env:{}});await new Promise(r=>s.listen(0,'127.0.0.1',r));
await fetch('http://127.0.0.1:'+s.address().port+'/api/status').then(r=>r.arrayBuffer());
await s.stopAutomation();await new Promise(r=>s.close(r));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {cwd: root, stdio: 'ignore', env: {...process.env, NODE_TEST_CONTEXT: ''}});
  const exit = await new Promise(resolveExit => {
    const t = setTimeout(() => { child.kill('SIGKILL'); resolveExit('hung'); }, 15000);
    child.on('exit', c => { clearTimeout(t); resolveExit(c); });
  });
  assert.equal(exit, 0, 'process kept running after server.close()');
});
