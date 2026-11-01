// GEMINI_MODE=all-gemini and the events-mode barker / rotating costume question. Fake WebSocket, no real API calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGeminiLive, resolveGeminiMode, worldPromptInfo, DEFAULT_WORLD_PROMPT_FILE } from '../src/voice/gemini-live.mjs';
import { PartyController } from '../src/voice/party-flow.mjs';
import { createArrival, sidewalkBarkerTrigger } from '../src/presence/arrival.mjs';
import { createImprov, costumeQuestion, COSTUME_QUESTIONS } from '../src/voice/improv.mjs';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
function fixture({ env = {}, ...options } = {}) {
  const sockets = [], children = [], speech = [], events = [], timers = [], ticks = [];
  let clock = 1000, frame = { bytes: JPEG, at: 1 };
  const spawnImpl = (command, args) => { const c = new EventEmitter(); Object.assign(c, { command, args, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null }); c.kill = () => { c.exitCode = 0; }; children.push(c); return c; };
  const webSocketFactory = () => { const ws = new EventEmitter(); ws.readyState = 0; ws.sent = []; ws.send = t => ws.sent.push(JSON.parse(t)); ws.close = () => { ws.readyState = 3; }; ws.terminate = ws.close; sockets.push(ws); return ws; };
  const live = createGeminiLive({ env: { GEMINI_API_KEY: 'k', ...env }, webSocketFactory, spawnImpl, now: () => clock,
    onSpeech: e => speech.push(e), onEvent: e => events.push(e), getFrame: () => frame, usageIntervalMs: 1e9,
    setIntervalImpl: fn => { ticks.push(fn); return { unref() {} }; }, schedule: (fn, ms) => { const t = { fn, ms, at: clock + ms }; timers.push(t); return t; }, cancel: t => { if (t) t.cancelled = true; }, ...options });
  const settle = () => new Promise(r => setImmediate(r));
  const open = async () => { const p = live.open({ instructions: 'Be kind' }); await settle(); const ws = sockets.at(-1); ws.readyState = 1; ws.emit('open'); ws.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} }))); await p; return ws; };
  return { live, sockets, children, speech, events, timers, open, ticks, setClock: v => { clock = v; }, setFrame: n => { frame = { bytes: JPEG, at: n }; },
    fireTimers: () => { for (const t of timers.filter(x => !x.cancelled && !x.done && x.at <= clock)) { t.done = true; t.fn(); } },
    video: ws => ws.sent.filter(m => m.realtimeInput?.video).length, audio: ws => ws.sent.filter(m => m.realtimeInput?.audio).length,
    clientContent: ws => ws.sent.filter(m => m.clientContent) };
}
const ALL = { GEMINI_MODE: 'all-gemini', HECKLING: 'on' };

test('GEMINI_MODE defaults to events; junk never enables all-gemini', () => {
  assert.equal(resolveGeminiMode({}), 'events'); assert.equal(resolveGeminiMode({ GEMINI_MODE: 'ALL-GEMINI' }), 'all-gemini'); assert.equal(resolveGeminiMode({ GEMINI_MODE: 'x' }), 'events');
});

test('all-gemini: the system instruction is exactly the world prompt file (and the file override works)', async () => {
  const f = fixture({ env: ALL }); const ws = await f.open();
  const text = ws.sent[0].setup.systemInstruction.parts[0].text;
  assert.equal(text, readFileSync(DEFAULT_WORLD_PROMPT_FILE, 'utf8')); assert.match(text, /old-time banjo player/);
  assert.equal(f.live.status().gemini_mode, 'all-gemini'); assert.equal(f.live.status().prompt_sha, worldPromptInfo({}).sha);
  const dir = mkdtempSync(join(tmpdir(), 'wp-')); const file = join(dir, 'p.md'); writeFileSync(file, 'Custom world.');
  const g = fixture({ env: { ...ALL, GEMINI_WORLD_PROMPT_FILE: file } }); const ws2 = await g.open();
  assert.equal(ws2.sent[0].setup.systemInstruction.parts[0].text, 'Custom world.');
  const e = fixture(); const ws3 = await e.open(); assert.notEqual(ws3.sent[0].setup.systemInstruction.parts[0].text, text); assert.equal(e.live.status().gemini_mode, 'events');
});

test('all-gemini: no party/welcome clientContent (only the stage-cue nudge) across SIDEWALK -> PATH -> costume reads -> EMPTY, even with a PartyController driving the voice', async () => {
  const f = fixture({ env: ALL }); const ws = await f.open();
  f.live.setPresence('SIDEWALK'); f.live.setPresence('PATH');
  const party = new PartyController({ voice: f.live, describe: async () => 'x', schedule: () => ({}), cancel: () => {}, now: () => 5000 });
  for (let i = 1; i <= 3; i++) await party.observe({ at: 5000 - 100 * (4 - i) }, { visitor_count: 1, visitor_location: 'path', group_state: 'PATH', costume_slots: [{ label: 'pirate', confidence: 0.99 }] });
  assert.equal(f.live.sendPrompt('welcome', 'hi'), false); assert.equal(f.live.sendPrompt('barker', 'hey'), false); assert.equal(f.live.instruct('x', 'handoff'), false); assert.equal(f.live.barker('x'), false);
  f.live.setPresence('EMPTY');
  // only the parenthesized stage-cue nudge may go out; never a welcome, costume brief or any party text
  assert.deepEqual(f.clientContent(ws).map(m => m.clientContent.turns[0].parts[0].text), ['(Someone is on the sidewalk. Call out and heckle them in.)']);
});

