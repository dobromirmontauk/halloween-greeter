// Preloaded into every test file by `npm test` (node --test --import). When a file's tests have finished but
// something (an unclosed server, sidecar child, un-unref'd timer) still keeps the event loop alive, the process
// would hang forever. Instead, fail fast and name the leaking handles.
import {after} from 'node:test';

const GRACE_MS = Number(process.env.TEST_LEAK_GRACE_MS) || 8000;

export function describeHandles() {
  const names = process._getActiveHandles().filter(h => h !== process.stdout && h !== process.stderr && h !== process.stdin).map(h => {
    const name = h.constructor?.name || 'Handle';
    if (h.spawnargs) return `${name}(${h.spawnargs.join(' ').slice(0, 80)})`;
    if (typeof h.address === 'function' && h.listening) { try { return `${name}(listening ${JSON.stringify(h.address())})`; } catch {} }
    return name;
  });
  const reqs = process.getActiveResourcesInfo().filter(n => !['TTYWrap', 'PipeWrap', 'FSReqCallback'].includes(n));
  return {handles: names, resources: reqs};
}

after(() => {
  const t = setTimeout(() => {
    process.stderr.write(`\n[leak-guard] ${process.argv[1] || 'test file'} finished but the process is still alive after ${GRACE_MS} ms: ${JSON.stringify(describeHandles())}\n`);
    process.exit(1);
  }, GRACE_MS);
  t.unref(); // if nothing else is alive the process exits normally and this never fires
});
