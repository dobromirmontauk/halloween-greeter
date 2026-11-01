import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {scoreClip,scoreAll,segments,loadTruth,optsFromFlags,gridOpts,replayClip} from '../scripts/visit-eval/lib.mjs';

const TL=a=>a.map(([t,state])=>({t,state}));
const truth=TL([[0,'EMPTY'],[2000,'SIDEWALK'],[6000,'PATH'],[10000,'SIDEWALK'],[12000,'EMPTY']]);
const pred=TL([[0,'EMPTY'],[2500,'SIDEWALK'],[6500,'PATH'],[7500,'SIDEWALK'],[8500,'PATH'],[10500,'SIDEWALK'],[13000,'EMPTY']]);

test('segments cover the clip and merge repeats',()=>{
  assert.deepEqual(segments(TL([[0,'EMPTY'],[1000,'EMPTY'],[3000,'PATH']]),5000),[{from:0,to:3000,state:'EMPTY'},{from:3000,to:5000,state:'PATH'}]);
});

test('score: IoU, precision, recall, latency, flaps and PATH events on a known pair',()=>{
  const r=scoreAll([{clip:'a',end_ms:14000,pred,truth}]);
  // PATH: pred 6500-7500 and 8500-10500 (3000 ms), truth 6000-10000 (4000 ms), overlap 1000+1500 = 2500
  assert.equal(r.states.PATH.pred_s,3);assert.equal(r.states.PATH.truth_s,4);assert.equal(r.states.PATH.overlap_s,2.5);
  assert.equal(r.states.PATH.iou,0.556);assert.equal(r.states.PATH.precision,0.833);assert.equal(r.states.PATH.recall,0.625);
  // latency (signed, + = late): PATH entry +500 exit +500; SIDEWALK entries +500,+500 exits +500,+1000
  assert.deepEqual(r.latency.PATH.entry_ms,{n:1,mean:500,median:500,max:500});assert.deepEqual(r.latency.PATH.exit_ms,{n:1,mean:500,median:500,max:500});
  assert.deepEqual(r.latency.SIDEWALK.entry_ms,{n:2,mean:500,median:500,max:500});assert.deepEqual(r.latency.SIDEWALK.exit_ms,{n:2,mean:750,median:750,max:1000});
  // flaps: the PATH->SIDEWALK at 7500 and SIDEWALK->PATH at 8500 have no truth transition within 2 s
  assert.equal(r.flaps,2);
  // the single truth PATH episode is split into two predicted ones: fragmented, not "exactly one"
  assert.equal(r.path_events.truth,1);assert.equal(r.path_events.fragmented,1);assert.equal(r.path_events.exactly_one,0);assert.equal(r.path_events.recall,0);assert.equal(r.path_events.false_pred,0);
  assert.equal(r.per_clip.length,1);
});

test('score: early detection is negative latency; a missed episode is counted; unsure time is excluded',()=>{
  const t=TL([[0,'EMPTY'],[3000,'PATH'],[6000,'EMPTY'],[8000,'unsure']]);
  const p=TL([[0,'EMPTY'],[2500,'PATH'],[6000,'EMPTY'],[7000,'SIDEWALK'],[7900,'EMPTY']]);
  const r=scoreClip(p,t,10000);
  assert.deepEqual(r.latency.PATH.entry,[-500]);assert.deepEqual(r.latency.PATH.exit,[0]);
  assert.equal(r.latency.SIDEWALK.missed,0);assert.equal(r.known_ms,8000);
  assert.equal(r.per_state.SIDEWALK.pred_ms,900); // the sidewalk burst 7000-7900 is inside known truth (EMPTY): counts as predicted-only
  const miss=scoreClip(TL([[0,'EMPTY']]),t,10000);assert.equal(miss.latency.PATH.missed,1);assert.equal(miss.path_events.missed,1);
});

