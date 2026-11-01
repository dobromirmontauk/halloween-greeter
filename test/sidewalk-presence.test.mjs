import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPersonDetector,analyze,createStaticSuppressor,readZonesFile,DEFAULT_ZONES_FILE} from '../src/presence/person-detector.mjs';
import {createPresenceTracker} from '../src/presence/presence-tracker.mjs';

const zones=readZonesFile(DEFAULT_ZONES_FILE).zones;
const SIDE=[0.37,0.05,0.43,0.18];   // foot (0.40,0.18) in the sidewalk polygon
const PATH=[0.54,0.30,0.62,0.60];   // foot (0.58,0.60) well inside the path
const raw=(...persons)=>({persons,ms:5,width:960,height:540});

test('analyze: a 0.35-0.5 box with its foot on the sidewalk goes to `sidewalk`, never to persons',()=>{
 const r=analyze(raw({bbox:SIDE,score:0.45}),{zones,minScore:0.5,sidewalkScore:0.35});
 assert.equal(r.persons.length,0);assert.equal(r.count,0);assert.equal(r.sidewalk.length,1);assert.equal(r.sidewalk[0].zone,'sidewalk');
 assert.equal(analyze(raw({bbox:SIDE,score:0.34}),{zones,minScore:0.5,sidewalkScore:0.35}).sidewalk.length,0,'below the sidewalk cutoff');
 assert.equal(analyze(raw({bbox:SIDE,score:0.45}),{zones,minScore:0.5}).sidewalk.length,0,'off when no sidewalkScore');
 assert.equal(analyze(raw({bbox:PATH,score:0.45}),{zones,minScore:0.5,sidewalkScore:0.35}).sidewalk.length,0,'path foot is never a sidewalk box');
 const hi=analyze(raw({bbox:SIDE,score:0.6}),{zones,minScore:0.5,sidewalkScore:0.35});
 assert.equal(hi.persons.length,1);assert.equal(hi.sidewalk.length,0,'strong boxes stay ordinary persons');
});

test('analyze: a static weak sidewalk box is masked by the side suppressor',()=>{
 const sup=createStaticSuppressor({staticMs:1000});let r;
 for(const at of [0,500,1500])r=analyze(raw({bbox:SIDE,score:0.4}),{zones,minScore:0.5,sidewalkScore:0.35,sideSuppressor:sup,at});
 assert.equal(r.sidewalk.length,0);
});

test('tracker: weak sidewalk boxes reach SIDEWALK only (no PATH, no count tracks, no crowd)',()=>{
 const tr=createPresenceTracker({});let g;
 for(let t=0;t<=3000;t+=250)g=tr.update([],t,zones,[],[{bbox:SIDE,score:0.45,zone:'sidewalk'}]);
 assert.equal(g.state,'SIDEWALK');assert.equal(g.location,'sidewalk');assert.equal(g.tracks,0);assert.equal(g.motion,null);
 assert.equal(g.crowd.newcomers,0);
 for(let t=3250;t<=9000;t+=250)g=tr.update([],t,zones,[],[]);
 assert.equal(g.state,'EMPTY','falls back to EMPTY after the usual exit time');
});

test('detector end to end: 0.35-0.5 boxes never cause PATH, a welcome location, or a path count',async()=>{
 let t=1e6,boxes=[];
 const sidecar={status:()=>({state:'ready'}),start(){},stop(){},call:async()=>({persons:boxes,ms:5,width:960,height:540})};
 const d=createPersonDetector({env:{DETECTOR_FPS:'15'},sidecar,now:()=>t,zonesFile:DEFAULT_ZONES_FILE});
 assert.equal(d.status().sidewalk_score,0.35);
 // weak on the path / porch / street: nothing at all
 for(const bbox of [PATH,[0.45,0.7,0.55,0.95],[0.05,0.5,0.1,0.9]]){
  boxes=[{bbox,score:0.49}];let r;
  for(let i=0;i<20;i++){t+=250;r=await d.onFrame({bytes:Buffer.from('x'),at:t});}
  assert.equal(r.group.state,'EMPTY');assert.equal(r.count,0);assert.equal(r.group.count,0);
 }
 // weak on the sidewalk: SIDEWALK, never PATH
 boxes=[{bbox:SIDE,score:0.45}];let r,sawPath=false;
 for(let i=0;i<20;i++){t+=250;r=await d.onFrame({bytes:Buffer.from('x'),at:t});if(r.group.state==='PATH'||r.group.location==='path'||r.group.location==='porch')sawPath=true;}
 assert.equal(r.group.state,'SIDEWALK');assert.equal(sawPath,false);assert.equal(r.count,0,'raw persons (the welcome/PATH input) stay empty');
 assert.equal(r.group.motion,null);
 // a 0.49 box on the PATH while the sidewalk box is still weak: still no PATH
 boxes=[{bbox:SIDE,score:0.45},{bbox:PATH,score:0.49}];
 for(let i=0;i<20;i++){t+=250;r=await d.onFrame({bytes:Buffer.from('x'),at:t});}
 assert.notEqual(r.group.state,'PATH');
 // a real >=0.5 path box does reach PATH
 boxes=[{bbox:PATH,score:0.5}];
 for(let i=0;i<20;i++){t+=250;r=await d.onFrame({bytes:Buffer.from('x'),at:t});}
 assert.equal(r.group.state,'PATH');
});

test('SIDEWALK_PRESENCE_SCORE=off disables, and it is clamped below the presence score',()=>{
 const mk=env=>createPersonDetector({env,sidecar:{status:()=>({state:'ready'}),start(){},stop(){},call:async()=>({persons:[]})},zonesFile:null}).status().sidewalk_score;
 assert.equal(mk({SIDEWALK_PRESENCE_SCORE:'off'}),null);
 assert.equal(mk({}),0.35);assert.equal(mk({SIDEWALK_PRESENCE_SCORE:'0.4'}),0.4);
 assert.equal(mk({SIDEWALK_PRESENCE_SCORE:'0.6'}),null,'not below DETECTOR_PRESENCE_SCORE: disabled');
});
