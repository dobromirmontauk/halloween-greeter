import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('every element id app.js looks up exists in index.html', () => {
  const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
  const used = new Set([...js.matchAll(/(?:\$|getElementById)\('([a-z0-9-]+)'\)/g)].map(m => m[1]));
  assert.deepEqual([...used].filter(id => !ids.has(id)), []);
});
