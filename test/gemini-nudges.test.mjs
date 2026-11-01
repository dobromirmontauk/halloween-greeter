// all-gemini stage-cue nudges (approach, porch, silence joke) and readable Gemini connect errors. Fake WebSocket, no real API calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createGeminiLive } from '../src/voice/gemini-live.mjs';
import { createVisitor } from '../src/replay/replay-visitor.mjs';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
function fixture({ env = {}, ...options } = {}) {
  const sockets = [], speech = [], events = [], timers = [];
  let clock = 1000;
  const spawnImpl = (command, args) => { const c = new EventEmitter(); Object.assign(c, { command, args, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null }); c.kill = () => { c.exitCode = 0; }; return c; };
  const webSocketFactory = () => { const ws = new EventEmitter(); ws.readyState = 0; ws.sent = []; ws.send = t => ws.sent.push(JSON.parse(t)); ws.close = () => { ws.readyState = 3; }; ws.terminate = ws.close; sockets.push(ws); return ws; };
  const live = createGeminiLive({ env: { GEMINI_API_KEY: 'k', ...env }, webSocketFactory, spawnImpl, now: () => clock,
    onSpeech: e => speech.push(e), onEvent: e => events.push(e), getFrame: () => ({ bytes: JPEG, at: 1 }), usageIntervalMs: 1e9,
    setIntervalImpl: () => ({ unref() {} }), schedule: (fn, ms) => { const t = { fn, ms, at: clock + ms }; timers.push(t); return t; }, cancel: t => { if (t) t.cancelled = true; }, ...options });
  const settle = () => new Promise(r => setImmediate(r));
  const open = async () => { const p = live.open({ instructions: 'x' }); await settle(); const ws = sockets.at(-1); ws.readyState = 1; ws.emit('open'); ws.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} }))); await p; return ws; };
  return { live, sockets, speech, events, timers, open, settle, setClock: v => { clock = v; },
    fireTimers: () => { for (const t of timers.filter(x => !x.cancelled && !x.done && x.at <= clock)) { t.done = true; t.fn(); } },
    pending: () => timers.filter(t => !t.cancelled && !t.done),
    clientContent: ws => ws.sent.filter(m => m.clientContent) };
}
const ALL = { GEMINI_MODE: 'all-gemini', HECKLING: 'on' };
const textsOf = (f, ws) => f.clientContent(ws).map(m => m.clientContent.turns[0].parts[0].text);
const nudgesOf = f => f.speech.filter(e => e.kind === 'nudge_sent').map(e => e.n);
const NEAR = { persons: [{ score: 0.9, zone: 'path', bbox: [0.4, 0.4, 0.5, 0.82] }], group: { state: 'PATH' } };
const FAR = { persons: [{ score: 0.9, zone: 'path', bbox: [0.4, 0.2, 0.5, 0.5] }], group: { state: 'PATH' } };
const PORCH = { persons: [{ score: 0.9, zone: 'porch', bbox: [0.4, 0.5, 0.5, 0.95] }], group: { state: 'PATH' } };
const msg = o => Buffer.from(JSON.stringify(o));

test('nudge 1 fires once, neutral, when the state first leaves EMPTY', async () => {
  const f = fixture({ env: ALL }); const ws = await f.open();
  assert.deepEqual(textsOf(f, ws), []);
  f.live.setPresence('SIDEWALK'); f.live.setPresence('PATH'); f.live.setPresence('SIDEWALK');
  assert.deepEqual(textsOf(f, ws), ['(Someone is on the sidewalk. Call out and heckle them in.)']);
  assert.ok(ws.sent.find(m => m.clientContent).clientContent.turnComplete);
  assert.deepEqual(nudgesOf(f), [1]);
  f.live.setPresence('EMPTY'); f.live.setPresence('PATH'); assert.deepEqual(nudgesOf(f), [1, 1], 'a new visit gets its own nudge 1');
});

