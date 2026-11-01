import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createLinuxLive } from '../src/voice/linux-live.mjs';

function fixture(options = {}) {
  const ws = new EventEmitter(); ws.readyState = 0; ws.sent = [];
  ws.send = text => ws.sent.push(JSON.parse(text));
  ws.close = () => { ws.readyState = 3; }; ws.terminate = ws.close;
  const children = [];
  const spawnImpl = (command, args) => {
    const child = new EventEmitter(); Object.assign(child, { command, args, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null });
    child.kill = () => { child.killed = true; child.exitCode = 0; };
    children.push(child); return child;
  };
  const live = createLinuxLive({ env: { OPENAI_API_KEY: 'test-secret' }, webSocketFactory: () => ws, spawnImpl, closeTimeoutMs: 15, ...options });
  const event = value => ws.emit('message', Buffer.from(JSON.stringify(value)));
  const start = async (startOptions = {}) => {
    const pending = live.start({ instructions: 'Be kind', scenePrompt: 'A pirate arrives', ...startOptions });
    await Promise.resolve(); ws.readyState = 1; ws.emit('open');
    event({ type: 'session.started', session: { id: 'test-session' } }); await pending;
  };
  return { live, ws, children, event, start };
}

test('Linux session uses Cinder/client delegation and streams aligned raw PCM both ways', async () => {
  const f = fixture(); await f.start();
  const session = f.ws.sent.find(x => x.type === 'session.start').session;
  assert.equal(session.model, 'gpt-live-1'); assert.equal(session.delegation,undefined);
  assert.equal(session.audio.output.voice, 'cinder'); assert.deepEqual(session.audio.format, { type: 'audio/pcm', rate: 24000 });
  assert.deepEqual(session.input,[]);
  assert.equal(f.children[0].command, 'pw-play'); assert.equal(f.children[1].command, 'pw-record');
  f.children[1].stdout.write(Buffer.from([1, 2, 3])); f.children[1].stdout.write(Buffer.from([4]));
  const chunks = f.ws.sent.filter(x => x.type === 'session.input_audio.append').map(x => Buffer.from(x.audio, 'base64'));
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([1, 2, 3, 4]));
  f.event({ type: 'session.output_audio.delta', delta: Buffer.from([8, 9]).toString('base64') });
  assert.equal(f.live.status().outputBytes, 2);
  const prior=f.ws.sent.length;f.live.updateContext('A witch in a purple hat');assert.equal(f.ws.sent.length,prior);
  f.live.setMuted(true); const count = f.ws.sent.length; f.children[1].stdout.write(Buffer.alloc(4)); assert.equal(f.ws.sent.length, count);
  assert.equal(f.live.status().active, true);
  const stopped = f.live.stop(); assert.ok(f.children.every(x => x.killed));
  assert.equal(f.ws.sent.at(-1).type, 'session.close');
  f.event({ type: 'session.closed', usage: { total_seconds: 1 } }); await stopped;
  assert.equal(f.live.status().state, 'idle'); assert.deepEqual(f.live.status().usage, { total_seconds: 1 });
});

test('unexpected transport failure kills local audio and never exposes credentials', async () => {
  const f = fixture(); await f.start(); f.ws.emit('error', new Error('test-secret'));
  assert.ok(f.children.every(x => x.killed)); assert.equal(f.live.status().active, false);
  assert.doesNotMatch(JSON.stringify(f.live.status()), /test-secret/);
});

test('transcripts bounded; absence stop closes paid session even with no final event', async () => {
  const f = fixture(); await f.start();
  for (let i = 0; i < 50; i++) f.event({ type: 'session.output_transcript.delta', delta: ` ${i}` });
  assert.equal(f.live.status().transcripts.length, 40);
  await f.live.stop('30 seconds absent'); assert.equal(f.live.status().active, false);
  assert.match(f.live.status().error, /final usage unconfirmed/);
});

test('session cannot exceed configured time limit', async () => {
  const f = fixture({ maxSessionMs: 10 }); await f.start();
  await new Promise(resolve => setTimeout(resolve, 12));
  assert.equal(f.ws.sent.at(-1).type, 'session.close');
  f.event({ type: 'session.closed' });
});


test('arrival greeting uses normal conversational volume and one question; there is no sidewalk greeting mode', async () => {
  const f = fixture(); await f.start({ greetingMode: 'sidewalk' });
  const startup = f.ws.sent.find(x => x.type === 'session.commentary.append' && x.delegation_id === null).content;
  assert.match(startup, /normal conversational volume/);
  assert.match(startup, /one Halloween question/);
  assert.doesNotMatch(startup, /Trick or treat!/);
  const stopping = f.live.stop(); f.event({ type: 'session.closed' }); await stopping;
});

test('arrival greeting has exactly one command path while initial visual context remains',async()=>{
 const f=fixture();await f.start();const orders=f.ws.sent.flatMap(message=>message.type==='session.start'?message.session.input.flatMap(item=>item.content||[]).map(part=>part.text||''):[message.content||'']).filter(text=>text.includes('Greet the visitors now'));
 assert.equal(orders.length,1);const input=f.ws.sent.find(message=>message.type==='session.start').session.input;assert.deepEqual(input,[]);const stopping=f.live.stop();f.event({type:'session.closed'});await stopping;
});
test('semantic prompts are capped at three unique kinds and never send unsafe outfit details',async()=>{
 const f=fixture();await f.start({scenePrompt:'A reflective vest',instructions:'Be kind. A high-vis vest.'});
 assert.equal(f.live.sendPrompt('costume','A fluorescent vest.'),false);assert.equal(f.live.sendPrompt('costume','A pirate with a feathered hat.'),true);assert.equal(f.live.sendPrompt('costume','A witch.'),false);assert.equal(f.live.sendPrompt('goodbye','Back to being dead for me.'),true);assert.equal(f.live.sendPrompt('welcome','Hello again'),false);assert.equal(f.live.sendPrompt('fourth','No'),false);
 f.event({type:'session.delegation.created',delegation:{id:'ignored',target:'client'}});f.live.updateContext('New camera scene');
 const prompts=f.ws.sent.filter(message=>message.type==='session.commentary.append');assert.equal(prompts.length,3);assert.doesNotMatch(JSON.stringify(f.ws.sent),/vest|high.vis|fluorescent|reflective|thinking.append/);assert.deepEqual(f.live.status().prompt_events,['welcome','costume','goodbye']);const stopping=f.live.stop();f.event({type:'session.closed'});await stopping;
});
