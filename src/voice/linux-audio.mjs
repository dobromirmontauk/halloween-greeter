import { spawn } from 'node:child_process';

// Server-owned Linux audio devices (PipeWire pw-play / pw-record), shared by every voice backend.
// PipeWire treats stdin/stdout '-' as raw audio with explicit format/rate. Never opens a browser microphone.
// isActive(): are the children expected to be running (an unexpected exit is then a failure). onFail(message).
export function createLinuxAudio({ env = process.env, spawnImpl = spawn, inputRate = 24000, outputRate = 24000, isActive = () => true, onFail = () => {}, tap = null } = {}) {
  let capture = null, player = null;
  const killChild = child => {
    if (!child) return;
    child.intentionalStop = true;
    child.stdin?.destroy();
    child.kill('SIGTERM');
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 1000);
    timer.unref?.();
  };
  const child = (command, args, kind) => {
    const c = spawnImpl(command, args, { env, stdio: kind === 'capture' ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'ignore', 'pipe'] });
    c.on('error', () => onFail(`Linux ${kind} could not start (${command})`));
    c.on('exit', () => { if (isActive() && !c.intentionalStop) onFail(`Linux ${kind} exited unexpectedly`); });
    c.stderr?.resume(); // Do not surface device paths or private runtime diagnostics.
    c.stdin?.on('error', () => { if (isActive() && !c.intentionalStop) onFail('Linux playback stream failed'); });
    return c;
  };
  const format = rate => ['--format', 's16', '--rate', String(rate), '--channels', '1'];
  const beginPlayer = () => {
    player = child('pw-play', [...format(outputRate), ...(env.AUDIO_OUTPUT_TARGET ? ['--target', env.AUDIO_OUTPUT_TARGET] : []), '-'], 'playback');
  };
  const beginCapture = onData => {
    capture = child('pw-record', [...format(inputRate), ...(env.AUDIO_INPUT_TARGET ? ['--target', env.AUDIO_INPUT_TARGET] : []), '-'], 'capture');
    capture.stdout.on('data', chunk => { try { tap?.mic?.(chunk); } catch {} onData(chunk); });
  };
  const killPlayer = () => { killChild(player); player = null; try { tap?.flush?.(); } catch {} }; // the speaker queue is dropped: audio not yet played never reaches the room
  const killAll = () => { killChild(capture); killChild(player); capture = player = null; try { tap?.flush?.(); } catch {} };
  return { beginPlayer, beginCapture, killPlayer, killAll, killChild,
    write: bytes => { if (player?.stdin) { try { tap?.out?.(bytes); } catch {} } return player?.stdin?.write(bytes); }, writableLength: () => player?.stdin?.writableLength || 0 };
}