test('nudge 2 fires once at the porch or a near path foot, at least 1 s after nudge 1', async () => {
  const f = fixture({ env: ALL }); const ws = await f.open();
  f.live.setPresence('PATH'); f.live.noteDetect(FAR); assert.deepEqual(nudgesOf(f), [1], 'far path foot: no nudge 2');
  f.live.noteDetect(NEAR); assert.deepEqual(nudgesOf(f), [1], 'gap: not yet');
  f.setClock(2000); f.fireTimers(); assert.deepEqual(nudgesOf(f), [1, 2]);
  assert.match(textsOf(f, ws)[1], /^\(They're at the porch now\. Your turn\.\)$/);
  f.live.noteDetect(PORCH); f.live.noteDetect(NEAR); f.setClock(2500); f.fireTimers(); assert.deepEqual(nudgesOf(f), [1, 2], 'once per visit');
  const at = n => f.speech.find(e => e.kind === 'nudge_sent' && e.n === n).at; assert.ok(at(2) - at(1) >= 1000);
  const g = fixture({ env: ALL }); await g.open(); g.setClock(5000); g.live.setPresence('SIDEWALK'); g.setClock(8000); g.live.noteDetect(PORCH);
  assert.deepEqual(nudgesOf(g), [1, 2], 'porch after the gap: immediate');
});

test('silence joke: SILENCE_JOKE_MS after nudge 2 with no visitor speech, once', async () => {
  const f = fixture({ env: ALL }); const ws = await f.open();
  f.live.setPresence('PATH'); f.setClock(3000); f.live.noteDetect(PORCH);
  assert.equal(f.pending().at(-1).ms, 4000);
  f.setClock(6999); f.fireTimers(); assert.deepEqual(nudgesOf(f), [1, 2]);
  f.setClock(7000); f.fireTimers(); assert.deepEqual(nudgesOf(f), [1, 2, 'silence']);
  assert.match(textsOf(f, ws)[2], /might be dead too.*trick or treat/); f.setClock(30000); f.fireTimers(); assert.equal(textsOf(f, ws).length, 3);
  const g = fixture({ env: { ...ALL, SILENCE_JOKE_MS: '1500' } }); await g.open(); g.live.setPresence('PATH'); g.setClock(3000); g.live.noteDetect(PORCH); assert.equal(g.pending().at(-1).ms, 1500);
});

test('silence joke is measured from the end of her reply to nudge 2', async () => {
  const f = fixture({ env: ALL }); const ws = await f.open();
  f.live.setPresence('PATH'); f.setClock(3000); f.live.noteDetect(PORCH);
  f.setClock(4000); ws.emit('message', msg({ serverContent: { outputTranscription: { text: 'Well hello' } } })); // she starts talking at 4.0 s
  f.setClock(8000); f.fireTimers(); assert.deepEqual(nudgesOf(f), [1, 2], 'not while she is mid-reply');
  f.live.close(); // turn end is reported by closeTurns; nothing else may fire
});

test('silence joke counts from her turn end when that is after nudge 2', async () => {
  const f = fixture({ env: ALL, turnGapMs: 0 }); const ws = await f.open();
  f.live.setPresence('PATH'); f.setClock(3000); f.live.noteDetect(PORCH);
  f.setClock(4000); ws.emit('message', msg({ serverContent: { outputTranscription: { text: 'Well hello' } } }));
  f.setClock(5000); ws.emit('message', msg({ serverContent: { interrupted: true } })); // ends her turn at 5.0 s
  f.setClock(8999); f.fireTimers(); assert.deepEqual(nudgesOf(f), [1, 2]);
  f.setClock(9000); f.fireTimers(); assert.deepEqual(nudgesOf(f), [1, 2, 'silence']);
});

test('silence joke is cancelled by visitor speech (transcription or VAD) and by EMPTY', async () => {
  for (const kind of ['transcription', 'vad', 'empty']) {
    const f = fixture({ env: ALL }); const ws = await f.open();
    f.live.setPresence('PATH'); f.setClock(3000); f.live.noteDetect(PORCH);
    if (kind === 'transcription') ws.emit('message', msg({ serverContent: { inputTranscription: { text: 'trick or treat' } } }));
    if (kind === 'vad') ws.emit('message', msg({ voiceActivity: { type: 'ACTIVITY_START' } }));
    if (kind === 'empty') f.live.setPresence('EMPTY');
    f.setClock(20000); f.fireTimers(); assert.deepEqual(nudgesOf(f), [1, 2], kind);
  }
});

test('no nudges in events mode', async () => {
  const f = fixture(); const ws = await f.open();
  f.live.setPresence('SIDEWALK'); f.live.setPresence('PATH'); f.live.noteDetect(PORCH); f.setClock(20000); f.fireTimers();
  assert.deepEqual(nudgesOf(f), []); assert.equal(f.clientContent(ws).length, 0);
});

test('a visit that began before the link was up gets nudge 1 once connected', async () => {
  const f = fixture({ env: ALL }); f.live.setPresence('PATH'); const ws = await f.open();
  assert.deepEqual(nudgesOf(f), [1]); assert.equal(textsOf(f, ws).length, 1);
});

// ---- readable connect errors ----
const KEY = 'AIzaSyFAKEKEYFAKEKEYFAKEKEY123456';
test('connect errors are readable in status and live_reconnect detail, and never contain the key', async () => {
  const f = fixture({ env: { GEMINI_API_KEY: KEY } });
  void f.live.open(); await f.settle();
  f.sockets.at(-1).emit('close', 1011, Buffer.from('Internal error for key ' + KEY));
  const st = f.live.status(); assert.match(st.error, /closed 1011 Internal error/); assert.equal(st.apiError.code, 1011);
  assert.match(f.speech.find(e => e.kind === 'live_reconnect').detail, /closed 1011/);
  assert.ok(!JSON.stringify([st, f.speech, f.events]).includes(KEY));
  const g = fixture({ env: { GEMINI_API_KEY: KEY }, webSocketFactory: () => { throw new Error('Cannot find package ws (key ' + KEY + ')'); } });
  void g.live.open(); await g.settle();
  assert.match(g.live.status().error, /connect setup failed: Cannot find package ws/); assert.ok(!JSON.stringify([g.live.status(), g.speech]).includes(KEY));
  const h = fixture({ env: { GEMINI_API_KEY: KEY } }); void h.live.open(); await h.settle();
  h.sockets.at(-1).emit('error', new Error('getaddrinfo ENOTFOUND')); assert.match(h.speech.find(e => e.kind === 'live_reconnect').detail, /ENOTFOUND/);
});

test('an invalid API key fails fast after 2 attempts', async () => {
  const f = fixture({ env: { GEMINI_API_KEY: KEY } }); void f.live.open();
  for (let i = 0; i < 2; i++) {
    await f.settle(); f.sockets.at(-1).emit('close', 1008, Buffer.from('API key not valid. Please pass a valid API key.'));
    if (i === 0) { f.setClock(1e6); const rc = f.pending()[0]; assert.ok(rc, 'first failure retries'); rc.done = true; rc.fn(); }
  }
  assert.equal(f.sockets.length, 2); assert.equal(f.live.status().fatal, true);
  assert.ok(f.speech.some(e => e.kind === 'live_failed' && /API key not valid/.test(e.detail)));
  assert.equal(f.pending().length, 0, 'no further retry scheduled');
  assert.match(f.live.status().error, /API key not valid/);
});

// ---- the simulated visitor against the silence joke ----
async function visitorRig(silentAfter) {
  let visitor = null;
  const f = fixture({ env: ALL, turnGapMs: 0, onSpeech: e => { f.speech.push(e); visitor?.onSpeech(e); } });
  const ws = await f.open();
  visitor = createVisitor({ tts: async () => Buffer.alloc(3200, 1), silentAfter, schedule: fn => { setImmediate(fn); return {}; }, cancel: () => {},
    inject: () => ws.emit('message', msg({ serverContent: { inputTranscription: { text: 'trick or treat' } } })) });
  f.live.setPresence('PATH'); visitor.onDetect('PATH'); f.setClock(3000); f.live.noteDetect(PORCH);
  // she answers nudge 2; the turn ends a tick later, the visitor then replies (or, silent-after 0, stays quiet)
  ws.emit('message', msg({ serverContent: { outputTranscription: { text: 'Evening, folks. What are you supposed to be?' } } }));
  await new Promise(r => setTimeout(r, 30));
  return { f, visitor };
}
test('a visitor reply cancels the silence joke', async () => {
  const { f, visitor } = await visitorRig(null); assert.equal(visitor.count(), 1);
  f.setClock(60000); f.fireTimers(); assert.ok(!nudgesOf(f).includes('silence'));
});
test('--visitor-silent-after 0 lets the silence joke fire', async () => {
  const { f, visitor } = await visitorRig(0); assert.equal(visitor.count(), 0);
  f.setClock(60000); f.fireTimers(); assert.ok(nudgesOf(f).includes('silence'));
});

// ---- cue outbox: a cue never interrupts her ----
const real = ms => new Promise(r => setTimeout(r, ms));
const speak = (ws, text = 'Well hello there') => ws.emit('message', msg({ serverContent: { outputTranscription: { text } } }));
const done = ws => ws.emit('message', msg({ serverContent: { turnComplete: true } }));
const kinds = (f, k) => f.speech.filter(e => e.kind === k);

test('a cue due mid-turn is held and sent after turnComplete + CUE_GAP_MS', async () => {
  const f = fixture({ env: ALL }); const ws = await f.open();
  f.live.setPresence('PATH'); assert.deepEqual(nudgesOf(f), [1]);
  f.setClock(1500); speak(ws);
  f.setClock(3000); f.live.noteDetect(PORCH);
  assert.deepEqual(nudgesOf(f), [1], 'held mid-turn'); assert.deepEqual(kinds(f, 'cue_queued').map(e => e.n), [2]);
  f.setClock(3500); done(ws); await real(15);
  assert.deepEqual(nudgesOf(f), [1], 'gap not elapsed'); f.setClock(4099); f.fireTimers(); assert.deepEqual(nudgesOf(f), [1]);
  f.setClock(4100); f.fireTimers(); assert.deepEqual(nudgesOf(f), [1, 2]);
  assert.equal(f.clientContent(ws).length, 2);
});

test('a cue is held until the playback queue drains, even after turnComplete', async () => {
  const f = fixture({ env: ALL }); const ws = await f.open();
  f.live.setPresence('PATH'); f.setClock(1500);
  ws.emit('message', msg({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(24000).toString('base64') } }] } } })); // 500 ms of audio
  f.setClock(3000); f.live.noteDetect(PORCH); f.setClock(1600); done(ws);
  await real(100); assert.equal(kinds(f, 'assistant_playback_end').length, 0, 'still playing locally'); assert.deepEqual(nudgesOf(f), [1]);
  await real(500); assert.equal(kinds(f, 'assistant_playback_end').length, 1);
  f.setClock(5000); f.fireTimers(); assert.deepEqual(nudgesOf(f), [1, 2]);
});

