// Debug STATUS every 5 s + COUNT_CHANGED, debounced group count (no double count from a jumping box), costume cadence, YOLO-trajectory arriving/leaving, MOTION_JUDGE=off.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPresenceTracker} from '../src/presence/presence-tracker.mjs';
import {createJudgeEvents} from '../src/presence/judge-events.mjs';
import {createDebugSpeaker} from '../src/voice/debug-speaker.mjs';
import {readZonesFile,DEFAULT_ZONES_FILE} from '../src/presence/person-detector.mjs';
import {replayClip} from '../scripts/visit-eval/lib.mjs';
import {createServer} from '../server.mjs';
import {judgeAnswer} from './judge-fixtures.mjs';

const zones=readZonesFile(DEFAULT_ZONES_FILE).zones;
const box=(x,y,h=0.2)=>[x-0.03,y-h,x+0.03,y]; // foot = (x,y)
const P=(x,y)=>({bbox:box(x,y),score:0.9});

// ---------- tracker: debounced count ----------
test('one walker whose box jumps (the 182115 pattern) stays count 1 throughout',()=>{
 const tr=createPresenceTracker({}),counts=[];
 let t=0;
 const step=persons=>{t+=250;counts.push(tr.update(persons,t,zones).count);};
 for(let i=0;i<8;i++)step([P(0.62,0.5+i*0.02)]);
 for(let i=0;i<10;i++)step([P(0.40,0.65+i*0.01)]); // box jumps 0.22 sideways: old track held, new track spawns
 for(let i=0;i<6;i++)step([P(0.41,0.75)]);
 assert.deepEqual([...new Set(counts)],[1]);
});
test('a held track never adds to the count while a new box is near it',()=>{
 const tr=createPresenceTracker({});let t=0;
 for(let i=0;i<6;i++){t+=250;tr.update([P(0.6,0.5)],t,zones);}
 t+=250;const x=tr.update([P(0.72,0.5)],t,zones); // 0.12 away: same track (distance gate 0.15)
 assert.equal(x.tracks,1);assert.equal(x.count,1);
});
test('two real walkers give count 2',()=>{
 const tr=createPresenceTracker({});let t=0,g;
 for(let i=0;i<10;i++){t+=250;g=tr.update([P(0.58,0.5+i*0.01),P(0.68,0.45+i*0.01)],t,zones);}
 assert.equal(g.count,2);
});
test('a single-frame second box (flicker) does not change the count',()=>{
 const tr=createPresenceTracker({});let t=0;const counts=[];
 for(let i=0;i<10;i++){t+=250;counts.push(tr.update(i===5?[P(0.6,0.5),P(0.3,0.5)]:[P(0.6,0.5)],t,zones).count);}
 assert.deepEqual([...new Set(counts)],[1]);
});
test('replay of the jump sequence from a saved sidecar gives one PATH state',()=>{
 const dets=[];let t=0;
 for(let i=0;i<30;i++){t+=250;const x=i<12?0.62:0.40,y=0.5+Math.min(i,20)*0.01;dets.push({t,boxes:[{b:box(x,y),s:0.9,zone:'path'}]});}
 const tl=replayClip({detections:dets,zones,tracker:{}});
 assert.equal(tl.at(-1).state,'PATH');
 assert.equal(tl.filter(e=>e.state==='PATH').length,1);
});

