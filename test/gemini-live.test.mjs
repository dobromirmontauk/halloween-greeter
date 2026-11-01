import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createGeminiLive, resolveVoiceBackend, geminiStartupWarnings, GEMINI_ENDPOINT, RECONNECT_BACKOFF_MS } from '../src/voice/gemini-live.mjs';
import { createCosts, geminiCostUsd } from '../src/lib/costs.mjs';

const SECRET = 'gem-test-secret';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function fixture({ env = {}, ...options } = {}) {
  const sockets = [], children = [], speechEvents = [], usages = [], events = [], timers = [], factoryCalls = [];
  const spawnImpl = (command, args) => {
    const child = new EventEmitter(); Object.assign(child, { command, args, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null });
    child.kill = () => { child.killed = true; child.exitCode = 0; };
    children.push(child); return child;
  };
  const webSocketFactory = (url, opts) => {
    factoryCalls.push({ url, opts });
    const ws = new EventEmitter(); ws.readyState = 0; ws.sent = [];
    ws.send = text => ws.sent.push(JSON.parse(text));
    ws.close = () => { ws.readyState = 3; }; ws.terminate = ws.close;
    sockets.push(ws); return ws;
  };
  let frame = { bytes: JPEG, at: 1 };
  const live = createGeminiLive({ env: { GEMINI_API_KEY: SECRET, ...env }, webSocketFactory, spawnImpl,
    onSpeech: e => speechEvents.push(e), onUsage: u => usages.push(u), onEvent: e => events.push(e),
    getFrame: () => frame, usageIntervalMs: 1e9, setIntervalImpl: () => ({ unref() {} }),
    schedule: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, cancel: t => { if (t) t.cancelled = true; }, ...options });
  const last = () => sockets.at(-1);
  const settle = () => new Promise(r => setImmediate(r));
  const connectSocket = async (resumed) => { await settle(); const ws = last(); ws.readyState = 1; ws.emit('open'); ws.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} }))); return ws; };
  const server = (msg, ws = last()) => ws.emit('message', Buffer.from(JSON.stringify(msg)));
  const open = async () => { const p = live.open({ instructions: 'Be kind' }); const ws = await connectSocket(); await p; return ws; };
  const nextFrame = (n, bytes = JPEG) => { frame = { bytes, at: n }; };
  const kinds = ws => ws.sent.map(m => Object.keys(m)[0] + (m.realtimeInput ? ':' + Object.keys(m.realtimeInput)[0] : ''));
  return { live, sockets, children, speechEvents, usages, events, timers, factoryCalls, last, settle, connectSocket, server, open, nextFrame, kinds };
}

test('VOICE_BACKEND selection: openai by default, gemini only when asked, junk never switches silently', () => {
  assert.equal(resolveVoiceBackend({}), 'openai');
  assert.equal(resolveVoiceBackend({ VOICE_BACKEND: 'gemini' }), 'gemini');
  assert.equal(resolveVoiceBackend({ VOICE_BACKEND: 'GEMINI ' }), 'gemini');
  assert.equal(resolveVoiceBackend({ VOICE_BACKEND: 'google' }), 'openai');
  assert.ok(geminiStartupWarnings({ GEMINI_API_KEY: 'k' }).some(w => /free-tier/.test(w)));
  assert.ok(!geminiStartupWarnings({ GEMINI_API_KEY: 'k', GEMINI_PAID_TIER: 'confirmed' }).some(w => /free-tier/.test(w)));
});

