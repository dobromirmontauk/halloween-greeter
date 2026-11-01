import { spawn } from 'node:child_process';
import {safeVoiceText} from './party-flow.mjs';
import {createLinuxAudio} from './linux-audio.mjs';

// Server-owned, full-duplex audio. Never opens a browser microphone.
// Protocol verified 2026-10-25 against official voice-websockets/live-conversations.
export function createLinuxLive({ env = process.env, onEvent = () => {}, onTranscript = () => {},
  spawnImpl = spawn, webSocketFactory, startTimeoutMs = 20000, closeTimeoutMs = 15000,
  maxSessionMs = 1800000, now = Date.now, onUsage = () => {}, onSpeech = () => {}, onWarm = () => {}, audioTap = null, warmMaxMs = 30000, turnGapMs = 700, userGapMs = 1000 } = {}) {
  let finalUsageSeen = false;
  const reportUsage = (seconds, estimated) => { try { onUsage({ sessionId: current.sessionId, seconds, estimated }); } catch {} };
  const promptKinds=new Set();
  // Speech timeline events (kind, at = ms epoch like detector frames, text only for assistant turn ends, never user words). Consumed by the visit recorder.
  const speech = (kind, extra = {}) => { try { onSpeech({ kind, at: now(), session_id: current.sessionId, ...extra }); } catch {} };
  const clip80 = text => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  let warm = false, welcomeText = '', warmSince = null, warmTimer = null, firstOut = false, firstTranscript = false, aTurn = null, uTurn = null;
  const closeTurns = () => {
    if (aTurn) { clearTimeout(aTurn.timer); speech('assistant_turn_end', { at: Math.min(aTurn.audioEnd, now()), text: clip80(aTurn.text) }); aTurn = null; }
    if (uTurn) { clearTimeout(uTurn.timer); speech('user_speech_end', { at: uTurn.last }); uTurn = null; }
  };
  // Assistant output (audio delta bytes and/or transcript text). A turn starts at its first output; it ends when the queued audio (24 kHz s16 = 48 bytes/ms) has finished playing, or turnGapMs after the last transcript.
  const noteAssistant = ({ bytes = 0, text = '' }) => {
    const t = now();
    if (!firstOut) { firstOut = true; speech('first_audio_out', { source: bytes ? 'audio' : 'transcript' }); }
    if (text && !firstTranscript) { firstTranscript = true; speech('first_transcript'); }
    if (!aTurn) { aTurn = { audioEnd: t, text: '', timer: null }; speech('assistant_turn_start', { at: t }); }
    if (bytes) aTurn.audioEnd = Math.max(aTurn.audioEnd, t) + bytes / 48;
    else aTurn.audioEnd = Math.max(aTurn.audioEnd, t);
    aTurn.text += text;
    clearTimeout(aTurn.timer);
    const turn = aTurn;
    turn.timer = setTimeout(() => { if (aTurn === turn) { aTurn = null; speech('assistant_turn_end', { at: turn.audioEnd, text: clip80(turn.text) }); } }, Math.max(0, turn.audioEnd - t) + turnGapMs);
    turn.timer.unref?.();
  };
  const noteUser = (explicit) => {
    const t = now();
    if (explicit === 'end') { if (uTurn) { clearTimeout(uTurn.timer); speech('user_speech_end', { at: t }); uTurn = null; } return; }
    if (!uTurn) { uTurn = { last: t, timer: null }; speech('user_speech_start', { at: t }); }
    uTurn.last = t;
    if (explicit === 'start') { clearTimeout(uTurn.timer); uTurn.timer = null; return; } // an explicit VAD event ends the turn itself
    clearTimeout(uTurn.timer);
    const turn = uTurn;
    turn.timer = setTimeout(() => { if (uTurn === turn) { uTurn = null; speech('user_speech_end', { at: turn.last }); } }, userGapMs);
    turn.timer.unref?.();
  };
  let socket, startPromise, resolveStart, rejectStart, stopPromise, resolveStop;
  let startTimer, closeTimer, limitTimer, pendingByte = Buffer.alloc(0), serial = 0, generation = 0;
  let current = { state: 'idle', active: false, muted: false, sessionId: null, startedAt: null,
    error: null, apiError: null, transcripts: [], inputBytes: 0, outputBytes: 0, usage: null, warm: false };
  const emit = event => { try { onEvent(event); } catch {} };
  const status = () => structuredClone({...current,prompt_events:[...promptKinds]});
  const send = event => {
    if (socket?.readyState !== 1) return false;
    socket.send(JSON.stringify({ event_id: `linux_${++serial}`, ...event }));
    return true;
  };
  const audio = createLinuxAudio({ env, spawnImpl, tap: audioTap, isActive: () => current.state === 'active', onFail: message => fail(message) });
  const killAudio = () => { audio.killAll(); pendingByte = Buffer.alloc(0); };
  const finalize = (error = null) => {
    clearTimeout(startTimer); clearTimeout(closeTimer); clearTimeout(limitTimer); clearTimeout(warmTimer);
    const wasWarm = Boolean(current.warm);
    if (wasWarm && warmSince != null) { try { onWarm({ seconds: (now() - warmSince) / 1000, used: false }); } catch {} }
    warmSince = null; current.warm = false;
    closeTurns(); speech('live_end', { reason: error || 'closed' });
    killAudio();
    if (!finalUsageSeen && current.startedAt) { finalUsageSeen = true; reportUsage((Date.now() - current.startedAt) / 1000, true); } // no final usage: estimate from open time
    current.active = false;
    current.state = error ? 'error' : 'idle';
    if (error) current.error = error;
    if (rejectStart) rejectStart(new Error(error || 'Session stopped before startup'));
    resolveStart = rejectStart = null;
    const oldSocket = socket; socket = null;
    if (oldSocket?.readyState === 1) oldSocket.close();
    else if (oldSocket?.readyState === 0) oldSocket.terminate?.();
    resolveStop?.(status()); resolveStop = null;
    emit({ type: 'linux_live.stopped', reason: error || 'closed', warm: wasWarm });
  };
  const stop = (reason = 'operator') => {
    if (current.state === 'stopping') return stopPromise;
    if (!['starting', 'active', 'warm'].includes(current.state)) return Promise.resolve(status());
    current.state = 'stopping'; current.active = false;
    clearTimeout(startTimer); clearTimeout(limitTimer); clearTimeout(warmTimer); killAudio();
    stopPromise = new Promise(resolve => { resolveStop = resolve; });
    emit({ type: 'linux_live.stopping', reason });
    if (!send({ type: 'session.close' })) finalize();
    else closeTimer = setTimeout(() => {
      socket?.terminate?.();
      finalize('Live close timed out; final usage unconfirmed');
    }, closeTimeoutMs);
    closeTimer?.unref?.();
    return stopPromise;
  };
  const fail = message => {
    current.error = message;
    emit({ type: 'linux_live.error', message });
    // Gracefully request final usage even for a failed audio device/protocol event.
    if (socket?.readyState === 1) void stop('error');
    else finalize(message);
  };
  const beginPlayer = () => audio.beginPlayer();
  const beginAudio = () => {
    beginPlayer();
    audio.beginCapture(chunk => {
      if (current.state !== 'active' || current.muted) return;
      if ((socket?.bufferedAmount || 0) > 480000) return fail('Live microphone upload stalled');
      const bytes = Buffer.concat([pendingByte, chunk]);
      const length = bytes.length - bytes.length % 2;
      pendingByte = bytes.subarray(length);
      if (length && send({ type: 'session.input_audio.append', audio: bytes.subarray(0, length).toString('base64') })) current.inputBytes += length;
    });
  };
  const sendPrompt=(kind,content)=>{
    if(current.state!=='active'||!['welcome','costume','goodbye'].includes(kind)||promptKinds.has(kind))return false;
    const clean=safeVoiceText(content).slice(0,1600);if(!clean)return false;
    if(!send({type:'session.commentary.append',delegation_id:null,content:clean}))return false;
    promptKinds.add(kind);emit({type:'linux_live.prompt',kind});speech(kind+'_sent');return true;
  };
  // Repeatable one-time instruction (group handoff, farewell). Not a prompt kind; the caller decides when.
  const instruct=(content,kind='instruct')=>{
    if(current.state!=='active')return false;
    const clean=safeVoiceText(content).slice(0,1600);if(!clean)return false;
    if(!send({type:'session.commentary.append',delegation_id:null,content:clean}))return false;
    emit({type:'linux_live.instruct'});speech(String(kind).replace(/[^a-z_]/g,'')+'_sent');return true;
  };
  // A new group may receive its own costume prompt.
  const rearmPrompts=(...kinds)=>{for(const kind of kinds)promptKinds.delete(kind);};
  const updateContext = () => false; // This experience accepts only three semantic events.
  const setMuted = muted => {
    const changed = current.muted !== Boolean(muted);
    current.muted = Boolean(muted); pendingByte = Buffer.alloc(0);
    if (current.state === 'active') {
      send({ type: `session.input_audio.${current.muted ? 'mute' : 'unmute'}` });
      if (changed && current.muted) { audio.killPlayer(); }
      else if (changed) { try { beginPlayer(); } catch { fail('Linux playback initialization failed'); } }
    }
    return status();
  };
  const greeting = 'Greet the visitors now in English as the old-time banjo player at normal conversational volume. Make one short dry, friendly Halloween observation, ask one Halloween question, then pause and listen. This is a one-time arrival greeting, not an instruction to repeat it on camera updates. Never announce camera controls or people counts.';
  // The session is open and the audio devices are running: a warm session becomes the real one the moment the welcome is wanted.
  const activate = text => {
    if (warmSince != null) { try { onWarm({ seconds: (now() - warmSince) / 1000, used: true }); } catch {} }
    warmSince = null; clearTimeout(warmTimer); current.warm = false; warm = false;
    current.state = 'active'; current.active = true;
    try { beginAudio(); } catch { fail('Linux audio initialization failed'); return false; }
    limitTimer = setTimeout(() => {void stop('session time limit');socket?.terminate?.();finalize();},Math.min(maxSessionMs,1800000));limitTimer.unref?.();
    sendPrompt('welcome', text || greeting);
    emit({ type: 'linux_live.started', sessionId: current.sessionId });
    return true;
  };
  const start = async ({ instructions = '', scenePrompt = '', context = '', welcomePrompt = '', prewarm = false } = {}) => {
    if (current.state === 'active') return status();
    if (current.state === 'warm') {
      if (prewarm) return status();
      speech('live_activated'); activate(welcomePrompt); return status();
    }
    if (current.state === 'starting') { if (!prewarm && warm) { warm = false; current.warm = false; welcomeText = welcomePrompt || greeting; speech('live_activated'); } return startPromise; }
    if (current.state === 'stopping') await stopPromise;
    if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for Linux Live audio');
    const mine = ++generation;
    promptKinds.clear(); finalUsageSeen = false; warm = Boolean(prewarm); welcomeText = welcomePrompt || greeting; warmSince = null; firstOut = firstTranscript = false;
    speech('live_start_requested', { prewarm: Boolean(prewarm) });
    current = { ...current, state: 'starting', active: false, muted: false, sessionId: null,
      startedAt: null, error: null, apiError: null, transcripts: [], inputBytes: 0, outputBytes: 0, usage: null, warm: warm };
    startPromise = new Promise((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
    // Avoid unhandled rejection while the async WebSocket factory initializes.
    startPromise.catch(() => {});
    startTimer = setTimeout(() => { fail('Live session startup timed out'); }, startTimeoutMs);
    startTimer.unref?.();
    try {
      const factory = webSocketFactory || ((url, options) => import('ws').then(({ default: WS }) => new WS(url, options)));
      socket = await factory('wss://api.openai.com/v1/live/sessions', { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` } });
      if (mine !== generation || current.state !== 'starting') { socket.terminate?.(); return startPromise; }
      const thisSocket = socket;
      socket.on('open', () => {
        if (socket !== thisSocket || current.state !== 'starting') return;
        send({ type: 'session.start', session: {
          model: 'gpt-live-1', instructions:safeVoiceText(instructions),
          input: [],
          audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: 'cinder' } },
          store: false,
        } });
      });
      socket.on('message', data => {
        if (socket !== thisSocket) return;
        let event;
        try { event = JSON.parse(data.toString()); } catch { return fail('Invalid Live event received'); }
        if (event.type === 'session.started') {
          if (current.state !== 'starting') { send({ type: 'session.close' }); return; }
          clearTimeout(startTimer);
          current.sessionId = event.session?.id || null; current.startedAt = Date.now();
          speech('live_connected', { prewarm: warm });
          if (warm) {
            // Pre-warm: connected, but no audio devices, no prompt, nothing spoken. start({welcomePrompt}) promotes it.
            current.state = 'warm'; current.active = false; warmSince = now();
            warmTimer = setTimeout(() => { void stop('warm session unused'); }, warmMaxMs); warmTimer.unref?.();
            emit({ type: 'linux_live.warm', sessionId: current.sessionId });
            resolveStart?.(status()); resolveStart = rejectStart = null;
            return;
          }
          if (!activate(welcomeText)) return;
          resolveStart?.(status()); resolveStart = rejectStart = null;
        } else if (event.type === 'session.output_audio.delta' && current.state === 'active') {
          if (current.muted) return;
          const bytes = Buffer.from(event.delta || '', 'base64');
          if (audio.writableLength() > 480000) return fail('Linux playback stalled');
          audio.write(bytes); current.outputBytes += bytes.length; noteAssistant({ bytes: bytes.length });
        } else if (['session.input_transcript.delta', 'session.output_transcript.delta'].includes(event.type)) {
          const transcript = { session_id: current.sessionId, received_at: new Date(now()).toISOString(), role: event.type.includes('input_') ? 'user' : 'assistant', text: event.delta || '', delta: event.delta || '', start_ms: event.start_ms, end_ms: event.end_ms };
          current.transcripts.push(transcript); current.transcripts = current.transcripts.slice(-40);
          try { onTranscript(transcript); } catch {}
          if (transcript.text) { if (transcript.role === 'assistant') noteAssistant({ text: transcript.text }); else noteUser(); }
        } else if (event.type === 'session.closed') {
          current.usage = event.usage || null; if (Number.isFinite(current.usage?.seconds)) { finalUsageSeen = true; reportUsage(current.usage.seconds, false); } finalize(current.error);
        } else if (event.type === 'session.usage.updated') {
          current.usage = event.usage || null;
          if (Number.isFinite(current.usage?.seconds)) reportUsage(current.usage.seconds, false);
          emit({ type: event.type, usage: current.usage });
        } else if (event.type === 'error') {
          // Codes/types are diagnostic identifiers. Never surface API messages/content.
          const safeIdentifier = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(value) && !value.includes(env.OPENAI_API_KEY) ? value : null;
          current.apiError = { code: safeIdentifier(event.error?.code), type: safeIdentifier(event.error?.type) };
          emit({ type: 'linux_live.api_error', ...current.apiError });
          fail('Live API rejected a command; session stopping');
        } else {
          // VAD / turn boundaries, when the API reports them (names are matched loosely; the gap timers cover the rest).
          const type = String(event.type || '');
          if (/speech_started|input_audio\.(?:speech_)?start/.test(type)) noteUser('start');
          else if (/speech_stopped|input_audio\.(?:speech_)?(?:stop|end)/.test(type)) noteUser('end');
          emit({ type: event.type });
        }
      });
      socket.on('error', () => { if (socket === thisSocket) { thisSocket.terminate?.(); finalize('Live connection failed'); } });
      socket.on('close', () => { if (socket === thisSocket) finalize('Live connection closed without final usage'); });
    } catch { finalize('Live WebSocket initialization failed'); }
    return startPromise;
  };
  return { start, prewarm: opts => start({ ...opts, prewarm: true }), stop, setMuted, updateContext, sendPrompt, instruct, rearmPrompts, status };
}