// ---------- tracker: motion vector over the last 4 frames ----------
test('4-frame walk toward the porch is arriving with v; the same walk away is leaving; standing is present',()=>{
 const walk=ys=>{const tr=createPresenceTracker({});let last;ys.forEach((y,i)=>{last=[P(0.5,y)];tr.update(last,i*250,zones);});return last[0];};
 const a=walk([0.5,0.54,0.58,0.62]);
 assert.equal(a.dir,'arriving');assert.ok(Math.abs(a.v[1]-0.12)<0.01&&a.v[0]===0,'filtered v ~ raw 0.12: '+a.v);assert.equal(typeof a.track,'number');
 const l=walk([0.8,0.76,0.72,0.68,0.64,0.6,0.56,0.52,0.48]);
 assert.equal(l.dir,'leaving');assert.ok(Math.abs(l.v[1]+0.12)<0.01&&l.v[0]===0);
 const s=walk([0.5,0.5,0.505,0.5]);assert.equal(s.dir,'present');
 const one=createPresenceTracker({}),first=[P(0.5,0.5)];one.update(first,0,zones);assert.equal(first[0].v,null);assert.equal(first[0].dir,'present');
});
test('group motion buckets come from the trajectories of tracks on the path',()=>{
 const tr=createPresenceTracker({});let g;
 for(let i=0;i<5;i++)g=tr.update([P(0.6,0.5+i*0.04)],i*250,zones);
 assert.deepEqual([g.motion.arriving,g.motion.present,g.motion.leaving],[1,0,0]);
 const t2=createPresenceTracker({});for(let i=0;i<9;i++)g=t2.update([P(0.6,0.7-i*0.04)],i*250,zones);
 assert.deepEqual([g.motion.arriving,g.motion.present,g.motion.leaving],[0,0,1]);
});

// ---------- judge-events: STATUS / COUNT_CHANGED ----------
const read=(o={})=>({visitor_count:0,arriving:0,present:0,leaving:0,costume_slots:[],presence_source:'detector',...o,visitor_location:o.visitor_location||((o.visitor_count||0)>0?'path':'none')});
function machine(statusMs=5000){let t=0;const out=[];const m=createJudgeEvents({now:()=>t,statusMs,onEvent:e=>out.push(e)});return {m,out,feed(d,ms=1000){t+=ms;return m.feed(d);}};}
test('STATUS every 5 s while the group is not empty, none while empty; no costume when unknown',()=>{
 const f=machine();
 for(let i=0;i<8;i++)f.feed(read());
 assert.equal(f.out.filter(e=>e.type==='STATUS').length,0);
 for(let i=0;i<16;i++)f.feed(read({visitor_count:1,present:1}));
 const st=f.out.filter(e=>e.type==='STATUS');
 assert.equal(st.length,3);assert.equal(st[0].phrase,'Path, 1 person.');
 assert.deepEqual(st.slice(1).map((e,i)=>e.at-st[i].at),[5000,5000]);
 assert.equal(f.m.status().events.some(e=>e.type==='STATUS'),false,'STATUS is not a stored event');
 for(let i=0;i<12;i++)f.feed(read());
 const n=f.out.filter(e=>e.type==='STATUS').length;for(let i=0;i<12;i++)f.feed(read());
 assert.equal(f.out.filter(e=>e.type==='STATUS').length,n,'none once empty');
});
test('STATUS includes costumes once COSTUMES fired; sidewalk wording; no STATUS when statusMs is 0',()=>{
 const f=machine();const slot={label:'witch',confidence:0.95};
 for(let i=0;i<8;i++)f.feed(read({visitor_count:1,present:1,costume_slots:[slot]}));
 assert.ok(f.out.some(e=>e.type==='COSTUMES'));
 assert.equal(f.out.filter(e=>e.type==='STATUS').at(-1).phrase,'Path, 1 person. Costume: witch.');
 const g=machine();for(let i=0;i<7;i++)g.feed(read({visitor_count:2,visitor_location:'sidewalk'}));
 assert.equal(g.out.find(e=>e.type==='STATUS').phrase,'Sidewalk, 2 people.');
 const off=machine(0);for(let i=0;i<20;i++)off.feed(read({visitor_count:1,present:1}));
 assert.equal(off.out.some(e=>e.type==='STATUS'||e.type==='COUNT_CHANGED'),false);
});
test('COUNT_CHANGED fires immediately when the debounced count changes within a state',()=>{
 const f=machine();
 f.feed(read({visitor_count:1,present:1}));f.feed(read({visitor_count:1,present:1}));
 assert.equal(f.out.some(e=>e.type==='COUNT_CHANGED'),false);
 f.feed(read({visitor_count:2,present:2}));
 const c=f.out.filter(e=>e.type==='COUNT_CHANGED');assert.equal(c.length,1);assert.equal(c[0].count,2);assert.equal(c[0].phrase,'Now 2 people.');
 f.feed(read({visitor_count:2,present:2}));assert.equal(f.out.filter(e=>e.type==='COUNT_CHANGED').length,1);
});
test('a larger group re-arms COSTUMES',()=>{
 const f=machine();const s=l=>({label:l,confidence:0.95});
 for(let i=0;i<3;i++)f.feed(read({visitor_count:1,present:1,costume_slots:[s('witch')]}));
 for(let i=0;i<3;i++)f.feed(read({visitor_count:2,present:2,costume_slots:[s('witch'),s('pirate')]}));
 assert.deepEqual(f.out.filter(e=>e.type==='COSTUMES').map(e=>e.labels),[['witch'],['witch','pirate']]);
});
test('debug speaker drops a stale STATUS while busy but queues COUNT_CHANGED',()=>{
 const sp=createDebugSpeaker({spawnImpl:()=>new EventEmitter()});
 assert.equal(sp.speak({type:'PEOPLE_ON_PATH',phrase:'a'}),true);
 assert.equal(sp.speak({type:'STATUS',phrase:'s'}),false);
 assert.equal(sp.speak({type:'COUNT_CHANGED',phrase:'c'}),true);
});

