import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mergeTurns,turnsOfMeta,turnSegments,runRow,audioPlan,needsConfirm,confirmText} from '../public/visit-runs.js';

test('every id visits.js looks up exists in visits.html; visit-runs.js is served',()=>{
  const js=readFileSync(new URL('../public/visits.js',import.meta.url),'utf8'),html=readFileSync(new URL('../public/visits.html',import.meta.url),'utf8');
  const ids=new Set([...html.matchAll(/id="([^"]+)"/g)].map(m=>m[1]));
  const used=new Set([...js.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map(m=>m[1]));
  assert.deepEqual([...used].filter(i=>!ids.has(i)),[]);
  assert.match(readFileSync(new URL('../server.mjs',import.meta.url),'utf8'),/'\/visit-runs\.js'/);
});
test('transcript turns, lane segments, run rows, audio plan, confirm rules',()=>{
  const turns=mergeTurns([{t:1000,role:'assistant',text:'Hello '},{t:1500,role:'assistant',text:'there.'},{t:5000,role:'user',text:'Hi!'},{t:9000,role:'assistant',text:'Bye'}]);
  assert.deepEqual(turns.map(t=>[t.role,t.text]),[['assistant','Hello there.'],['user','Hi!'],['assistant','Bye']]);
  const seg=turnSegments(turns,12000);assert.ok(seg.every((s,i)=>s.end>s.t&&(!seg[i+1]||s.end<=seg[i+1].t)));
  assert.deepEqual(turnsOfMeta({speech:[{t:3,kind:'assistant_turn_end',text:'x'}]}).map(t=>t.text),['x']);assert.equal(turnsOfMeta({transcript:[{t:1,role:'user',text:'a'}]})[0].role,'user');
  assert.match(runRow({backend:'gemini',model:'gemini-3.8-live',judges:'recorded',metrics:{path_to_welcome_ms:1200,path_to_first_audio_ms:1900,turns:3},cost_usd:0.04}),/welcome 1\.2s.*audio 1\.9s.*3 turns.*\$0\.040/);
  assert.deepEqual(audioPlan('both','C','R',true),{mic:'/api/visits/C/audio/mic',asst:'/api/visits/C/runs/R/audio'});assert.deepEqual(audioPlan('none','C',null,true),{mic:null,asst:null});
  assert.equal(needsConfirm('fake','fake'),false);assert.equal(needsConfirm('fake','real'),true);assert.equal(needsConfirm('gemini','recorded'),true);assert.match(confirmText('gemini'),/Google/);
});
