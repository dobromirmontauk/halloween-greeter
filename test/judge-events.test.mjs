import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createJudgeEvents} from '../src/presence/judge-events.mjs';
import {createDebugSpeaker} from '../src/voice/debug-speaker.mjs';
import {createServer} from '../server.mjs';

const read=(o={})=>({visitor_count:0,arriving:0,present:0,leaving:0,costume_slots:[],...o,visitor_location:o.visitor_location||((o.visitor_count||0)>0?'path':'none')});
function machine(){let t=0;const m=createJudgeEvents({now:()=>t});const types=[],all=[];const isGroup=x=>/^PEOPLE_ON_/.test(x.type);
 return {m,feed(d,ms=1000){t+=ms;const e=m.feed(d);all.push(...e.map(x=>x.type));types.push(...e.filter(x=>!isGroup(x)).map(x=>x.type));return e;},uncertain(ms=1000){t+=ms;const e=m.feedUncertain();all.push(...e.map(x=>x.type));types.push(...e.filter(x=>!isGroup(x)).map(x=>x.type));return e;},types,all};
}
const slot=(label,confidence=0.95)=>({label,confidence});
const costumes=(...labels)=>read({visitor_count:labels.length,present:labels.length,costume_slots:labels.map(l=>typeof l==='string'?slot(l):l)});