test('all-gemini: arrival is inert (enabled() false) so no barker, welcome or pre-warm', async () => {
  const voiceCalls = []; const voice = async () => ({ alwaysOn: true, barker: t => { voiceCalls.push(t); return true; }, prewarm: async () => voiceCalls.push('prewarm'), status: () => ({}) });
  const arrival = createArrival({ env: {}, voice, party: async () => ({ active: false, locked: false }), enabled: () => false, busy: () => false });
  await arrival.onDetect({ at: 1, group: { state: 'SIDEWALK', tracks: 1, count: 1, motion: { persons: [{ dir: 'arriving', zone: 'sidewalk' }] } } });
  assert.deepEqual(voiceCalls, []);
});

test('all-gemini: mic and video gated by group state with a ~5 s tail and audioStreamEnd on pause', async () => {
  const f = fixture({ env: ALL }); const ws = await f.open(); const mic = f.children.find(c => c.command === 'pw-record'); const tick = f.ticks[0];
  tick(); mic.stdout.write(Buffer.alloc(640)); assert.equal(f.video(ws), 0); assert.equal(f.audio(ws), 0, 'EMPTY: nothing');
  f.live.setPresence('SIDEWALK'); f.setFrame(2); tick(); mic.stdout.write(Buffer.alloc(640)); assert.equal(f.video(ws), 1); assert.equal(f.audio(ws), 1);
  f.live.setPresence('EMPTY'); f.setClock(1000 + 4000); f.setFrame(3); tick(); mic.stdout.write(Buffer.alloc(640));
  assert.equal(f.video(ws), 2, 'tail: still streaming at 4 s'); assert.equal(f.audio(ws), 2);
  assert.ok(!ws.sent.some(m => m.realtimeInput?.audioStreamEnd));
  f.setClock(1000 + 5100); f.fireTimers(); f.setFrame(4); tick(); mic.stdout.write(Buffer.alloc(640));
  assert.equal(f.video(ws), 2); assert.equal(f.audio(ws), 2); assert.equal(ws.sent.filter(m => m.realtimeInput?.audioStreamEnd).length, 1);
  f.live.setPresence('PATH'); f.setFrame(5); tick(); assert.equal(f.video(ws), 3, 'a new group streams again');
});

test('all-gemini: a visit opens when the state leaves EMPTY and closes when it returns; cost periods follow', async () => {
  const usages = []; const f = fixture({ env: ALL, onUsage: u => usages.push(u) }); await f.open();
  assert.equal(f.live.status().state, 'idle');
  f.live.setPresence('SIDEWALK'); assert.equal(f.live.status().state, 'active'); const id = f.live.status().sessionId;
  f.live.setPresence('PATH'); assert.equal(f.live.status().sessionId, id, 'same visit while not EMPTY');
  f.live.setPresence('EMPTY'); assert.equal(f.live.status().state, 'idle'); assert.notEqual(f.live.status().sessionId, id);
  const kinds = f.speech.map(e => e.kind); assert.ok(kinds.includes('live_connected')); assert.ok(kinds.includes('live_end'));
  assert.deepEqual(f.events.filter(e => /^linux_live\.(started|stopped)$/.test(e.type)).map(e => e.type), ['linux_live.started', 'linux_live.stopped']);
  assert.ok(usages.some(u => u.sessionId === id && !u.idle), 'visit period reported as a visit');
  const h = fixture({ env: ALL }); h.live.setPresence('PATH'); await h.open();
  assert.equal(h.live.status().state, 'active', 'group already there when the session comes up');
});

test('events mode barker: once per group on SIDEWALK arriving, never twice; path welcome is the close-up hello', async () => {
  const barks = []; let welcomed = null;
  const voice = async () => ({ alwaysOn: true, barker: t => { barks.push(t); return true; }, status: () => ({}) });
  const party = async () => ({ active: false, locked: false, begin: async w => { welcomed = w; } });
  const arrival = createArrival({ env: {}, voice, party, enabled: () => true, busy: () => false, rng: () => 0, improv: createImprov() });
  const side = { at: 1, group: { state: 'SIDEWALK', tracks: 1, count: 1, motion: { persons: [{ dir: 'arriving', zone: 'sidewalk' }] } } };
  assert.equal(sidewalkBarkerTrigger({ group: { state: 'PATH', motion: { persons: [{ dir: 'arriving' }] } } }), false);
  assert.equal(sidewalkBarkerTrigger({ group: { state: 'SIDEWALK', motion: { persons: [{ dir: 'present' }] } } }), false);
  await arrival.onDetect(side); await arrival.onDetect(side); await arrival.onDetect({ ...side, at: 2 });
  assert.equal(barks.length, 1); assert.match(barks[0], /barker/i);
  await arrival.onDetect({ at: 3, group: { state: 'PATH', tracks: 1, count: 1, motion: { persons: [{ dir: 'arriving', zone: 'path' }] } } });
  assert.match(welcomed, /close-up hello/);
  await arrival.onDetect({ at: 4, group: { state: 'EMPTY', tracks: 0 } }); await arrival.onDetect(side);
  assert.equal(barks.length, 2, 'next group barks again');
});

