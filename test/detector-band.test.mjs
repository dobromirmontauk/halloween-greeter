import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPersonDetector,mergeNms,DEFAULT_ZONES_FILE} from '../src/presence/person-detector.mjs';
import {boxesOf} from '../src/visits/visit-recorder.mjs';
import {replayClip} from '../scripts/visit-eval/lib.mjs';

const SIDE=[0.37,0.05,0.43,0.18];   // foot on the sidewalk
const PATH=[0.54,0.30,0.62,0.60];   // foot well inside the path
const flush=()=>new Promise(r=>setImmediate(r));

function rig(env={},{bandBoxes=()=>[],aBoxes=()=>[],gateA=null,gateBand=null}={}){
 let t=1e6;const q=[],calls={a:0,band:0,bandInflight:0,bandMax:0};
 const sidecar={status:()=>({state:'ready'}),start(){},stop(){},call:async()=>{calls.a++;if(gateA)await gateA();return {persons:aBoxes(),ms:5,width:960,height:540};}};
 const bandSidecar={status:()=>({state:'ready'}),start(){},stop(){},call:async(cmd)=>{assert.equal(cmd,'detect_band');calls.band++;calls.bandInflight++;calls.bandMax=Math.max(calls.bandMax,calls.bandInflight);try{if(gateBand)await gateBand();return {persons:bandBoxes(),ms:30,width:2560,height:1440};}finally{calls.bandInflight--;}}};
 const d=createPersonDetector({env:{DETECTOR_FPS:'15',...env},sidecar,bandSidecar,now:()=>t,zonesFile:DEFAULT_ZONES_FILE,schedule:(fn,ms)=>{q.push({fn,ms});return q.length;},cancel:()=>{}});
 return {d,q,calls,tick:ms=>{t+=ms;return t;},now:()=>t};
}
const aFrame=(r)=>r.d.onFrame({bytes:Buffer.from('x'),at:r.now()});
const nFrame=(r)=>r.d.onNativeFrame({bytes:Buffer.from('n'),at:r.now()});
async function runQueued(r){while(r.q.length){const {fn}=r.q.shift();fn();await flush();await flush();}}

test('a band box with its foot on path/porch is ignored for presence (no PATH, no count, no sidewalk)',async()=>{
 const r=rig({},{bandBoxes:()=>[{bbox:PATH,score:0.9},{bbox:[0.45,0.7,0.55,0.95],score:0.9}]});
 let res;
 for(let i=0;i<12;i++){r.tick(250);nFrame(r);await runQueued(r);res=await aFrame(r);}
 assert.equal(res.group.state,'EMPTY');assert.equal(res.count,0);assert.equal(res.group.count,0);assert.equal(res.sidewalk.length,0);
 assert.ok(res.band.every(b=>b.src==='band'),'shown in the overlay as band boxes');
});

test('band sidewalk boxes feed SIDEWALK only: never persons, PATH, count or crowd; marked src band',async()=>{
 const r=rig({},{bandBoxes:()=>[{bbox:SIDE,score:0.4}]});
 let res,sawPath=false;
 for(let i=0;i<24;i++){r.tick(250);nFrame(r);await runQueued(r);res=await aFrame(r);if(res.group.state==='PATH')sawPath=true;}
 assert.equal(res.group.state,'SIDEWALK');assert.equal(sawPath,false);assert.equal(res.count,0);assert.equal(res.persons.length,0);
 assert.equal(res.sidewalk[0].src,'band');assert.equal(res.group.crowd.newcomers,0);assert.equal(res.group.motion,null);
 const st=r.d.status();assert.equal(st.strategy,'preview+band');assert.equal(st.band.enabled,true);assert.ok(st.band.processed>=1);assert.equal(st.band.fps_target,1);
 assert.ok('a_fps' in st&&'duty' in st.band);
});

test('a band box below SIDEWALK_PRESENCE_SCORE does nothing',async()=>{
 const r=rig({},{bandBoxes:()=>[{bbox:SIDE,score:0.3}]});let res;
 for(let i=0;i<24;i++){r.tick(250);nFrame(r);await runQueued(r);res=await aFrame(r);}
 assert.equal(res.group.state,'EMPTY');assert.equal(res.sidewalk.length,0);
});