// ---------- server: costume cadence, MOTION_JUDGE ----------
const jpeg=Buffer.from([255,216,255,217]);
function fakeSpawn(reply){
 return ()=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.kill=()=>{};
  child.stdin={on(){},end(){},write(line){const req=JSON.parse(line);if(req.cmd==='shutdown')return;const r=reply(req);setImmediate(()=>child.stdout.emit('data',Buffer.from(JSON.stringify({id:req.id,ok:true,...r})+'\n')));}};
  setImmediate(()=>child.stdout.emit('data',Buffer.from('{"ready":true}\n')));return child;};
}
const waitFor=async(fn,ms=16000)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw Error('timeout');await new Promise(r=>setTimeout(r,25));}};
async function run(env,body){
 const dir=mkdtempSync(join(tmpdir(),'dsc-')),calls=[];
 const fetchImpl=async(url,opts)=>{const b=JSON.parse(opts.body),names=b.questions.map(q=>q.name);calls.push(names.includes('person_1_motion')?'motion':names.includes('costume_1')?'costume':'presence');
  return {ok:true,json:async()=>judgeAnswer(b,{count:'1',people:[{motion:'present',face:'yes'}],costumes:['witch']})};};
 const server=createServer({env:{CAMERA_URL:'rtsp://x/stream',OPENAI_API_KEY:'test',AUTO_START:'true',DEBUG_SPEAK:'true',DETECTOR_FPS:'15',JUDGE_LOG_DIR:join(dir,'log'),COSTUME_READ_MS:'250',...env},captureImpl:async()=>jpeg,fetchImpl,
  detectorSpawnImpl:fakeSpawn(()=>({persons:[{bbox:box(0.55,0.6),score:0.9}],ms:4,width:960,height:540})),speakSpawnImpl:()=>{const c=new EventEmitter();setImmediate(()=>c.emit('exit',0));return c;}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const status=async()=>(await fetch(base+'/api/judge/status')).json();
 try{return await body({status,calls});}finally{await server.stopAutomation();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
}
test('costume Judge runs on PATH entry, repeats at the cadence, stops after COSTUMES; MOTION_JUDGE=off makes no motion calls',async()=>{
 await run({},async({status,calls})=>{
  await waitFor(async()=>calls.includes('costume'));
  await waitFor(async()=>(await status()).events.some(e=>e.type==='COSTUMES'));
  const n=calls.filter(c=>c==='costume').length;
  await new Promise(r=>setTimeout(r,1500));
  assert.equal(calls.filter(c=>c==='costume').length,n,'no more costume reads once COSTUMES fired');
  assert.equal(calls.includes('motion'),false,'no motion calls with MOTION_JUDGE off');
  assert.equal(calls.includes('presence'),false);
  assert.equal((await status()).visitor_count,1);
  assert.ok(n>=2,'at least two reads were needed for COSTUMES');
 });
});
test('MOTION_JUDGE=on keeps the old motion Judge path',async()=>{
 await run({MOTION_JUDGE:'on'},async({calls})=>{await waitFor(async()=>calls.includes('motion'));});
});
