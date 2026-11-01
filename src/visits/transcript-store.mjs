import { mkdir, appendFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);

// Preserve exact fragment text; transcript events do not mark completed voice turns.
export function groupTranscriptEvents(events, { gapMs = 2000 } = {}) {
  const turns = [];
  for (const event of events) {
    const text = event.text ?? event.delta ?? '';
    if (!text || !['user', 'assistant'].includes(event.role)) continue;
    const previous = turns.at(-1);
    const separated = Number.isFinite(event.start_ms) && Number.isFinite(previous?.end_ms) && event.start_ms - previous.end_ms > gapMs;
    if (previous && previous.role === event.role && previous.session_id === event.session_id && !separated) {
      previous.text += text;
      if (Number.isFinite(event.end_ms)) previous.end_ms = event.end_ms;
      previous.last_received_at = event.received_at;
    } else turns.push({ session_id: event.session_id, role: event.role, text,
      start_ms: event.start_ms, end_ms: event.end_ms, received_at: event.received_at, last_received_at: event.received_at });
  }
  return turns;
}

export function createTranscriptStore({ directory = process.env.TRANSCRIPT_DIR || 'data/transcripts' } = {}) {
  const pending = new Map();
  const filename = id => {
    if (!validId(id)) throw new Error('Invalid transcript session ID');
    return join(directory, `${id}.jsonl`);
  };
  const append = event => {
    const path = filename(event.session_id);
    if (!['user', 'assistant'].includes(event.role) || typeof (event.text ?? event.delta) !== 'string') throw new Error('Expected a transcript text fragment');
    // Whitelist text metadata. Audio bytes, camera frames and arbitrary API fields never reach disk.
    const fragment = { session_id: event.session_id, received_at: event.received_at || new Date().toISOString(),
      role: event.role, text: event.text ?? event.delta,
      start_ms: Number.isFinite(event.start_ms) ? event.start_ms : null,
      end_ms: Number.isFinite(event.end_ms) ? event.end_ms : null };
    const operation = (pending.get(event.session_id) || Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await appendFile(path, `${JSON.stringify(fragment)}\n`, { encoding: 'utf8', mode: 0o600 });
    });
    pending.set(event.session_id, operation);
    // Keep rejected writes observable to the caller without poisoning later appends.
    operation.then(() => { if (pending.get(event.session_id) === operation) pending.delete(event.session_id); }, () => {});
    return operation;
  };
  const readSession = async session_id => {
    const path = filename(session_id);
    await pending.get(session_id);
    const content = await readFile(path, 'utf8');
    const lines = content.split('\n'); const events = [];
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index]) continue;
      try { events.push(JSON.parse(lines[index])); }
      catch (error) {
        // A crash may leave one incomplete trailing append. Preserve all prior fragments.
        if (index !== lines.length - 1) throw error;
      }
    }
    return { session_id, events, turns: groupTranscriptEvents(events) };
  };
  const listSessions = async () => {
    await Promise.all(pending.values());
    let names;
    try { names = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const sessions = [];
    for (const name of names) {
      if (!name.endsWith('.jsonl') || !validId(name.slice(0, -6))) continue;
      const { session_id, events } = await readSession(name.slice(0, -6));
      sessions.push({ session_id, event_count: events.length, started_at: events[0]?.received_at || null, last_at: events.at(-1)?.received_at || null });
    }
    return sessions.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
  };
  return { append, listSessions, readSession };
}