test('scheduling: one band pass at a time, newest native frame wins, never queued, gap from the previous start',async()=>{
 let release;const gateBand=()=>new Promise(res=>{release=res;});
 const r=rig({},{bandBoxes:()=>[],gateBand});
 nFrame(r);r.q.shift().fn();await flush();assert.equal(r.calls.band,1);
 for(let i=0;i<5;i++){r.tick(10);nFrame(r);}
 assert.equal(r.q.length,0,'nothing is armed while a pass is running');
 release();await flush();await flush();
 assert.equal(r.q.length,1);assert.ok(r.q[0].ms>=900&&r.q[0].ms<=1000,'waits out BAND_FPS=1 from the previous START');
 assert.equal(r.calls.bandMax,1);
});

test('the preview pass has priority: the band waits while it is busy',async()=>{
 let releaseA;const gateA=()=>new Promise(res=>{releaseA=res;});
 const r=rig({},{gateA});
 const a=aFrame(r);await flush();            // preview inference in flight
 nFrame(r);
 assert.equal(r.q.length,1);assert.equal(r.q[0].ms,25);
 r.q.shift().fn();await flush();
 assert.equal(r.calls.band,0,'band did not start while the preview pass was busy');
 assert.equal(r.q.length,1,'re-armed');
 releaseA();await a;await flush();
 await runQueued(r);assert.equal(r.calls.band,1);
});

test('DETECTOR_STRATEGY=preview and BAND_FPS=0 turn the band off; default is preview+band',async()=>{
 for(const env of [{DETECTOR_STRATEGY:'preview'},{BAND_FPS:'0'},{SIDEWALK_PRESENCE_SCORE:'off'}]){
  const r=rig(env);nFrame(r);assert.equal(r.q.length,0);assert.equal(r.d.bandWanted(),false);assert.equal(r.d.status().band.enabled,false);
 }
 const r=rig({});assert.equal(r.d.strategy,'preview+band');assert.equal(r.d.bandWanted(),true);assert.equal(r.d.bandFps(),1);
 assert.equal(rig({BAND_FPS:'2'}).d.bandFps(),2);
});

test('without an injected band sidecar tests never spawn a second process',()=>{
 let spawned=0;const mk=()=>{spawned++;const e={on(){},stdout:{on(){}},stdin:{on(){},write(){},end(){}},kill(){}};return e;};
 const d=createPersonDetector({env:{},spawnImpl:mk,zonesFile:null});d.start();d.stop();
 assert.equal(spawned,1);
});

test('mergeNms keeps the strongest of overlapping boxes',()=>{
 const m=mergeNms([{bbox:[0.4,0.1,0.44,0.2],score:0.4,src:'band'},{bbox:[0.401,0.1,0.441,0.2],score:0.45},{bbox:[0.7,0.1,0.74,0.2],score:0.36,src:'band'}]);
 assert.deepEqual(m.map(b=>b.score),[0.45,0.36]);
});

test('visit sidecar marks band boxes src:band weak (never counted); replay feeds them only as sidewalk',()=>{
 const boxes=boxesOf({persons:[],band:[{bbox:SIDE,score:0.6,zone:'sidewalk'}]});
 assert.deepEqual([boxes[0].weak,boxes[0].src],[true,'band']);
 const detections=[];for(let t=0;t<=3000;t+=250)detections.push({t,boxes:[{b:SIDE,s:0.6,zone:'sidewalk',weak:true,src:'band'}]});
 const tl=replayClip({detections,zones:JSON.parse(JSON.stringify(zonesDoc()))});
 assert.deepEqual(tl.map(x=>x.state),['EMPTY','SIDEWALK']);
});

import {readFileSync} from 'node:fs';
function zonesDoc(){return JSON.parse(readFileSync(DEFAULT_ZONES_FILE,'utf8')).zones;}
