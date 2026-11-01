import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTranscriptStore, groupTranscriptEvents } from '../src/visits/transcript-store.mjs';

test('text fragments persist in order across reload, group into readable turns, and omit media', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'halloween-transcript-'));
  try {
    const store = createTranscriptStore({ directory });
    const event = (role, text, start_ms, end_ms) => ({ session_id: 'live_test', received_at: '2026-10-25T10:00:00Z', role, text, start_ms, end_ms, audio: 'NEVER_SAVE_AUDIO', image: 'NEVER_SAVE_IMAGE' });
    await Promise.all([store.append(event('assistant', 'What are', 0, 100)), store.append(event('assistant', ' YOU supposed to be?', 100, 500)), store.append(event('user', 'A pirate!', 900, 1200)), store.append(event('assistant', 'Aye.', 1300, 1600))]);
    const reloaded = createTranscriptStore({ directory });
    const session = await reloaded.readSession('live_test');
    assert.equal(session.events.length, 4);
    assert.deepEqual(session.turns.map(x => [x.role, x.text]), [['assistant', 'What are YOU supposed to be?'], ['user', 'A pirate!'], ['assistant', 'Aye.']]);
    assert.deepEqual((await reloaded.listSessions()).map(x => [x.session_id, x.event_count]), [['live_test', 4]]);
    const disk = await readFile(join(directory, 'live_test.jsonl'), 'utf8');
    assert.doesNotMatch(disk, /NEVER_SAVE|audio|image/); assert.deepEqual(await readdir(directory), ['live_test.jsonl']);
    assert.throws(() => store.append({ ...event('user', 'bad', 0, 1), session_id: '../escape' }), /Invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('grouping retains pauses and session boundaries without inventing transcript spaces', () => {
  const events = [{ session_id: 'one', role: 'user', delta: 'Hello', end_ms: 100 }, { session_id: 'one', role: 'user', delta: ' again', start_ms: 3000 }, { session_id: 'two', role: 'user', text: 'Next guest' }];
  assert.deepEqual(groupTranscriptEvents(events).map(x => x.text), ['Hello', ' again', 'Next guest']);
});