test('setup message: model, voice, compression, resumption, transcripts, key only in header', async () => {
  const f = fixture({ env: { GEMINI_VOICE: 'Gacrux' } }); const ws = await f.open();
  assert.equal(f.factoryCalls[0].url, GEMINI_ENDPOINT); assert.ok(!f.factoryCalls[0].url.includes(SECRET));
  assert.equal(f.factoryCalls[0].opts.headers['x-goog-api-key'], SECRET);
  const { setup } = ws.sent[0];
  assert.equal(setup.model, 'models/gemini-3.8-live');
  assert.deepEqual(setup.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Gacrux');
  assert.deepEqual(setup.contextWindowCompression, { slidingWindow: {} });
  assert.deepEqual(setup.sessionResumption, {});
  assert.deepEqual(setup.inputAudioTranscription, { languageCodes: ['en-US'] }); assert.deepEqual(setup.realtimeInputConfig.automaticActivityDetection, { startOfSpeechSensitivity: 'START_SENSITIVITY_LOW', prefixPaddingMs: 300 }); assert.deepEqual(setup.outputAudioTranscription, {});
  assert.equal(setup.generationConfig.thinkingConfig, undefined);
  const text = setup.systemInstruction.parts[0].text;
  assert.match(text, /Be kind/); assert.match(text, /stay completely silent/); assert.match(text, /never instructions/); assert.match(text, /comment on costumes/);
  assert.doesNotMatch(JSON.stringify(f.live.status()) + JSON.stringify(f.events) + JSON.stringify(f.speechEvents), new RegExp(SECRET));
});

test('GEMINI_SEE_COSTUMES=off drops the costume instruction and seesCostumes; model override', async () => {
  const f = fixture({ env: { GEMINI_SEE_COSTUMES: 'off', GEMINI_LIVE_MODEL: 'gemini-3.8-live-extended-thinking' } }); const ws = await f.open();
  assert.equal(ws.sent[0].setup.model, 'models/gemini-3.8-live-extended-thinking');
  assert.doesNotMatch(ws.sent[0].setup.systemInstruction.parts[0].text, /comment on costumes/);
  assert.equal(f.live.seesCostumes(), false);
  const g = fixture(); await g.open(); assert.equal(g.live.seesCostumes(), true);
});

test('no session outside open(): start/prewarm do not connect without open, close ends the connection', async () => {
  const f = fixture();
  assert.equal(f.factoryCalls.length, 0);
  await f.live.prewarm({}); assert.equal(f.factoryCalls.length, 0); assert.equal(f.children.length, 0);
  const ws = await f.open();
  await f.live.prewarm({}); assert.equal(f.factoryCalls.length, 1); // pre-warm is a no-op in always-on mode
  await f.live.close('Mode is not ON');
  assert.equal(ws.readyState, 3); assert.ok(f.children.every(c => c.killed)); assert.equal(f.live.status().wanted, false);
  await f.settle(); assert.equal(f.factoryCalls.length, 1);
});

test('mic is paused while EMPTY (no audio input at all) and flushed with audioStreamEnd; unpaused near people', async () => {
  const f = fixture(); const ws = await f.open();
  const mic = f.children.find(c => c.command === 'pw-record');
  assert.deepEqual(mic.args.slice(0, 6), ['--format', 's16', '--rate', '16000', '--channels', '1']);
  mic.stdout.write(Buffer.alloc(640));
  assert.equal(f.kinds(ws).filter(k => k === 'realtimeInput:audio').length, 0, 'EMPTY: nothing sent');
  f.live.setPresence('SIDEWALK');
  mic.stdout.write(Buffer.from([1, 2, 3])); mic.stdout.write(Buffer.from([4]));
  const chunks = ws.sent.filter(m => m.realtimeInput?.audio);
  assert.deepEqual(Buffer.concat(chunks.map(m => Buffer.from(m.realtimeInput.audio.data, 'base64'))), Buffer.from([1, 2, 3, 4]));
  assert.equal(chunks[0].realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
  f.live.setPresence('EMPTY');
  assert.deepEqual(ws.sent.at(-1), { realtimeInput: { audioStreamEnd: true } });
  const n = ws.sent.length; mic.stdout.write(Buffer.alloc(640)); assert.equal(ws.sent.length, n);
  f.live.setPresence('EMPTY'); assert.equal(ws.sent.length, n, 'no repeated audioStreamEnd');
  const u = f.live.status(); assert.equal(u.mic_sending, false);
});

test('video frames only while SIDEWALK/PATH or a visit is active, at most 1 fps, never twice the same frame', async () => {
  let tick; const f = fixture({ setIntervalImpl: fn => { if (!tick) tick = fn; return { unref() {} }; } });
  // first interval created is the video timer
  const ws = await f.open();
  tick(); assert.equal(ws.sent.filter(m => m.realtimeInput?.video).length, 0, 'EMPTY: no video');
  f.live.setPresence('SIDEWALK'); f.nextFrame(2); tick();
  const v = ws.sent.filter(m => m.realtimeInput?.video); assert.equal(v.length, 1);
  assert.equal(v[0].realtimeInput.video.mimeType, 'image/jpeg'); assert.deepEqual(Buffer.from(v[0].realtimeInput.video.data, 'base64'), JPEG);
  tick(); assert.equal(ws.sent.filter(m => m.realtimeInput?.video).length, 1, 'same frame not resent');
  f.nextFrame(3, Buffer.from('not a jpeg')); tick(); assert.equal(ws.sent.filter(m => m.realtimeInput?.video).length, 1, 'non-JPEG rejected');
  f.nextFrame(4); f.live.setPresence('EMPTY'); tick(); assert.equal(ws.sent.filter(m => m.realtimeInput?.video).length, 1, 'EMPTY stops video');
  await f.live.start({ welcomePrompt: 'Greet.' }); f.nextFrame(5); tick(); assert.equal(ws.sent.filter(m => m.realtimeInput?.video).length, 2, 'visit streams even if presence says EMPTY');
  assert.equal(f.live.status().video_fps, 1);
});

test('GEMINI_VIDEO_FPS is capped at the documented 1 fps and 0 disables video', async () => {
  const intervals = []; const mk = env => fixture({ env, setIntervalImpl: (fn, ms) => { intervals.push(ms); return { unref() {} }; } });
  const a = mk({ GEMINI_VIDEO_FPS: '5' }); await a.open(); assert.ok(intervals.includes(1000)); assert.equal(a.live.status().video_fps, 1);
  const b = mk({ GEMINI_VIDEO_FPS: '0' }); const ws = await b.open(); assert.equal(b.live.status().video_fps, 0);
  assert.doesNotMatch(ws.sent[0].setup.systemInstruction.parts[0].text, /through a camera/); assert.equal(b.live.seesCostumes(), false);
});

test('welcome is sent instantly into the already open session as a clientContent turn; no new connection', async () => {
  const f = fixture({ env: { INFORM_MIN_MS: '0' } }); const ws = await f.open();
  const before = f.factoryCalls.length;
  const status = await f.live.start({ welcomePrompt: 'Two visitors arriving.' });
  assert.equal(f.factoryCalls.length, before);
  const welcome = ws.sent.at(-1).clientContent;
  assert.equal(welcome.turnComplete, true); assert.equal(welcome.turns[0].role, 'user'); assert.match(welcome.turns[0].parts[0].text, /Two visitors/);
  assert.equal(status.state, 'active');
  assert.ok(f.speechEvents.some(e => e.kind === 'welcome_sent'));
  assert.equal(f.live.sendPrompt('welcome', 'again'), false);
  assert.equal(f.live.sendPrompt('costume', 'A witch'), true); assert.match(ws.sent.at(-1).clientContent.turns[0].parts[0].text, /witch/);
  assert.equal(f.live.instruct('One leaving.', 'departures'), true);
  assert.ok(f.speechEvents.some(e => e.kind === 'inform_sent' && e.inform === 'departures'), 'crowd brief goes out as an inform');
  assert.equal(f.live.sendPrompt('goodbye', 'Bye.'), true);
});

test('stop() ends the visit but keeps the connection open and emits linux_live.stopped (warm:false)', async () => {
  const f = fixture(); const ws = await f.open(); await f.live.start({ welcomePrompt: 'Hi.' });
  await f.live.stop('absence');
  assert.equal(f.live.status().state, 'idle'); assert.equal(ws.readyState, 1); assert.equal(f.live.status().connected, true);
  assert.ok(f.events.some(e => e.type === 'linux_live.stopped' && e.warm === false));
  assert.ok(f.speechEvents.some(e => e.kind === 'live_end'));
  assert.equal(f.live.sendPrompt('costume', 'x'), false);
  await f.live.start({ welcomePrompt: 'Next group.' }); assert.match(ws.sent.at(-1).clientContent.turns[0].parts[0].text, /Next group/);
});

test('audio out is played at 24 kHz, speech events and transcripts are emitted, barge-in flushes playback', async () => {
  const f = fixture(); const ws = await f.open(); await f.live.start({ welcomePrompt: 'Hi.' });
  const player = f.children.find(c => c.command === 'pw-play'); assert.deepEqual(player.args.slice(0, 4), ['--format', 's16', '--rate', '24000']);
  const got = []; player.stdin.on('data', d => got.push(d));
  f.server({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from([8, 9]).toString('base64') } }] } } });
  f.server({ serverContent: { outputTranscription: { text: 'Howdy' } } });
  f.server({ serverContent: { inputTranscription: { text: 'hello' } } });
  assert.equal(f.live.status().outputBytes, 2);
  const kinds = f.speechEvents.map(e => e.kind);
  for (const k of ['live_connected', 'welcome_sent', 'first_audio_out', 'assistant_turn_start', 'user_speech_start']) assert.ok(kinds.includes(k), k);
  assert.deepEqual(f.live.status().transcripts.map(t => t.role), ['assistant', 'user']);
  const players = f.children.filter(c => c.command === 'pw-play').length;
  f.server({ serverContent: { interrupted: true } });
  assert.equal(f.children.filter(c => c.command === 'pw-play').length, players + 1); assert.ok(player.killed);
  assert.ok(f.speechEvents.some(e => e.kind === 'assistant_interrupted'));
  assert.ok(f.speechEvents.some(e => e.kind === 'assistant_turn_end' && e.interrupted));
  await f.live.stop();
  assert.ok(f.speechEvents.some(e => e.kind === 'live_end'));
});