test('NEW_PARTY needs two consecutive reads, re-arms after arriving returns to 0 for two reads',()=>{
 const f=machine();const a=read({visitor_count:2,arriving:2});
 f.feed(a);assert.deepEqual(f.types,[]);f.feed(a);assert.deepEqual(f.types,['NEW_PARTY']);assert.equal(f.m.status().events.find(e=>e.type==='NEW_PARTY').count,2);assert.equal(f.m.status().phrase,'People on path, 2 people.');
 f.feed(a);f.feed(a);assert.equal(f.types.length,1);
 const gone=read({visitor_count:1,present:1});f.feed(gone);f.feed(read({visitor_count:1,arriving:1}));f.feed(a);assert.equal(f.types.length,1,'not re-armed yet');
 f.feed(gone);f.feed(gone);f.feed(a);f.feed(a);assert.deepEqual(f.types,['NEW_PARTY','NEW_PARTY']);
});
test('an uncertain read breaks the debounce streak',()=>{
 const f=machine();const a=read({visitor_count:1,arriving:1});f.feed(a);f.uncertain();f.feed(a);assert.deepEqual(f.types,[]);f.feed(a);assert.deepEqual(f.types,['NEW_PARTY']);
});
test('someone appearing directly at the porch fires NEW_PARTY once; a lingering party does not refire',()=>{
 const f=machine();const p=read({visitor_count:1,present:1});
 f.feed(read());f.feed(p);assert.deepEqual(f.types,[]);f.feed(p);assert.deepEqual(f.types,['NEW_PARTY']);for(let i=0;i<6;i++)f.feed(p);assert.equal(f.types.filter(t=>t==='NEW_PARTY').length,1);
});
test('arriving party that reaches the porch is not announced twice',()=>{
 const f=machine();const a=read({visitor_count:2,arriving:2}),p=read({visitor_count:2,present:2});
 f.feed(a);f.feed(a);for(let i=0;i<6;i++)f.feed(p);assert.deepEqual(f.types,['NEW_PARTY']);
});
test('COSTUMES fires once per party after identical confident labels on two reads; re-arms on NEW_PARTY',()=>{
 const f=machine();
 f.feed(costumes('witch','pirate'));f.feed(costumes('witch','pirate'));
 assert.deepEqual(f.types,['NEW_PARTY','COSTUMES']);assert.deepEqual(f.m.status().last_event.labels,['witch','pirate']);assert.equal(f.m.status().phrase,'Costumes: witch, pirate.');
 for(let i=0;i<4;i++)f.feed(costumes('witch','pirate'));assert.equal(f.types.filter(t=>t==='COSTUMES').length,1);
 // new party re-arms
 f.feed(read({visitor_count:0}));f.feed(read({visitor_count:0}));
 f.feed(read({visitor_count:1,arriving:1,costume_slots:[slot('cat')]}));f.feed(read({visitor_count:1,arriving:1,costume_slots:[slot('cat')]}));
 f.feed(read({visitor_count:1,present:1,costume_slots:[slot('cat')]}));
 assert.equal(f.types.filter(t=>t==='COSTUMES').length,2);
 const g=machine();g.feed(costumes('ghost'));g.feed(costumes('cat'));assert.equal(g.types.includes('COSTUMES'),false,'labels changed');g.feed(costumes('cat'));assert.equal(g.types.includes('COSTUMES'),true);
 const h=machine();h.feed(costumes('ghost',slot('uncertain')));h.feed(costumes('ghost',slot('uncertain')));assert.equal(h.types.includes('COSTUMES'),false);
 const lo=machine();lo.feed(costumes(slot('ghost',0.8)));lo.feed(costumes(slot('ghost',0.8)));assert.equal(lo.types.includes('COSTUMES'),false);
 const o=machine();o.feed(costumes('other_costume'));o.feed(costumes('other_costume'));assert.equal(o.types.includes('COSTUMES'),true);
});
test('COSTUMES waits for all min(count,3) slots',()=>{
 const f=machine();const r=read({visitor_count:5,present:5,costume_slots:[slot('witch'),slot('pirate')]});f.feed(r);f.feed(r);assert.equal(f.types.includes('COSTUMES'),false);
});
test('LEAVING fires after two reads when leaving rises from 0 and re-arms when it returns to 0',()=>{
 const f=machine();const l=read({visitor_count:1,leaving:1});
 f.feed(l);assert.deepEqual(f.types,[]);f.feed(l);assert.deepEqual(f.types,['LEAVING']);assert.equal(f.m.status().phrase,'Party leaving.');
 f.feed(l);f.feed(l);assert.equal(f.types.filter(t=>t==='LEAVING').length,1);f.feed(read({visitor_count:1,present:1}));f.feed(l);f.feed(l);assert.deepEqual(f.types.filter(t=>t==='LEAVING'),['LEAVING','LEAVING']);
});
test('NO_VISITORS needs confident zeros and repeats every five seconds only while it holds',()=>{
 const f=machine();const z=read();
 f.feed(z);assert.deepEqual(f.types,[]);f.feed(z);assert.deepEqual(f.types,['NO_VISITORS']);
 f.feed(z);f.feed(z);f.feed(z);f.feed(z);assert.equal(f.types.length,1);f.feed(z);assert.equal(f.types.length,2,'5s after the first');
 const n=read({arriving:null});f.feed(n);f.feed(n);f.feed(n);f.feed(n);f.feed(n);f.feed(n);assert.equal(f.types.length,2,'null bucket is not a confident zero');
});
test('UNCERTAIN needs two reads and emits at most once per ten seconds',()=>{
 const f=machine();f.uncertain();assert.deepEqual(f.types,[]);f.uncertain();assert.deepEqual(f.types,['UNCERTAIN']);for(let i=0;i<8;i++)f.uncertain();assert.equal(f.types.length,1);f.uncertain();assert.equal(f.types.length,1);f.uncertain();assert.equal(f.types.length,2);assert.equal(f.m.status().phrase,'Count uncertain.');
});
test('status exposes buckets, phrase and a ring of the last 20 events',()=>{
 const f=machine();f.feed(read({visitor_count:1,arriving:1,visitor_location:'sidewalk'}));assert.deepEqual(f.m.status().buckets,{arriving:1,present:0,leaving:0});assert.equal(f.m.status().phrase,null);
 for(let i=0;i<60;i++)f.uncertain(11000);assert.equal(f.m.status().events.length,20);assert.ok(f.m.status().events.every(e=>typeof e.at==='number'&&e.phrase));
});

