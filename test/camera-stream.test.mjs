import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createCameraStream } from '../src/presence/camera-stream.mjs';

const jpeg = n => Buffer.from([0xff, 0xd8, n, 0xff, 0xd9]);
function fixture(options = {}) {
  const children = [];
  const spawnImpl = (command, args, config) => {
    const child = new EventEmitter(); Object.assign(child, { command, args, config, stdout: new PassThrough(), stderr: new PassThrough(), killed: [] });
    child.kill = signal => { child.killed.push(signal); };
    children.push(child); return child;
  };
  const stream = createCameraStream({ url: 'rtsp://user:private-secret@camera/stream1', spawnImpl, stallTimeoutMs: 0, restartDelayMs: 2, maxRestartDelayMs: 2, ...options });
  const cleanup = () => { stream.stop(); children.at(-1)?.emit('close'); };
  return { stream, children, cleanup };
}

test('one decoder serves concurrent snapshots and subscribers; split markers/noise recover', async t => {
  const f = fixture(); t.after(f.cleanup);
  assert.equal(f.children.length, 0); f.stream.start(); f.stream.start();
  const frames = []; const unsubscribe = f.stream.subscribe(frame => frames.push(frame));
  const a = f.stream.snapshot(), b = f.stream.snapshot();
  const stdout = f.children[0].stdout;
  stdout.write(Buffer.from([8, 9, 0xff])); stdout.write(Buffer.from([0xd8, 1, 0xff])); stdout.write(Buffer.from([0xd9, 0xff, 0xd8, 2, 0xff, 0xd9]));
  assert.deepEqual((await a).bytes, jpeg(1)); assert.deepEqual((await b).bytes, jpeg(1));
  assert.equal(f.children.length, 1); assert.equal(frames.length, 2); assert.deepEqual(f.stream.latest().bytes, jpeg(2));
  unsubscribe(); stdout.write(jpeg(3)); assert.equal(frames.length, 2);
  const args = f.children[0].args;
  assert.equal(args[args.indexOf('-rtsp_transport') + 1], 'tcp');
  assert.equal(args[args.indexOf('-vf') + 1], 'fps=6,scale=960:-2');
  assert.equal(args[args.indexOf('-f') + 1], 'image2pipe');
  assert.doesNotMatch(JSON.stringify(f.stream.status()), /private-secret|rtsp:/);
});

test('stale snapshots wait for new data, timeout safely and stop rejects waiters', async t => {
  let time = 100;
  const f = fixture({ now: () => time }); t.after(f.cleanup); f.stream.start();
  f.children[0].stdout.write(jpeg(1)); time = 2000;
  let settled = false; const pending = f.stream.snapshot({ maxAgeMs: 100 }).then(x => { settled = true; return x; });
  await Promise.resolve(); assert.equal(settled, false);
  f.children[0].stdout.write(jpeg(2)); assert.equal((await pending).at, 2000);
  time = 3000; await assert.rejects(f.stream.snapshot({ maxAgeMs: 100, timeoutMs: 3 }), /fresh camera frame/);
  const waiting = f.stream.snapshot({ maxAgeMs: 100 }); f.stream.stop(); await assert.rejects(waiting, /stopped/);
  assert.equal(f.stream.latest(), null); assert.deepEqual(f.children[0].killed, ['SIGTERM']);
  await assert.rejects(f.stream.snapshot(), /not running/);
});

test('failed decoder waits for close before reconnecting; stop cancels reconnect', async t => {
  const f = fixture(); t.after(f.cleanup); f.stream.start();
  f.children[0].emit('error', new Error('rtsp://private-secret'));
  await new Promise(resolve => setTimeout(resolve, 4)); assert.equal(f.children.length, 1);
  f.children[0].emit('close');
  await new Promise(resolve => setTimeout(resolve, 4)); assert.equal(f.children.length, 2);
  const pending = f.stream.snapshot(); f.children[1].stdout.write(jpeg(4)); assert.deepEqual((await pending).bytes, jpeg(4));
  f.children[1].emit('close'); f.stream.stop();
  await new Promise(resolve => setTimeout(resolve, 4)); assert.equal(f.children.length, 2);
  assert.doesNotMatch(JSON.stringify(f.stream.status()), /private-secret/);
});

test('parser bounds incomplete frames and recovers at next JPEG without files', async t => {
  const f = fixture({ maxFrameBytes: 16, rotate: 180 }); t.after(f.cleanup); f.stream.start();
  const stdout = f.children[0].stdout;
  stdout.write(Buffer.from([0xff, 0xd8, ...Array(10).fill(1)]));
  stdout.write(Buffer.alloc(20));
  assert.ok(f.stream.status().buffered_bytes <= 16);
  stdout.write(Buffer.from([0xff, 0xd8, 1, 0xff, 0xd8, 5, 0xff, 0xd9]));
  assert.deepEqual((await f.stream.snapshot()).bytes, jpeg(5));
  assert.match(f.children[0].args[f.children[0].args.indexOf('-vf') + 1], /hflip,vflip/);
  assert.deepEqual(f.children[0].config.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(f.children[0].args.at(-1), 'pipe:1');
});


test('stalled decoder is retired and restarted without overlapping RTSP sessions', async t => {
  const f = fixture({ stallTimeoutMs: 4 }); t.after(f.cleanup); f.stream.start();
  await new Promise(resolve => setTimeout(resolve, 7));
  assert.deepEqual(f.children[0].killed, ['SIGTERM']);
  assert.equal(f.children.length, 1);
  f.children[0].emit('close');
  await new Promise(resolve => setTimeout(resolve, 3));
  assert.equal(f.children.length, 2);
  f.children[1].stdout.write(jpeg(9));
  assert.equal(f.stream.status().state, 'streaming');
});