test('goAway reconnects immediately with the latest resumption handle; mic/video wait for setupComplete', async () => {
  const f = fixture(); const ws1 = await f.open();
  f.server({ sessionResumptionUpdate: { resumable: false, newHandle: '' } });
  f.server({ sessionResumptionUpdate: { resumable: true, newHandle: 'handle-A' } });
  f.server({ sessionResumptionUpdate: { resumable: true, newHandle: 'handle-B' } });
  f.live.setPresence('PATH');
  f.server({ goAway: { timeLeft: '50s' } });
  assert.equal(f.timers.at(-1).ms, 0); assert.equal(f.live.status().connected, false);
  const mic = f.children.find(c => c.command === 'pw-record'); const n = ws1.sent.length; mic.stdout.write(Buffer.alloc(640)); assert.equal(ws1.sent.length, n);
  f.timers.at(-1).fn(); await f.settle();
  const ws2 = f.last(); assert.notEqual(ws2, ws1); ws2.readyState = 1; ws2.emit('open');
  assert.deepEqual(ws2.sent[0].setup.sessionResumption, { handle: 'handle-B' });
  mic.stdout.write(Buffer.alloc(640)); assert.equal(ws2.sent.filter(m => m.realtimeInput?.audio).length, 0, 'not ready yet');
  ws2.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} })));
  assert.equal(f.live.status().connected, true);
  mic.stdout.write(Buffer.alloc(640)); assert.equal(ws2.sent.filter(m => m.realtimeInput?.audio).length, 1);
  assert.ok(f.speechEvents.some(e => e.kind === 'live_reconnect' && e.reason === 'go_away' && e.resume === true));
  assert.equal(f.children.filter(c => c.command === 'pw-record').length, 1, 'audio devices are not restarted');
});

