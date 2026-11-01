// Presence resolution: the local detector is the tiebreaker for uncertain/errored Judge Presence reads. Synthetic data only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,readdirSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPersonDetector,presenceResolver,detectorPresence,locate,readZonesFile,DEFAULT_ZONES_FILE} from '../src/presence/person-detector.mjs';
import {createServer} from '../server.mjs';
import {judgeAnswer} from './judge-fixtures.mjs';

const jpeg=Buffer.from([255,216,255,217]);
const zones=readZonesFile(DEFAULT_ZONES_FILE).zones;
function fakeSpawn(reply){
 const fn=()=>{
  const child=new EventEmitter();child.stdout=new EventEmitter();child.kill=()=>{};
  child.stdin={on(){},end(){},write(line){const req=JSON.parse(line);if(req.cmd==='shutdown')return;setImmediate(()=>child.stdout.emit('data',Buffer.from(JSON.stringify({id:req.id,ok:true,...reply(req)})+'\n')));}};
  setImmediate(()=>child.stdout.emit('data',Buffer.from('{"ready":true}\n')));return child;
 };
 return {fn};
}
const waitFor=async(fn,ms=16000)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw Error('timeout');await new Promise(r=>setTimeout(r,25));}};
// Boxes whose foot lands in a known zone (checked against the default zones below).
const BOX={porch:[0.45,0.5,0.55,0.95],path:[0.5,0.55,0.56,0.7],sidewalk:[0.46,0.1,0.5,0.2],other:[0.06,0.7,0.12,0.9]};
const person=bbox=>({bbox,score:0.9});
const ans=(name,choice,confidence)=>({type:'choice',name,choice,confidence});
// Presence at the given confidence for `count`; Motion/Costume stay confident.
const judgeFetch=({count='1',conf=0.5,location='sidewalk',fail=false}={},reqs=[])=>async(url,opts)=>{
 const body=JSON.parse(opts.body);reqs.push(body);await new Promise(r=>setTimeout(r,40)); // let the detector finish the frame, as the live stream would
 if(fail&&body.questions.some(q=>q.name==='real_people_count'))return {ok:false,status:500,json:async()=>({})};
 const r=judgeAnswer(body,{count,location,people:[{motion:'present',face:'yes',location}]});
 if(body.questions.some(q=>q.name==='real_people_count'))r.answers=r.answers.map(a=>a.name==='real_people_count'?ans('real_people_count',count,conf):a);
 return {ok:true,json:async()=>r};
};
async function run({env={},judge={},persons=[],spawn=true,extra={}},body){
 const dir=mkdtempSync(join(tmpdir(),'tb-')),reqs=[];
 const server=createServer({env:{CAMERA_URL:'rtsp://x/stream',OPENAI_API_KEY:'test',AUTO_START:'true',DEBUG_SPEAK:'true',DETECTOR_FPS:'15',PRESENCE_RESOLVER:'tiebreak',JUDGE_LOG_DIR:join(dir,'log'),...env},captureImpl:async()=>jpeg,fetchImpl:judgeFetch(judge,reqs),
  detectorSpawnImpl:spawn?fakeSpawn(()=>({persons,ms:5,width:960,height:540})).fn:undefined,...extra});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const status=async()=>(await fetch(base+'/api/judge/status')).json();
 try{return await body({base,status,reqs,dir});}
 finally{await server.stopAutomation();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
}

test('fixture boxes land in the zones the tests claim',()=>{
 for(const k of ['porch','path','sidewalk','other'])assert.equal(locate(BOX[k],zones).zone,k,k);
});

test('resolver flag modes',()=>{
 assert.equal(presenceResolver({}),'primary');assert.equal(presenceResolver({DETECTOR_MODE:'shadow'}),'tiebreak');
 assert.equal(presenceResolver({PRESENCE_RESOLVER:'judge'}),'judge');
 assert.equal(presenceResolver({PRESENCE_RESOLVER:'primary'}),'primary');
 assert.equal(presenceResolver({PRESENCE_RESOLVER:'bogus'}),'primary');
 assert.equal(presenceResolver({DETECTOR_MODE:'primary'}),'primary','legacy DETECTOR_MODE=primary still means primary');
 assert.equal(presenceResolver({DETECTOR_MODE:'primary',PRESENCE_RESOLVER:'judge'}),'judge');
 const d=e=>createPersonDetector({env:e,spawnImpl:fakeSpawn(()=>({})).fn,zonesFile:null});
 assert.deepEqual([d({}).resolver,d({}).mode],['primary','primary']);assert.deepEqual([d({DETECTOR_MODE:'shadow'}).resolver,d({DETECTOR_MODE:'shadow'}).mode],['tiebreak','shadow']);
 assert.deepEqual([d({PRESENCE_RESOLVER:'primary'}).resolver,d({PRESENCE_RESOLVER:'primary'}).mode],['primary','primary']);
 assert.deepEqual([d({DETECTOR_MODE:'primary',PRESENCE_RESOLVER:'judge'}).resolver,d({DETECTOR_MODE:'primary',PRESENCE_RESOLVER:'judge'}).mode],['judge','shadow']);
});

test('detectorPresence: zones map to Judge locations, other is not PATH, stale/none is null',()=>{
 assert.deepEqual(detectorPresence({count:2,gap_ms:10,location:'path'}),{visitor_count:2,count_label:'2',confidence:null,location:'path',location_confidence:null,source:'detector_tiebreak',detector_count:2});
 assert.equal(detectorPresence({count:1,location:'other'}).location,'uncertain');
 assert.equal(detectorPresence({count:0,location:'none'}).location,'none');
 assert.equal(detectorPresence(null),null);
});

test('nearest: returns count and location within 2.5 s, null when stale',async()=>{
 const d=createPersonDetector({env:{DETECTOR_FPS:'15'},spawnImpl:fakeSpawn(()=>({persons:[person(BOX.path)],ms:3})).fn,zonesFile:null});
 d.start();await waitFor(()=>d.status().state==='ready');
 await d.onFrame({bytes:jpeg,at:10000});
 assert.deepEqual(d.nearest({at:10500}),{count:1,gap_ms:500,location:'path'});
 assert.equal(d.nearest({at:13000}),null);d.stop();
});

test('confident Judge passes through unchanged and is source judge; confident-but-detector-zero is only counted',async()=>{
 await run({judge:{count:'1',conf:0.97,location:'sidewalk'},persons:[]},async({base,status})=>{
  const s=await waitFor(async()=>{const x=await status();return x.last_read?.presence_source==='judge'&&x.visitor_count===1&&x;});
  assert.equal(s.visitor_location,'sidewalk');
  const a=await waitFor(async()=>{const x=(await(await fetch(base+'/api/detector/status')).json()).agreement;return x.judge_confident_detector_zero>=1&&x;});
  assert.ok(a.judge_confident_n>=a.judge_confident_detector_zero);
  assert.equal((await status()).visitor_count,1,'the detector never overrides a confident Judge');
 });
});

test('uncertain Judge + detector >= 1: present with the detector count and its zone location',async()=>{
 await run({judge:{conf:0.4},persons:[person(BOX.path),person(BOX.sidewalk)]},async({status})=>{
  const s=await waitFor(async()=>{const x=await status();return x.last_read?.presence_source==='detector_tiebreak'&&x.visitor_count===2&&x;});
  assert.equal(s.visitor_location,'path','zone wins over the Judge answer (sidewalk)');
  assert.equal(s.last_read.detector_count,2);assert.equal(s.last_read.uncertain,true,'the raw Judge uncertainty stays visible');
  assert.match(s.last_read.judges.presence.error,/UNCERTAIN_PEOPLE_COUNT/);
 });
});

test('errored Judge call is tiebroken the same way',async()=>{
 await run({judge:{fail:true},persons:[person(BOX.porch)]},async({status})=>{
  const s=await waitFor(async()=>{const x=await status();return x.last_read?.presence_source==='detector_tiebreak'&&x.visitor_count===1&&x;});
  assert.equal(s.visitor_location,'porch');
 });
});

test('uncertain Judge + detector zero: empty, and the absence timer progresses',async()=>{
 await run({judge:{conf:0.4},persons:[]},async({status})=>{
  const s=await waitFor(async()=>{const x=await status();return x.last_read?.presence_source==='detector_tiebreak'&&x.visitor_count===0&&x.events.some(e=>e.type==='NO_VISITORS')&&x;},24000);
  assert.equal(s.visitor_location,'none');assert.equal(s.last_read.detector_count,0);
  assert.equal(s.group_state,'EMPTY','an uncertain read settled to zero feeds the empty-streak events like a confident zero');
 });
});

test('uncertain Judge + no fresh detector result: uncertain, no vote, as before',async()=>{
 await run({judge:{conf:0.4},spawn:false,env:{DETECTOR:'off'}},async({status})=>{
  const s=await waitFor(async()=>{const x=await status();return x.last_read?.presence_source==='uncertain'&&x;});
  assert.equal(s.visitor_count,null);assert.equal(s.last_read.detector_count,null);
 });
});

test('PRESENCE_RESOLVER=judge keeps the Judge-only behavior even with a detector that sees someone',async()=>{
 await run({env:{PRESENCE_RESOLVER:'judge'},judge:{conf:0.4},persons:[person(BOX.porch)]},async({status,base})=>{
  const s=await waitFor(async()=>{const x=await status();return x.last_read?.presence_source==='uncertain'&&x;});
  assert.equal(s.visitor_count,null);assert.equal((await(await fetch(base+'/api/detector/status')).json()).resolver,'judge');
 });
});

test('events and group state follow the resolved count and zone: other is present but never PATH',async()=>{
 await run({judge:{conf:0.4},persons:[person(BOX.other)]},async({status})=>{
  const s=await waitFor(async()=>{const x=await status();return x.last_read?.presence_source==='detector_tiebreak'&&x.visitor_count===1&&x;});
  assert.equal(s.visitor_location,'uncertain');
  await new Promise(r=>setTimeout(r,2500));
  assert.notEqual((await status()).group_state,'PATH');
 });
 await run({judge:{conf:0.4},persons:[person(BOX.sidewalk)]},async({status})=>{
  const s=await waitFor(async()=>{const x=await status();return x.group_state==='SIDEWALK'&&x;});assert.equal(s.visitor_location,'sidewalk');
 });
 await run({judge:{conf:0.4},persons:[person(BOX.path)]},async({status})=>{
  const s=await waitFor(async()=>{const x=await status();return x.group_state==='PATH'&&x;});assert.equal(s.visitor_count,1);
 });
});

test('Live starts on PATH only when the detector settled the read',async()=>{
 for(const [zone,expectStart] of [['sidewalk',false],['path',true],['other',false]]){
  let active=false,started=false;
  await run({env:{DEBUG_SPEAK:'false',AUDIO_MODE:'linux'},judge:{conf:0.4},persons:[person(BOX[zone])],extra:{voiceImpl:{status:()=>({active}),start:async()=>{active=true;started=true;},updateContext:()=>{},stop:async()=>{active=false;}}}},async({status})=>{
   await waitFor(async()=>(await status()).last_read?.presence_source==='detector_tiebreak');
   if(expectStart)await waitFor(()=>started,16000);else{await new Promise(r=>setTimeout(r,2500));assert.equal(started,false,zone+' never starts Live');}
  });
 }
});

test('presence_source and detector_count are persisted in the judge log',async()=>{
 await run({judge:{conf:0.4},persons:[person(BOX.porch)]},async({status,dir})=>{
  await waitFor(async()=>(await status()).last_read?.presence_source==='detector_tiebreak');
  const entries=await waitFor(()=>{const root=join(dir,'log');if(!existsSync(root))return null;const out=[];for(const day of readdirSync(root)){let files=[];try{files=readdirSync(join(root,day));}catch{continue;}for(const f of files)if(f.endsWith('.json'))try{out.push(JSON.parse(readFileSync(join(root,day,f),'utf8')));}catch{}}return out.some(e=>e.presence_source==='detector_tiebreak')?out:null;});
  const e=entries.find(x=>x.presence_source==='detector_tiebreak');
  assert.equal(e.detector_count,1);assert.equal(e.parsed.visitor_count,1);assert.equal(e.judges.presence.error.code,'UNCERTAIN_PEOPLE_COUNT','the raw Judge error is kept');
 });
});

test('capture judge.jsonl records presence_source and the settled read saves a frame',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tbcap-')),reqs=[];
 const server=createServer({env:{CAMERA_URL:'rtsp://x/stream',OPENAI_API_KEY:'test',AUDIO_MODE:'linux',START_MODE:'DATA_CAPTURE',DETECTOR_FPS:'15',PRESENCE_RESOLVER:'tiebreak',CAPTURE_DIR:join(dir,'caps'),CAPTURE_MIN_FREE_GB:'0',MODE_FILE:join(dir,'mode.json'),SESSIONS_DIR:join(dir,'s'),JUDGE_LOG:'false'},
  captureImpl:async()=>jpeg,fetchImpl:judgeFetch({conf:0.4},reqs),detectorSpawnImpl:fakeSpawn(()=>({persons:[person(BOX.porch)],ms:4,width:960,height:540})).fn});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{
  const detail=await waitFor(async()=>{const l=await(await fetch(base+'/api/captures')).json();const c=l.clips[0];if(!c)return null;const d=await(await fetch(base+'/api/captures/'+c.clip_id)).json();return d.judge?.some(j=>j.judge==='presence'&&j.presence_source==='detector_tiebreak')&&d;});
  const line=detail.judge.find(j=>j.presence_source==='detector_tiebreak');
  assert.equal(line.detector_count,1);assert.ok(detail.frames.length>=1,'a frame was saved for the settled-present read');
 }finally{await server.stopAutomation();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
});