test('score: a predicted PATH on a sidewalk-only clip is a false PATH',()=>{
  const r=scoreAll([{clip:'s',end_ms:8000,truth:TL([[0,'EMPTY'],[1000,'SIDEWALK'],[6000,'EMPTY']]),pred:TL([[0,'EMPTY'],[1500,'SIDEWALK'],[3000,'PATH'],[4000,'SIDEWALK'],[7000,'EMPTY']])}]);
  assert.equal(r.path_events.false_path_on_sidewalk_only,1);assert.equal(r.path_events.false_pred,1);assert.equal(r.path_events.precision,0);
});

test('truth file parsing, flags to tracker options, sweep grid',()=>{
  const dir=mkdtempSync(join(tmpdir(),'veval-'));const f=join(dir,'truth.ndjson');
  writeFileSync(f,'{"clip":"a","t":2000,"state":"PATH"}\nnot json\n{"clip":"a","t":0,"state":"EMPTY"}\n{"clip":"a","t":5,"state":"bogus"}\n');
  assert.deepEqual(loadTruth(f).get('a'),[{t:0,state:'EMPTY'},{t:2000,state:'PATH'}]);
  assert.deepEqual(optsFromFlags({GROUP_ENTER_MS_PATH:'1200',dir:'x'}),{enterPathMs:1200});
  const g=[...gridOpts()];assert.ok(g.length>100&&g.length<=500);assert.ok(g.every(o=>Object.keys(o).length===5));
});

test('replayClip uses the saved zones and boxes with the real tracker',()=>{
  const zones=[{name:'p',kind:'path',points:[[0.3,0.7],[0.7,0.7],[0.7,1],[0.3,1]]}];
  const dets=[];for(let t=0;t<=10000;t+=250)dets.push({t,boxes:t>=1000&&t<=4000?[{b:[0.45,0.6,0.55,0.9],s:0.9,zone:'path'}]:[]});
  const v={zones,detections:dets,presence_score:0.5};
  assert.deepEqual(replayClip(v).map(e=>e.state),['EMPTY','PATH','EMPTY']);
  assert.deepEqual(replayClip(v,{},0.95).map(e=>e.state),['EMPTY']); // a stricter score cutoff drops the box
  assert.deepEqual(replayClip({...v,detections:dets.map(d=>({...d,boxes:d.boxes.map(b=>({...b,ignored:true}))}))}).map(e=>e.state),['EMPTY']);
});

test('CLI: frames.mjs, score.mjs and replay.mjs run on a saved clip',()=>{
  const dir=mkdtempSync(join(tmpdir(),'veval-cli-'));const id='20261026-120000-abcdef';mkdirSync(join(dir,id));
  const zones=[{name:'p',kind:'path',points:[[0.3,0.7],[0.7,0.7],[0.7,1],[0.3,1]]}];
  const dets=[];for(let t=0;t<=9000;t+=250)dets.push({t,boxes:t>=1000&&t<=5000?[{b:[0.45,0.6,0.55,0.9],s:0.9,zone:'path'}]:[]});
  const meta={id,end_ms:9000,video_ms:5000,timeline:replayClip({zones,detections:dets,presence_score:0.5}),zones,detections:dets,presence_score:0.5};
  writeFileSync(join(dir,id,'visit.json'),JSON.stringify(meta));
  const truth=join(dir,'truth.ndjson');writeFileSync(truth,[[0,'EMPTY'],[1000,'PATH'],[5000,'EMPTY']].map(([t,state])=>JSON.stringify({clip:id,t,state})).join('\n')+'\n');
  const run=(s,...a)=>execFileSync(process.execPath,[new URL('../scripts/visit-eval/'+s,import.meta.url).pathname,'--dir',dir,...a],{encoding:'utf8'});
  const frames=run('frames.mjs','--fps','1').trim().split('\n').map(JSON.parse);assert.equal(frames.length,5);assert.deepEqual(frames[1],{clip:id,t:1000,key:id+'@1000'});
  assert.match(run('score.mjs','--truth',truth),/PATH events: truth 1/);
  assert.match(run('replay.mjs','--truth',truth,'--GROUP_ENTER_MS_PATH=2000'),/Replay vs truth/);
  const sweep=run('replay.mjs','--truth',truth,'--sweep','--top','3');assert.equal(sweep.trim().split('\n').length,3);
});