test('connection drop: backoff 1,2,5,10,10 s, handle rejected falls back to a fresh session, welcome queued across reconnect', async () => {
  assert.deepEqual(RECONNECT_BACKOFF_MS, [1000, 2000, 5000, 10000]);
  const f = fixture(); const ws1 = await f.open();
  f.server({ sessionResumptionUpdate: { resumable: true, newHandle: 'h1' } });
  ws1.emit('close', 1006);
  assert.equal(f.timers.at(-1).ms, 1000);
  // visit begins while down: welcome is queued, not lost
  const status = await f.live.start({ welcomePrompt: 'Queued welcome.' }); assert.equal(status.state, 'active');
  assert.ok(!f.speechEvents.some(e => e.kind === 'welcome_sent'));
  f.timers.at(-1).fn(); await f.settle(); const ws2 = f.last(); assert.deepEqual((ws2.readyState = 1, ws2.emit('open'), ws2.sent[0].setup.sessionResumption), { handle: 'h1' });
  ws2.emit('close', 1008); // handle rejected before setupComplete
  assert.equal(f.timers.at(-1).ms, 2000); assert.ok(f.speechEvents.some(e => e.kind === 'live_resume_rejected'));
  f.timers.at(-1).fn(); await f.settle(); const ws3 = f.last(); ws3.readyState = 1; ws3.emit('open');
  assert.deepEqual(ws3.sent[0].setup.sessionResumption, {}, 'fresh session after rejection');
  ws3.emit('error', new Error(SECRET)); assert.equal(f.timers.at(-1).ms, 5000);
  f.timers.at(-1).fn(); await f.settle(); const ws4 = f.last(); ws4.emit('close'); assert.equal(f.timers.at(-1).ms, 10000);
  f.timers.at(-1).fn(); await f.settle(); const ws5 = f.last(); ws5.emit('close'); assert.equal(f.timers.at(-1).ms, 10000);
  f.timers.at(-1).fn(); await f.settle(); const ws6 = f.last(); ws6.readyState = 1; ws6.emit('open'); ws6.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} })));
  assert.match(ws6.sent.at(-1).clientContent.turns[0].parts[0].text, /Queued welcome/);
  assert.ok(f.speechEvents.some(e => e.kind === 'welcome_sent'));
  assert.equal(f.live.status().consecutive_failures, 0, 'backoff resets after a good connection');
  assert.doesNotMatch(JSON.stringify(f.live.status()) + JSON.stringify(f.events) + JSON.stringify(f.speechEvents), new RegExp(SECRET));
});