test('nudge 1 queued then nudge 2 due: only nudge 2 is sent', async () => {
  const f = fixture({ env: ALL }); const ws = await f.open(); speak(ws);
  f.live.setPresence('PATH'); assert.deepEqual(nudgesOf(f), []); assert.deepEqual(kinds(f, 'cue_queued').map(e => e.n), [1]);
  f.setClock(2500); f.live.noteDetect(PORCH);
  assert.deepEqual(kinds(f, 'cue_dropped').map(e => [e.n, e.reason]), [[1, 'superseded']]);
  done(ws); await real(15); f.setClock(4000); f.fireTimers();
  assert.deepEqual(nudgesOf(f), [2]); assert.equal(textsOf(f, ws).length, 1); assert.match(textsOf(f, ws)[0], /^\(They're at the porch now/);
});

test('a cue waits while the visitor is speaking', async () => {
  const f = fixture({ env: ALL }); const ws = await f.open();
  ws.emit('message', msg({ voiceActivity: { type: 'ACTIVITY_START' } }));
  f.live.setPresence('PATH'); f.setClock(9000); f.fireTimers(); assert.deepEqual(nudgesOf(f), []);
  ws.emit('message', msg({ voiceActivity: { type: 'ACTIVITY_END' } })); assert.deepEqual(nudgesOf(f), [1]);
  const g = fixture({ env: ALL }); const w2 = await g.open(); g.live.setPresence('PATH'); g.setClock(2500);
  w2.emit('message', msg({ serverContent: { inputTranscription: { text: 'hi' } } })); g.live.noteDetect(PORCH); assert.deepEqual(nudgesOf(g), [1], 'queued n2 held 800 ms after visitor text');
  g.setClock(3299); g.fireTimers(); assert.deepEqual(nudgesOf(g), [1]); g.setClock(3300); g.fireTimers(); assert.deepEqual(nudgesOf(g), [1, 2]);
});

test('a queued cue is discarded on EMPTY', async () => {
  const f = fixture({ env: ALL }); const ws = await f.open(); speak(ws);
  f.live.setPresence('PATH'); f.live.setPresence('EMPTY');
  assert.ok(kinds(f, 'cue_dropped').some(e => e.n === 1));
  done(ws); await real(15); f.setClock(20000); f.fireTimers(); assert.deepEqual(nudgesOf(f), []); assert.equal(f.clientContent(ws).length, 0);
});

test('events mode: a prompt during speech is deferred, latest wins, farewell goes now, informCue never interrupts', async () => {
  const f = fixture(); const ws = await f.open(); await f.live.start({ welcomePrompt: 'Hello there' });
  assert.equal(f.clientContent(ws).length, 1); speak(ws);
  assert.equal(f.live.instruct('Welcome the newcomers one', 'handoff'), true); assert.equal(f.live.instruct('Welcome the newcomers two', 'handoff'), true);
  assert.equal(f.clientContent(ws).length, 1, 'deferred');
  assert.equal(f.live.informCue('(Two more people are at the gate.)'), true);
  const inform = f.clientContent(ws).at(-1).clientContent; assert.equal(inform.turnComplete, false);
  assert.equal(kinds(f, 'assistant_interrupted').length, 0); assert.equal(kinds(f, 'assistant_turn_start').length, 1, 'no new turn');
  assert.equal(f.live.instruct('Say goodbye', 'farewell'), true); assert.equal(f.clientContent(ws).at(-1).clientContent.turns[0].parts[0].text, 'Say goodbye', 'farewell is immediate');
  const before = f.clientContent(ws).length;
  done(ws); await real(15); f.setClock(f.speech.at(-1).at + 5000); f.fireTimers();
  const texts = textsOf(f, ws).slice(before); assert.deepEqual(texts, ['Welcome the newcomers two']);
  assert.deepEqual(kinds(f, 'cue_dropped').map(e => e.reason), ['replaced']);
});

test('head count text is an inform, nudge 2 is short', async () => {
  const { informCountText, NUDGE_TEXT } = await import('../src/voice/gemini-live.mjs');
  assert.equal(informCountText(1), '(Now 1 guest.)'); assert.equal(informCountText(3), '(Now 3 guests.)');
  assert.equal(NUDGE_TEXT[2], "(They're at the porch now. Your turn.)");
});