function spawnFake(){const calls=[],children=[];const fn=(command,args,options)=>{const c=new EventEmitter();calls.push({command,args,options});children.push(c);return c;};return {fn,calls,children};}
test('debug speaker spawns spd-say with an args array and no shell, one at a time with one pending',()=>{
 const s=spawnFake();const sp=createDebugSpeaker({spawnImpl:s.fn});
 const ev=(type,phrase)=>({type,phrase});
 sp.speak({type:'NEW_PARTY',phrase:'New party approaching.',silent:true});assert.equal(s.calls.length,0,'the NEW_PARTY alias is never spoken');sp.speak(ev('PEOPLE_ON_PATH','People on path, 2 people.'));
 assert.deepEqual(s.calls[0].args,['--wait','People on path, 2 people.']);assert.equal(s.calls[0].command,'spd-say');assert.notEqual(s.calls[0].options?.shell,true);
 sp.speak(ev('NO_VISITORS','No visitors.'));assert.equal(sp.status().pending,null,'busy NO_VISITORS repeats are dropped');
 sp.speak(ev('LEAVING','Party leaving.'));sp.speak(ev('COSTUMES','Costumes: witch.'));assert.equal(sp.status().pending,'Costumes: witch.');assert.equal(s.calls.length,1);
 s.children[0].emit('exit',0);assert.equal(s.calls.length,2);assert.equal(s.calls[1].args[1],'Costumes: witch.');
 s.children[1].emit('exit',0);assert.equal(sp.status().speaking,false);assert.equal(sp.status().spoken,2);
});
test('debug speaker records a start failure without crashing',()=>{
 const s=spawnFake();const sp=createDebugSpeaker({spawnImpl:s.fn});sp.speak({type:'LEAVING',phrase:'Party leaving.'});s.children[0].emit('error',new Error('ENOENT'));
 assert.match(sp.status().error,/could not start/);assert.equal(sp.status().speaking,false);
 const t=createDebugSpeaker({spawnImpl:()=>{throw new Error('boom');}});t.speak({type:'LEAVING',phrase:'x'});assert.match(t.status().error,/could not start/);
});