test('events mode barker goes out as a clientContent turn only while someone is on the sidewalk/path', async () => {
  const f = fixture(); const ws = await f.open();
  assert.equal(f.live.barker('Step right up'), false, 'EMPTY');
  f.live.setPresence('SIDEWALK'); assert.equal(f.live.barker('Step right up'), true);
  assert.equal(f.clientContent(ws).length, 1); assert.ok(f.speech.some(e => e.kind === 'barker_sent'));
});

test('costume question rotates through the pool via avoid-recent', () => {
  const improv = createImprov(); const rng = () => 0;
  const seen = []; for (let n = 0; n < COSTUME_QUESTIONS.length - 2; n++) seen.push(costumeQuestion({ rng, improv }).id);
  assert.equal(new Set(seen).size, seen.length, 'no repeats while fresh ones remain');
  assert.notEqual(costumeQuestion({ rng, improv }).id, seen.at(-1));
});

test('the costume cue uses the rotating question, not a fixed "favorite candy"', async () => {
  const cues = []; const improv = createImprov();
  for (let k = 0; k < 2; k++) {
    let now = 0;
    const flow = new PartyController({ improv, rng: () => 0, voice: { seesCostumes: () => true, start: async () => {}, sendPrompt: (kind, text) => { cues.push(text); return true; }, stop: async () => {} }, now: () => now, schedule: () => ({}), cancel: () => {} });
    for (let n = 1; n <= 3; n++) { now = n * 1000; await flow.observe({ at: now }, { visitor_count: 1, visitor_location: 'path', costume_slots: [{ label: 'pirate', confidence: 0.99 }] }); }
    await flow.close();
  }
  const costume = cues.filter(c => /Costume details/.test(c)); assert.equal(costume.length, 2);
  assert.ok(costume[0].includes(COSTUME_QUESTIONS[0].text)); assert.ok(!costume[1].includes(COSTUME_QUESTIONS[0].text), 'second group gets a different question');
});

// ---- liveness: ping every 20 s, no pong within 10 s => reconnect with the resumption handle ----
function pingRig() {
  const pt = []; let clock = 0;
  const f = fixture({ pingSchedule: (fn, ms) => { const t = { fn, at: clock + ms }; pt.push(t); return t; }, pingCancel: t => { if (t) t.cancelled = true; } });
  const advance = to => { for (;;) { const due = pt.filter(t => !t.cancelled && !t.done && t.at <= to).sort((a, b) => a.at - b.at)[0]; if (!due) break; due.done = true; clock = due.at; due.fn(); } clock = to; };
  return { f, advance };
}

test('liveness: a missing pong drops the socket and reconnects with the resumption handle', async () => {
  const { f, advance } = pingRig(); const ws = await f.open(); let pings = 0; ws.ping = () => { pings++; };
  ws.emit('message', Buffer.from(JSON.stringify({ sessionResumptionUpdate: { resumable: true, newHandle: 'H1' } })));
  advance(20000); assert.equal(pings, 1);
  assert.equal(f.sockets.length, 1); advance(29999); assert.equal(f.sockets.length, 1, 'still waiting for the pong');
  advance(30001);
  assert.equal(f.live.status().connected, false);
  const rc = f.timers.find(t => !t.cancelled); assert.ok(rc, 'reconnect scheduled'); rc.fn(); await new Promise(r => setImmediate(r));
  assert.equal(f.sockets.length, 2); f.sockets[1].readyState = 1; f.sockets[1].emit('open');
  assert.equal(f.sockets[1].sent[0].setup.sessionResumption.handle, 'H1');
  assert.ok(f.speech.some(e => e.kind === 'live_pong_timeout')); assert.equal(f.live.status().reconnects, 1);
});

test('liveness: healthy pongs keep the same connection and update the status fields', async () => {
  const { f, advance } = pingRig(); const ws = await f.open(); ws.ping = () => {};
  ws.emit('message', Buffer.from(JSON.stringify({ serverContent: {} })));
  for (let i = 1; i <= 10; i++) { advance(i * 20000); ws.emit('pong'); }
  assert.equal(f.sockets.length, 1); assert.equal(f.live.status().connected, true); assert.equal(f.live.status().reconnects, 0);
  const s = f.live.status(); assert.ok(s.last_pong_at != null); assert.ok(s.last_server_message_at != null); assert.equal(typeof s.connection_age_s, 'number');
});
