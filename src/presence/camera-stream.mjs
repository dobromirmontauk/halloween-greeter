import { spawn } from 'node:child_process';

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const MAX_BYTES = 8 * 1024 * 1024;
const NATIVE_MAX_BYTES = 24 * 1024 * 1024;

// Width/height from the first SOFn marker of a JPEG (no decoding). Null when not found.
export function jpegSize(bytes) {
  if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = bytes.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

// One RTSP decoder shared by video viewers and all model snapshot consumers.
// Frames exist only in memory. No camera URL or ffmpeg stderr enters public status.
export function createCameraStream({ url, ffmpegPath = 'ffmpeg', fps = 6, rotate = 0,
  spawnImpl = spawn, now = Date.now, restartDelayMs = 500, maxRestartDelayMs = 10000,
  stallTimeoutMs = 15000, killTimeoutMs = 1000, maxFrameBytes = MAX_BYTES,
  // width: scaled width of the preview/judge branch (default 960; changing it changes preview and live judges).
  // nativeFps > 0 adds a second ffmpeg output at the camera's NATIVE resolution (q:v nativeQuality) for the capture store, on fd 3.
  width = 960, nativeFps = 0, nativeQuality = 3 } = {}) {
  width = Math.max(160, Math.min(3840, Math.round(Number(width) / 2) * 2 || 960));
  nativeQuality = Math.max(1, Math.min(10, Number(nativeQuality) || 3));
  const frameLimit = Math.max(4, Math.min(MAX_BYTES, Number(maxFrameBytes) || MAX_BYTES));
  const rate = Math.max(1, Math.min(15, Number(fps) || 6));
  const subscribers = new Set(), waiters = new Set();
  let running = false, child = null, retiring = false, buffer = Buffer.alloc(0), frame = null;
  let restartTimer = null, stallTimer = null, killTimer = null, failures = 0, frames = 0;
  let state = 'stopped', error = null;
  let nativeRate = Math.max(0, Math.min(15, Number(nativeFps) || 0)), nativeFrame = null, nativeFrames = 0, nativeSize = null, nativeBuf = Buffer.alloc(0);
  const nativeSubscribers = new Set();
  const status = () => ({ state, running, connected: Boolean(child && !retiring), fps: rate,
    last_frame_at: frame?.at ?? null, frames, buffered_bytes: buffer.length, width, error,
    native: { enabled: nativeRate > 0, fps: nativeRate, width: nativeSize?.width ?? null, height: nativeSize?.height ?? null, frames: nativeFrames, last_frame_at: nativeFrame?.at ?? null } });
  const latest = () => frame;
  const clearStall = () => { clearTimeout(stallTimer); stallTimer = null; };
  const safeReject = (waiter, message) => {
    clearTimeout(waiter.timer); waiters.delete(waiter); waiter.reject(new Error(message));
  };
  const retire = message => {
    if (!child || retiring) return;
    retiring = true; state = running ? 'reconnecting' : 'stopped'; error = message;
    frame = null; buffer = Buffer.alloc(0); clearStall();
    const victim = child;
    victim.kill('SIGTERM');
    killTimer = setTimeout(() => { if (child === victim) victim.kill('SIGKILL'); }, killTimeoutMs);
    killTimer.unref?.();
  };
  const armStall = () => {
    clearStall();
    if (stallTimeoutMs > 0) {
      stallTimer = setTimeout(() => retire('Camera stream stalled; reconnecting'), stallTimeoutMs);
      stallTimer.unref?.();
    }
  };
  const publish = bytes => {
    frame = { bytes: Buffer.from(bytes), at: now() }; frames++; failures = 0;
    state = 'streaming'; error = null; armStall();
    for (const waiter of waiters) {
      if (now() - frame.at <= waiter.maxAgeMs) {
        clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve(frame);
      }
    }
    for (const subscriber of subscribers) { try { subscriber(frame); } catch {} }
  };
  const parse = chunk => {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    // Refuse an oversized partial frame before allocating an oversized concatenation.
    if (buffer.length + chunk.length > frameLimit) {
      error = 'Camera frame exceeded memory limit'; buffer = Buffer.alloc(0);
      if (chunk.length > frameLimit) { buffer = chunk.at(-1) === 0xff ? Buffer.from([0xff]) : Buffer.alloc(0); return; }
    }
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    while (buffer.length) {
      const start = buffer.indexOf(SOI);
      if (start < 0) { buffer = buffer.at(-1) === 0xff ? Buffer.from([0xff]) : Buffer.alloc(0); return; }
      if (start) buffer = buffer.subarray(start);
      const end = buffer.indexOf(EOI, 2);
      const nextStart = buffer.indexOf(SOI, 2);
      // Resynchronize a truncated frame when the next complete image starts.
      if (nextStart >= 0 && (end < 0 || nextStart < end)) { buffer = buffer.subarray(nextStart); continue; }
      if (end < 0) return;
      publish(buffer.subarray(0, end + 2));
      buffer = buffer.subarray(end + 2);
    }
  };
  // Native-resolution branch: same JPEG framing, separate buffer. ALWAYS drained so a slow consumer cannot stall ffmpeg.
  const parseNative = chunk => {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    if (nativeBuf.length + chunk.length > NATIVE_MAX_BYTES) nativeBuf = Buffer.alloc(0);
    nativeBuf = nativeBuf.length ? Buffer.concat([nativeBuf, chunk]) : chunk;
    while (nativeBuf.length) {
      const start = nativeBuf.indexOf(SOI);
      if (start < 0) { nativeBuf = Buffer.alloc(0); return; }
      if (start) nativeBuf = nativeBuf.subarray(start);
      const end = nativeBuf.indexOf(EOI, 2), nextStart = nativeBuf.indexOf(SOI, 2);
      if (nextStart >= 0 && (end < 0 || nextStart < end)) { nativeBuf = nativeBuf.subarray(nextStart); continue; }
      if (end < 0) return;
      const bytes = Buffer.from(nativeBuf.subarray(0, end + 2)); nativeBuf = nativeBuf.subarray(end + 2);
      nativeSize = jpegSize(bytes) || nativeSize;
      nativeFrame = { bytes, at: now(), width: nativeSize?.width ?? null, height: nativeSize?.height ?? null }; nativeFrames++;
      for (const subscriber of nativeSubscribers) { try { subscriber(nativeFrame); } catch {} }
    }
  };
  const launch = () => {
    restartTimer = null;
    if (!running || child) return;
    state = 'connecting'; retiring = false; buffer = Buffer.alloc(0);
    const rotation = Number(rotate) === 180 ? ['hflip', 'vflip'] : Number(rotate) === 90 ? ['transpose=1'] : Number(rotate) === 270 ? ['transpose=2'] : [];
    const dual = nativeRate > 0;
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-rtsp_transport', 'tcp', '-i', url, '-an',
      ...(dual
        ? ['-filter_complex', `[0:v]${[...rotation, 'split=2[a][b]'].join(',')};[a]fps=${rate},scale=${width}:-2[p];[b]fps=${nativeRate}[n]`,
          '-map', '[p]', '-c:v', 'mjpeg', '-q:v', '6', '-f', 'image2pipe', 'pipe:1',
          '-map', '[n]', '-c:v', 'mjpeg', '-q:v', String(nativeQuality), '-f', 'image2pipe', 'pipe:3']
        : ['-vf', [...rotation, `fps=${rate}`, `scale=${width}:-2`].join(','), '-c:v', 'mjpeg', '-q:v', '6', '-f', 'image2pipe', 'pipe:1'])];
    let process;
    try { process = spawnImpl(ffmpegPath, args, { stdio: dual ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'] }); }
    catch { error = 'Cannot start camera decoder'; scheduleRestart(); return; }
    child = process;
    process.stderr?.resume();
    nativeBuf = Buffer.alloc(0);
    process.stdio?.[3]?.on('data', chunk => { if (child === process && running && !retiring) parseNative(chunk); });
    process.stdout.on('data', chunk => { if (child === process && running && !retiring) parse(chunk); });
    process.on('error', () => { if (child === process) retire('Camera decoder failed; reconnecting'); });
    // Wait for close (all stdio released), never overlap an old and new RTSP session.
    process.on('close', () => {
      if (child !== process) return;
      clearTimeout(killTimer); killTimer = null; clearStall();
      child = null; retiring = false; buffer = Buffer.alloc(0); frame = null;
      if (running) { error = 'Camera connection lost; reconnecting'; scheduleRestart(); }
      else state = 'stopped';
    });
    armStall();
  };
  const scheduleRestart = () => {
    if (!running || restartTimer || child) return;
    state = 'reconnecting';
    const delay = Math.min(maxRestartDelayMs, restartDelayMs * 2 ** Math.min(failures++, 10));
    restartTimer = setTimeout(launch, Math.max(0, delay)); restartTimer.unref?.();
  };
  const start = () => {
    if (running) return status();
    if (typeof url !== 'string' || !url) { state = 'error'; error = 'Camera URL is not configured'; return status(); }
    running = true; error = null; failures = 0;
    if (!child) launch();
    else if (retiring) state = 'reconnecting';
    return status();
  };
  const snapshot = ({ maxAgeMs = 1500, timeoutMs = 12000 } = {}) => {
    if (!running) return Promise.reject(new Error('Camera stream is not running'));
    const age = Math.max(0, Number(maxAgeMs) || 0);
    if (frame && now() - frame.at <= age) return Promise.resolve(frame);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, maxAgeMs: age, timer: null };
      waiter.timer = setTimeout(() => safeReject(waiter, 'Timed out waiting for a fresh camera frame'), Math.max(1, Number(timeoutMs) || 12000));
      waiter.timer.unref?.();
      waiters.add(waiter);
    });
  };
  const subscribe = onFrame => {
    if (typeof onFrame !== 'function') throw new TypeError('Frame callback is required');
    subscribers.add(onFrame); return () => subscribers.delete(onFrame);
  };
  const stop = () => {
    running = false; state = 'stopped';
    clearTimeout(restartTimer); restartTimer = null; clearStall();
    for (const waiter of waiters) safeReject(waiter, 'Camera stream stopped');
    frame = null; buffer = Buffer.alloc(0);
    if (child && !retiring) retire(null);
    return status();
  };
  const subscribeNative = onFrame => {
    if (typeof onFrame !== 'function') throw new TypeError('Frame callback is required');
    nativeSubscribers.add(onFrame); return () => nativeSubscribers.delete(onFrame);
  };
  // Turn the native branch on/off (0 = off). Restarts the decoder once if it is running (a brief reconnect).
  const configureNative = ({ fps = 0, quality } = {}) => {
    const next = Math.max(0, Math.min(15, Number(fps) || 0));
    if (quality) nativeQuality = Math.max(1, Math.min(10, Number(quality) || nativeQuality));
    if (next === nativeRate) return status();
    nativeRate = next; if (!next) { nativeFrame = null; }
    if (child && !retiring) retire('Reconfiguring camera decoder');
    return status();
  };
  return { start, snapshot, subscribe, subscribeNative, latestNative: () => nativeFrame, configureNative, latest, status, stop };
}