import {judgeAnswer,ans} from './judge-fixtures.mjs';
const jpeg=Buffer.from([255,216,255,217]);
const startServer=async(env,fetchImpl,extra={})=>{
 const server=createServer({env:{CAMERA_URL:'rtsp://x/stream',OPENAI_API_KEY:'test',AUTO_START:'true',DEBUG_SPEAK:'true',...env},captureImpl:async()=>jpeg,fetchImpl,...extra});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));return {server,base:`http://127.0.0.1:${server.address().port}`};
};
const stopServer=async server=>{await server.stopAutomation();await new Promise(r=>server.close(r));};
const waitFor=async(fn,ms=8000)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw Error('timeout');await new Promise(r=>setTimeout(r,50));}};
test('DEBUG_SPEAK never starts Live, speaks event phrases and serves the same phrase on the website API',async()=>{
 const spoken=[];let liveStarts=0,resolveSpoken;const done=new Promise(r=>{resolveSpoken=r;});
 const spawnImpl=(command,args)=>{spoken.push([command,args]);const c=new EventEmitter();setImmediate(()=>c.emit('exit',0));resolveSpoken();return c;};
 const two={count:'2',people:[{motion:'arriving',face:'yes'},{motion:'arriving',face:'yes'}]};
 const {server,base}=await startServer({AUDIO_MODE:'linux'},async(url,opts)=>({ok:true,json:async()=>judgeAnswer(JSON.parse(opts.body),two)}),{speakSpawnImpl:spawnImpl,voiceImpl:{status:()=>({active:false}),start:async()=>{liveStarts++;},stop:async()=>{},updateContext:()=>{}}});
 try{await Promise.race([done,new Promise((_,j)=>setTimeout(()=>j(Error('no speech')),8000))]);
  assert.deepEqual(spoken[0],['spd-say',['--wait','People on path, 2 people.']]);assert.equal(liveStarts,0);
  const status=await(await fetch(base+'/api/judge/status')).json();assert.equal(status.debug_speak,true);assert.equal(status.phrase,'People on path, 2 people.');assert.equal(status.buckets.arriving,2);assert.equal(status.group_state,'PATH');assert.deepEqual(status.events.map(e=>e.type).slice(0,2),['NEW_PARTY','PEOPLE_ON_PATH']);
  assert.equal((await fetch(base+'/api/audio/start',{method:'POST',headers:{Origin:base}})).status,409);assert.equal(liveStarts,0);
 }finally{await stopServer(server);}
});
test('judge status is available with debug speech off and reports it',async()=>{
 const server=createServer({env:{}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const s=await(await fetch(`http://127.0.0.1:${server.address().port}/api/judge/status`)).json();assert.equal(s.debug_speak,false);assert.equal(s.phrase,null);assert.equal(s.speaker,null);}finally{await new Promise(r=>server.close(r));}
});

test('judge status groups the latest read by judge, with per-answer cutoffs, buckets and persons',async()=>{
 const reqs=[];
 const {server,base}=await startServer({},async(url,opts)=>{const body=JSON.parse(opts.body);reqs.push(body);
  const r=judgeAnswer(body,{count:'2',people:[{motion:'arriving',face:'yes'},{motion:'present',face:'yes'}],location:'sidewalk',costumes:['pirate','witch']});
  if(body.questions[0].name==='costume_1')r.answers[0].confidence=0.84;
  if(body.questions[0].name==='person_1_motion')r.answers[3].confidence=0.79; // person_2_motion below cutoff
  return {ok:true,json:async()=>r};});
 try{
  // first read: no previous frame, so Presence then Costume only; second read: all three in parallel
  const s=await waitFor(async()=>{const x=await(await fetch(base+'/api/judge/status')).json();return x.last_read?.judges?.motion?.ran&&x;});
  const r=s.last_read;assert.ok(r.read_id>=2&&r.captured_at&&r.decided_at);assert.equal(r.uncertain,false);
  assert.deepEqual(Object.keys(r.judges).sort(),['costume','motion','presence']);
  for(const j of Object.values(r.judges)){assert.ok(Number.isFinite(j.inference_ms));assert.equal(j.error,null);}
  const by=judge=>Object.fromEntries(r.judges[judge].answers.map(a=>[a.name,a]));
  assert.equal(by('presence').real_people_count.accepted,true);assert.equal(by('costume').costume_1.accepted,false);assert.equal(by('costume').costume_2.accepted,true);
  assert.equal(by('motion').person_1_motion.accepted,true);assert.equal(by('motion').person_2_motion.accepted,false);
  assert.deepEqual(r.buckets,{arriving:1,present:null,leaving:null,unresolved:1,unbucketed:0});
  assert.deepEqual(r.persons.map(p=>[p.n,p.motion,p.face_or_mask_visible]),[[1,'arriving','yes'],[2,'uncertain','yes']]);
  const first=reqs[0];assert.equal(first.questions[0].name,'real_people_count');
  const motion=reqs.find(q=>q.questions[0].name==='person_1_motion');assert.equal(motion.input[0].content.filter(c=>c.type==='input_image').length,2);
 }finally{await stopServer(server);}
});

test('Motion runs after Presence on the first sighting and in parallel once someone was there; Costume pauses after COSTUMES',async()=>{
 const order=[];let presence=0;
 const {server,base}=await startServer({},async(url,opts)=>{const body=JSON.parse(opts.body),name=body.questions[0].name;order.push(name==='real_people_count'?'presence':name==='person_1_motion'?'motion':'costume');
  const count=presence<1&&name==='real_people_count'?'0':'1';if(name==='real_people_count')presence++;
  return {ok:true,json:async()=>judgeAnswer(body,{count,people:[{motion:'arriving',face:'yes'}],costumes:['pirate']})};});
 try{
  await waitFor(()=>order.includes('motion'),12000);
  assert.deepEqual(order.slice(0,2),['presence','presence'],'empty first read runs Presence only');
  assert.deepEqual(order.slice(2,4).sort(),['costume','motion'],'first sighting: Presence, then Motion and Costume once it found someone');
  await waitFor(async()=>(await(await fetch(base+'/api/judge/status')).json()).events.some(e=>e.type==='COSTUMES'),12000);
  const costumes=()=>order.filter(x=>x==='costume').length,before=costumes();
  await new Promise(r=>setTimeout(r,2500));
  assert.ok(costumes()-before<=1,'Costume judge stopped after COSTUMES fired');assert.ok(order.filter(x=>x==='presence').length>=before,'Presence keeps running');
 }finally{await stopServer(server);}
});

test('one failing judge does not block the others and is marked failed',async()=>{
 const {server,base}=await startServer({},async(url,opts)=>{const body=JSON.parse(opts.body);if(body.questions[0].name==='person_1_motion')return {ok:false,status:500,json:async()=>({})};return {ok:true,json:async()=>judgeAnswer(body,{count:'1',costumes:['pirate']})};});
 try{
  const s=await waitFor(async()=>{const x=await(await fetch(base+'/api/judge/status')).json();return x.last_read?.judges?.motion?.error&&x;});
  assert.match(s.last_read.judges.motion.error,/vision request failed|HTTP 500/);assert.equal(s.last_read.judges.presence.error,null);assert.equal(s.last_read.judges.costume.error,null);
  assert.equal(s.last_read.uncertain,false);assert.equal(s.visitor_count,1);assert.equal(s.last_read.buckets.arriving,null);
 }finally{await stopServer(server);}
});

test('Presence failing marks the read uncertain while Costume and Motion do not throw',async()=>{
 const {server,base}=await startServer({},async(url,opts)=>{const body=JSON.parse(opts.body);const r=judgeAnswer(body,{count:'uncertain'});return {ok:true,json:async()=>r};});
 try{const s=await waitFor(async()=>{const x=await(await fetch(base+'/api/judge/status')).json();return x.last_read?.uncertain&&x;});assert.equal(s.last_read.judges.presence.answers[0].accepted,true,'answer accepted by cutoff but the choice itself is uncertain');assert.equal(s.visitor_count,null);}finally{await stopServer(server);}
});

test('the previous and current frames of a motion read are served from memory, only for the last 20 reads',async()=>{
 const {server,base}=await startServer({},async(url,opts)=>({ok:true,json:async()=>judgeAnswer(JSON.parse(opts.body),{count:'1',people:[{motion:'present',face:'yes'}]})}));
 try{
  const s=await waitFor(async()=>{const x=await(await fetch(base+'/api/judge/status')).json();return x.last_read?.judges?.motion?.ran&&x;});
  const id=s.last_read.read_id;
  const now=await fetch(`${base}/api/judge/frame/${id}/now`),prev=await fetch(`${base}/api/judge/frame/${id}/prev`);
  assert.equal(now.status,200);assert.equal(now.headers.get('content-type'),'image/jpeg');assert.equal(prev.status,200);assert.deepEqual(Buffer.from(await prev.arrayBuffer()),jpeg);
  assert.equal((await fetch(`${base}/api/judge/frame/99999/now`)).status,404);assert.equal((await fetch(`${base}/api/judge/frame/${id}/other`)).status,404);
  await waitFor(async()=>{const x=await(await fetch(base+'/api/judge/status')).json();return x.last_read.read_id>=id+22;},60000);
  assert.equal((await fetch(`${base}/api/judge/frame/${id}/now`)).status,404,'evicted after 20 newer reads');
 }finally{await stopServer(server);}
});
test('describeRead marks a failed people count as not accepted',async()=>{
 const {describeRead,parsePresence}=await import('../src/presence/decisions.mjs');const r={answers:[ans('real_people_count','1',0.5)]};
 assert.throws(()=>parsePresence(r),{code:'UNCERTAIN_PEOPLE_COUNT'});assert.equal(describeRead(r)[0].accepted,false);
});
