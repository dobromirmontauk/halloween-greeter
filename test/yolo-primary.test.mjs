// YOLO + zones is the presence source of truth (PRESENCE_RESOLVER=primary, the default); the Judge only does costume/motion on PATH.
// Synthetic data only: fake detector sidecar, fake Decisions API, 4-byte JPEGs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPersonDetector,presenceResolver,locate,analyze,readZonesFile,DEFAULT_ZONES_FILE} from '../src/presence/person-detector.mjs';
import {createJudgeEvents} from '../src/presence/judge-events.mjs';
import {createPresenceTracker,signedDistance} from '../src/presence/presence-tracker.mjs';
import {createServer} from '../server.mjs';
import {judgeAnswer} from './judge-fixtures.mjs';

const jpeg=Buffer.from([255,216,255,217]);
const zones=readZonesFile(DEFAULT_ZONES_FILE).zones;
function fakeSpawn(reply){
 return ()=>{
  const child=new EventEmitter();child.stdout=new EventEmitter();child.kill=()=>{};
  child.stdin={on(){},end(){},write(line){const req=JSON.parse(line);if(req.cmd==='shutdown')return;const r=reply(req);if(r===null)return;setImmediate(()=>child.stdout.emit('data',Buffer.from(JSON.stringify({id:req.id,ok:true,...r})+'\n')));}};
  setImmediate(()=>child.stdout.emit('data',Buffer.from('{"ready":true}\n')));return child;
 };
}
const waitFor=async(fn,ms=16000)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw Error('timeout');await new Promise(r=>setTimeout(r,25));}};
const BOX={porch:[0.45,0.5,0.55,0.95],path:[0.5,0.55,0.56,0.7],sidewalk:[0.46,0.1,0.5,0.2]};
const person=(bbox,score=0.9)=>({bbox,score});
// The fake Decisions API records which judge each request addresses.
const judgeFetch=(calls,{count='1',location='path'}={})=>async(url,opts)=>{
 const body=JSON.parse(opts.body),names=body.questions.map(q=>q.name);
 calls.push(names.includes('real_people_count')?'presence':names.includes('person_1_motion')?'motion':'costume');
 await new Promise(r=>setTimeout(r,30));
 return {ok:true,json:async()=>judgeAnswer(body,{count,location,people:[{motion:'present',face:'yes',location}],costumes:['witch']})};
};
async function run({env={},persons=[],reply,spawn=true,calls=[]},body){
 const dir=mkdtempSync(join(tmpdir(),'yp-'));
 const server=createServer({env:{CAMERA_URL:'rtsp://x/stream',OPENAI_API_KEY:'test',AUTO_START:'true',DEBUG_SPEAK:'true',DETECTOR_FPS:'15',JUDGE_LOG_DIR:join(dir,'log'),...env},captureImpl:async()=>jpeg,fetchImpl:judgeFetch(calls),
  detectorSpawnImpl:spawn?fakeSpawn(reply||(()=>({persons,ms:4,width:960,height:540}))):undefined});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const status=async()=>(await fetch(base+'/api/judge/status')).json();
 try{return await body({base,status,calls,dir});}
 finally{await server.stopAutomation();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
}

test('primary is the default resolver; DETECTOR_MODE=shadow keeps the old tiebreak',()=>{
 assert.equal(presenceResolver({}),'primary');
 assert.equal(presenceResolver({DETECTOR_MODE:'shadow'}),'tiebreak');
 assert.equal(presenceResolver({PRESENCE_RESOLVER:'judge'}),'judge');
});

// (a)
test('primary: no presence Judge call happens, count and location come from the zones',async()=>{
 const calls=[];
 await run({persons:[person(BOX.sidewalk)],calls},async({status})=>{
  const s=await waitFor(async()=>{const x=await status();return x.group_state==='SIDEWALK'&&x;});
  assert.equal(s.visitor_count,1);assert.equal(s.visitor_location,'sidewalk');assert.equal(s.last_read.presence_source,'detector');
  await new Promise(r=>setTimeout(r,2500));
  assert.deepEqual(calls,[],'no Judge call at all for sidewalk people');
 });
});

// (b)
test('costume Judge (and motion) fire only once the group is on the PATH',async()=>{
 const sidewalkCalls=[];
 await run({persons:[person(BOX.sidewalk)],calls:sidewalkCalls},async({status})=>{
  await waitFor(async()=>(await status()).group_state==='SIDEWALK');await new Promise(r=>setTimeout(r,2500));
  assert.deepEqual(sidewalkCalls,[]);
 });
 const pathCalls=[];
 await run({persons:[person(BOX.path)],calls:pathCalls},async({status})=>{
  const s=await waitFor(async()=>{const x=await status();return x.group_state==='PATH'&&pathCalls.includes('costume')&&x;});
  assert.equal(s.last_read.presence_source,'detector');assert.equal(pathCalls.includes('presence'),false);
 });
});

// (c)
test('detector stale or down: falls back to the Judge presence path, and says so',async()=>{
 const calls=[];let stall=false;
 await run({calls,reply:()=>stall?null:{persons:[person(BOX.sidewalk)],ms:4,width:960,height:540},env:{DETECTOR_STALE_MS:'600'}},async({base,status})=>{
  await waitFor(async()=>(await status()).last_read?.presence_source==='detector');
  assert.equal((await(await fetch(base+'/api/detector/status')).json()).presence_source,'detector');
  stall=true; // the sidecar stops answering: no frame for > DETECTOR_STALE_MS
  const s=await waitFor(async()=>{const x=await status();return x.last_read?.presence_source==='judge'&&x;},20000).catch(async e=>{console.log(JSON.stringify(await(await fetch(base+'/api/detector/status')).json()).slice(0,900),JSON.stringify((await status()).last_read).slice(0,300));throw e;});
  assert.ok(s.last_read.presence_fallback);assert.ok(calls.includes('presence'));
  const d=await(await fetch(base+'/api/detector/status')).json();
  assert.equal(d.presence_source,'judge_fallback');assert.equal(d.fallback.active,true);assert.equal(d.fallback.reason,'stale');
 });
 const calls2=[];
 await run({spawn:false,env:{DETECTOR:'off'},calls:calls2},async({base,status})=>{
  const s=await waitFor(async()=>{const x=await status();return x.last_read?.presence_source==='judge'&&x;});
  assert.ok(calls2.includes('presence'));assert.equal(s.last_read.presence_fallback,'disabled');
  assert.equal((await(await fetch(base+'/api/detector/status')).json()).fallback.active,true);
 });
});

// (d)
test('DATA_CAPTURE triggers on detector count, not on a Judge presence read',async()=>{
 for(const [persons,expectClip] of [[[person(BOX.sidewalk)],true],[[],false]]){
  const dir=mkdtempSync(join(tmpdir(),'ypcap-')),calls=[];
  const server=createServer({env:{CAMERA_URL:'rtsp://x/stream',OPENAI_API_KEY:'test',AUDIO_MODE:'linux',START_MODE:'DATA_CAPTURE',DETECTOR_FPS:'15',CAPTURE_DIR:join(dir,'caps'),CAPTURE_MIN_FREE_GB:'0',MODE_FILE:join(dir,'mode.json'),SESSIONS_DIR:join(dir,'s'),JUDGE_LOG:'false'},
   captureImpl:async()=>jpeg,fetchImpl:judgeFetch(calls),detectorSpawnImpl:fakeSpawn(()=>({persons,ms:4,width:960,height:540}))});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  try{
   if(expectClip){
    const detail=await waitFor(async()=>{const l=await(await fetch(base+'/api/captures')).json();const c=l.clips[0];if(!c)return null;const d=await(await fetch(base+'/api/captures/'+c.clip_id)).json();return d.judge?.some(j=>j.judge==='presence'&&j.presence_source==='detector')&&d;});
    assert.equal(detail.judge.find(j=>j.presence_source==='detector').detector_count,1);assert.ok(detail.frames.length>=1);
   }else{
    await new Promise(r=>setTimeout(r,3000));
    assert.equal((await(await fetch(base+'/api/captures')).json()).clips.length,0,'no people: no clip');
   }
   assert.deepEqual(calls.filter(c=>c==='presence'),[],'the Judge never made a presence read');
  }finally{await server.stopAutomation();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
 }
});

// (e)
test('zone boundary: a foot at y=0.27 is sidewalk, y=0.35 on the path is path, the old 0.26 mouth is not path',()=>{
 const at=(x,y)=>locate([x-0.02,y-0.2,x+0.02,y],zones).zone;
 assert.equal(at(0.66,0.27),'sidewalk');
 assert.equal(at(0.66,0.35),'path');
 assert.equal(at(0.66,0.26),'sidewalk');
 assert.equal(at(0.66,0.299),'sidewalk');
 const path=zones.find(z=>z.kind==='path'),top=Math.min(...path.points.map(p=>p[1]));
 assert.ok(Math.abs(top-0.30)<1e-9,'path top edge is y=0.30');
});

test('presence cutoff: scores under 0.5 never count (kept as weak), at 0.5 they do',()=>{
 const raw={persons:[{bbox:BOX.path,score:0.45},{bbox:BOX.porch,score:0.5}]};
 const r=analyze(raw,{zones,minScore:0.5});
 assert.equal(r.count,1);assert.equal(r.weak.length,1);assert.equal(r.location,'porch');
 const d=createPersonDetector({env:{},spawnImpl:fakeSpawn(()=>({})),zonesFile:null});
 assert.equal(d.status().presence_score,0.5);d.stop();
});

test('detector reads commit a group-state change on one read; Judge reads still need two',()=>{
 const ev=createJudgeEvents({now:()=>0});
 ev.feed({visitor_count:1,visitor_location:'path',presence_source:'detector'});assert.equal(ev.status().group_state,'PATH');
 const j=createJudgeEvents({now:()=>0});
 j.feed({visitor_count:1,visitor_location:'path'});assert.equal(j.status().group_state,'EMPTY');j.feed({visitor_count:1,visitor_location:'path'});assert.equal(j.status().group_state,'PATH');
});

// Synthetic 4 fps sequences through the tracker. frames: array of person lists; returns the state transitions.
function drive(frames,opts={}){
 const tr=createPresenceTracker(opts),changes=[];let prev='EMPTY',t=0;
 for(const persons of frames){const r=tr.update(persons,t,zones);if(r.state!==prev){changes.push([prev+'>'+r.state,t]);prev=r.state;}t+=250;}
 return changes;
}
const walker=i=>[person([0.40+i*0.004,0.1,0.44+i*0.004,0.2])]; // foot on the sidewalk strip

test('tracker: a sidewalk walker with alternating 1-frame dropouts enters SIDEWALK once and exits EMPTY once, never flapping',()=>{
 const frames=[];
 for(let i=0;i<24;i++)frames.push(i%2?[]:walker(i));
 for(let i=0;i<40;i++)frames.push([]);
 const changes=drive(frames);
 assert.deepEqual(changes.map(c=>c[0]),['EMPTY>SIDEWALK','SIDEWALK>EMPTY']);
 assert.ok(changes[0][1]>=1000&&changes[0][1]<=1500,'enters after about 1 s: '+changes[0][1]);
 assert.ok(changes[1][1]-5750>=3000,'exits only after the 3 s no-one window plus the 1 s track memory: '+changes[1][1]);
});

test('tracker: a foot oscillating +-0.01 at the path border never toggles PATH',()=>{
 const frames=[];for(let i=0;i<60;i++)frames.push([person([0.64,0.1,0.68,i%2?0.31:0.29])]);
 const changes=drive(frames);
 assert.equal(changes.some(c=>c[0].endsWith('>PATH')),false,JSON.stringify(changes));
 assert.deepEqual(changes.map(c=>c[0]),['EMPTY>SIDEWALK'],'a sidewalk presence, nothing else');
});

test('tracker: a real path arrival commits PATH within 1 s; leaving needs 1.5 s without anyone on the path',()=>{
 const frames=[];for(let i=0;i<8;i++)frames.push([person([0.60,0.3,0.64,0.5])]);
 for(let i=0;i<12;i++)frames.push([person([0.46,0.1,0.5,0.2])]); // steps back to the sidewalk
 const changes=drive(frames);
 assert.equal(changes[0][0],'EMPTY>PATH');assert.ok(changes[0][1]<=1000,'PATH at '+changes[0][1]);
 assert.equal(changes[1][0],'PATH>SIDEWALK');assert.ok(changes[1][1]-2000>=1500,'left path after '+(changes[1][1]-2000)+' ms');
});

test('tracker: track memory bridges a 1 s gap but not a longer one; border hysteresis uses ZONE_MARGIN',()=>{
 const tr=createPresenceTracker({});
 tr.update([person(BOX.sidewalk)],0,zones);
 assert.equal(tr.update([],900,zones).tracks,1);
 assert.equal(tr.update([],1100,zones).tracks,0);
 assert.ok(signedDistance([0.66,0.31],zones.find(z=>z.kind==='path').points)>0&&signedDistance([0.66,0.31],zones.find(z=>z.kind==='path').points)<0.02);
});