test('suspend()/resume() reuse the resumption handle (hook for YOLO-driven start/stop)', async () => {
  const f = fixture(); const ws1 = await f.open();
  f.server({ sessionResumptionUpdate: { resumable: true, newHandle: 'keep' } });
  f.live.suspend(); assert.equal(ws1.readyState, 3);
  f.live.resume(); await f.settle(); const ws2 = f.last(); ws2.readyState = 1; ws2.emit('open');
  assert.deepEqual(ws2.sent[0].setup.sessionResumption, { handle: 'keep' });
});

test('usage: audio-in only while unpaused, video seconds, audio-out, connected seconds; priced by modality', async () => {
  let t = 1000; let tick; const f = fixture({ now: () => t, setIntervalImpl: fn => { if (!tick) tick = fn; return { unref() {} }; } });
  const ws = await f.open(); const mic = f.children.find(c => c.command === 'pw-record');
  mic.stdout.write(Buffer.alloc(32000)); // paused: not billed
  f.live.setPresence('PATH');
  mic.stdout.write(Buffer.alloc(32000 * 60)); // 60 s of 16 kHz audio
  for (let i = 0; i < 30; i++) { f.nextFrame(i + 10); tick(); } // 30 frames at 1 fps = 30 s
  f.server({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(48000 * 10).toString('base64') } }] } } }); // 10 s out
  t += 120000;
  await f.live.stop('end'); await f.live.close('done');
  const parts = f.usages.filter(u => u.sessionId === f.usages.at(0).sessionId || true).reduce((a, u) => ({ ...a, [u.sessionId]: u }), {});
  const all = Object.values(parts);
  const sum = k => all.reduce((a, u) => a + (u.parts[k] || 0), 0);
  assert.equal(Math.round(sum('audio_in_seconds')), 60); assert.equal(sum('video_seconds'), 30); assert.equal(Math.round(sum('audio_out_seconds')), 10);
  assert.ok(sum('connected_seconds') >= 119);
  const expected = geminiCostUsd({ audio_in_seconds: 60, video_seconds: 30, audio_out_seconds: 10 });
  assert.ok(Math.abs(all.reduce((a, u) => a + u.usd, 0) - expected) < 1e-9);
  assert.ok(Math.abs(expected - (0.005 + 0.001 + 0.003)) < 1e-9);
  assert.ok(all.every(u => u.backend === 'gemini' && u.model === 'gemini-3.8-live'));
});

test('costs: gemini usage lands under live with backend, per-modality seconds, idle periods are not sessions', () => {
  const c = createCosts();
  c.recordLive({ sessionId: 'v1', seconds: 60, backend: 'gemini', model: 'gemini-3.8-live', usd: 0.01, parts: { connected_seconds: 60, audio_in_seconds: 30, video_seconds: 30, audio_out_seconds: 5 } });
  c.recordLive({ sessionId: 'v1', seconds: 120, backend: 'gemini', model: 'gemini-3.8-live', usd: 0.03, parts: { connected_seconds: 120, audio_in_seconds: 90, video_seconds: 60, audio_out_seconds: 10 } });
  c.recordLive({ sessionId: 'idle1', seconds: 600, backend: 'gemini', model: 'gemini-3.8-live', usd: 0, idle: true, parts: { connected_seconds: 600, audio_in_seconds: 0, video_seconds: 0, audio_out_seconds: 0 } });
  const live = c.snapshot().since_start.by_category.live;
  assert.equal(live.backend, 'gemini'); assert.equal(live.sessions, 1);
  assert.ok(Math.abs(live.usd - 0.03) < 1e-9);
  assert.deepEqual(live.by_backend.gemini.parts, { connected_seconds: 720, audio_in_seconds: 90, video_seconds: 60, audio_out_seconds: 10 });
  assert.ok(c.snapshot().pricing.some(p => p.model === 'gemini-3.8-live' && p.price === 0.018));
  // a gpt-live session still prices at $0.05/min
  c.recordLive({ sessionId: 'g', seconds: 60 }); assert.ok(Math.abs(c.snapshot().since_start.by_model['gpt-live-1'].usd - 0.05) < 1e-9);
});

test('missing key rejects open and never connects', async () => {
  const f = fixture({ env: { GEMINI_API_KEY: '' } });
  await assert.rejects(f.live.open({}), /GEMINI_API_KEY/); assert.equal(f.factoryCalls.length, 0);
});
