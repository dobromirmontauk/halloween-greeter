import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync,statSync,mkdtempSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPersonDetector,createStaticSuppressor,analyze,locate,ignoredBy,iou,pointInPolygon,validateZones,readZonesFile,DEFAULT_ZONES_FILE,countLabel} from '../src/presence/person-detector.mjs';
import {createServer} from '../server.mjs';
import {judgeAnswer} from './judge-fixtures.mjs';

const jpeg=Buffer.from([255,216,255,217]);
const here=p=>new URL('../'+p,import.meta.url);
const zones=readZonesFile(DEFAULT_ZONES_FILE).zones;

// A stub child process that speaks the sidecar protocol. reply(req) -> object merged into {id, ok:true}.
function fakeSpawn(reply,{ready=true}={}){
 const calls=[],requests=[];
 const fn=(command,args,options)=>{
  calls.push({command,args,options});
  const child=new EventEmitter();let out;
  child.stdout=new EventEmitter();
  child.kill=()=>{};
  child.stdin={on(){},end(){},write(line){const req=JSON.parse(line);if(req.cmd==='shutdown')return;requests.push(req);setImmediate(()=>child.stdout.emit('data',Buffer.from(JSON.stringify({id:req.id,ok:true,...reply(req)})+'\n')));}};
  out=child;if(ready)setImmediate(()=>child.stdout.emit('data',Buffer.from('{"ready":true}\n')));
  return child;
 };
 return {fn,calls,requests};
}
const waitFor=async(fn,ms=8000)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw Error('timeout');await new Promise(r=>setTimeout(r,25));}};
const person=(bbox,score=0.9)=>({bbox,score});

test('sidecar protocol: JPEG goes out as base64 detect request, boxes come back classified',async()=>{
 const spawn=fakeSpawn(()=>({persons:[person([0.45,0.5,0.55,0.95])],ms:33,width:960,height:540}));
 const d=createPersonDetector({env:{DETECTOR_FPS:'15'},spawnImpl:spawn.fn,zonesFile:null});
 d.start();await waitFor(()=>d.status().state==='ready');
 const r=await d.onFrame({bytes:jpeg,at:5000});
 assert.equal(spawn.calls[0].args[0],'-I');assert.match(spawn.calls[0].args[1],/detector\/detect\.py$/);
 assert.equal(spawn.requests[0].cmd,'detect');assert.equal(spawn.requests[0].jpeg,jpeg.toString('base64'));
 assert.equal(r.count,1);assert.equal(r.location,'porch');assert.equal(r.persons[0].zone,'porch');assert.equal(r.ms,33);
 assert.equal(d.status().latest.count,1);d.stop();
});

test('frames arriving while busy are held as one pending newest frame (older ones superseded, never a queue); OFF app mode skips the detector',async()=>{
 let release;const gate=new Promise(r=>{release=r;});
 const calls=[];const sidecar={status:()=>({state:'ready'}),start(){},stop(){},call:async(cmd,p)=>{calls.push(cmd);await gate;return {persons:[],ms:5};}};
 let mode='ON';let t=0;
 const d=createPersonDetector({env:{DETECTOR_FPS:'15'},sidecar,now:()=>t,mode:()=>mode,zonesFile:null});
 const a=d.onFrame({bytes:jpeg,at:1});t=1000;await d.onFrame({bytes:jpeg,at:2});await d.onFrame({bytes:jpeg,at:3});
 assert.equal(calls.length,1,'later frames wait while the first is in flight');
 assert.equal(d.status().dropped,1,'the older pending frame was superseded');
 release();await a;await new Promise(r=>setTimeout(r,30));assert.equal(calls.length,2,'only the newest pending frame ran afterwards');
 mode='OFF';t=5000;await d.onFrame({bytes:jpeg,at:4});assert.equal(calls.length,2,'OFF mode runs no detection');
});

test('location is the zone containing the bottom-centre of the box; porch beats path beats sidewalk; else other',()=>{
 assert.equal(locate([0.45,0.5,0.55,0.95],zones).zone,'porch');
 assert.equal(locate([0.58,0.30,0.64,0.60],zones).zone,'path','foot (0.61,0.60) is on the walk');
 assert.equal(locate([0.4,0.1,0.5,0.19],zones).zone,'sidewalk');
 assert.equal(locate([0.0,0.0,0.05,0.07],zones).zone,'other','street/driveway');
 // top of the box inside a zone does not matter, only the foot
 assert.equal(locate([0.45,0.7,0.55,0.85],zones).zone,'path');
 const overlap=[{kind:'path',name:'p',points:[[0,0],[1,0],[1,1],[0,1]]},{kind:'porch',name:'q',points:[[0,0],[1,0],[1,1],[0,1]]}];
 assert.equal(locate([0.4,0.4,0.6,0.6],overlap).zone,'porch');
 assert.equal(pointInPolygon([0.5,0.5],[[0,0],[1,0],[1,1],[0,1]]),true);assert.equal(pointInPolygon([1.5,0.5],[[0,0],[1,0],[1,1],[0,1]]),false);
});

test('ignore masks drop detections that mostly overlap a prop zone (IoU>=0.5), not any bottom-centre hit',()=>{
 const saw=zones.find(z=>z.name==='table-saw skeleton');
 const onProp=[0.15,0.5,0.33,0.96],walkingBy=[0.30,0.5,0.50,0.96],footOnly=[0.2,0.2,0.22,0.96];
 assert.equal(ignoredBy(onProp,zones)?.name,saw.name);
 assert.equal(ignoredBy(walkingBy,zones),null,'a person passing the prop is not ignored');
 assert.equal(ignoredBy(footOnly,zones),null,'foot inside the zone alone does not ignore');
 const res=analyze({persons:[person(onProp),person([0.45,0.5,0.55,0.95])]},{zones,at:1});
 assert.equal(res.count,1);assert.equal(res.ignored.length,1);assert.equal(res.ignored[0].ignore_zone,saw.name);assert.equal(res.raw_count,2);
 assert.ok(iou([0,0,1,1],[0,0,1,1])===1&&iou([0,0,0.1,0.1],[0.5,0.5,0.6,0.6])===0);
});

test('static suppression: an unmoving box becomes a prop after N minutes (injected clock) and is listed separately',()=>{
 const MIN=60000;const s=createStaticSuppressor({staticMs:10*MIN,iouMin:0.8,goneMs:20000});
 const box=[0.1,0.1,0.2,0.4],jitter=[0.101,0.1,0.2,0.402];
 let t=0,r;
 for(;t<10*MIN;t+=5000){r=analyze({persons:[person(t%10000?jitter:box)]},{zones:[],suppressor:s,at:t});assert.equal(r.count,1,'person until the threshold at t='+t);}
 r=analyze({persons:[person(box)]},{zones:[],suppressor:s,at:10*MIN});
 assert.equal(r.count,0);assert.equal(r.suppressed.length,1);assert.ok(r.suppressed[0].static_ms>=10*MIN);assert.equal(r.location,'none');
 // it moves: becomes a real person again immediately
 r=analyze({persons:[person([0.5,0.1,0.6,0.4])]},{zones:[],suppressor:s,at:10*MIN+1000});assert.equal(r.count,1);
 // the box returning within the gone window is still the same prop; a different moving person next to it is not suppressed
 r=analyze({persons:[person(box),person([0.7,0.2,0.8,0.5])]},{zones:[],suppressor:s,at:10*MIN+2000});assert.equal(r.count,1);assert.equal(r.suppressed.length,1,'the prop is still the prop (brief occlusion), the walker is a person');
 // configurable N: 0 disables, 1 minute works, and a gap longer than goneMs forgets the track
 const off=createStaticSuppressor({staticMs:0});off.update([box],0);assert.equal(off.update([box],10*MIN)[0].suppressed,false);
 const one=createStaticSuppressor({staticMs:MIN,goneMs:20000});for(let k=0;k<6;k++)one.update([box],k*10000);assert.equal(one.update([box],MIN)[0].suppressed,true);
 assert.equal(one.update([box],MIN+60000)[0].suppressed,false,'unseen for 60 s: track forgotten, clock restarts');
});

test('DETECTOR_STATIC_MIN env sets the suppression window',async()=>{
 const spawn=fakeSpawn(()=>({persons:[person([0.2,0.2,0.3,0.6])],ms:1}));
 let t=0;const d=createPersonDetector({env:{DETECTOR_FPS:'15',DETECTOR_STATIC_MIN:'2'},spawnImpl:spawn.fn,now:()=>t,zonesFile:null});
 assert.equal(d.status().static_minutes,2);d.start();await waitFor(()=>d.status().state==='ready');
 t=1000;const a=await d.onFrame({bytes:jpeg,at:1000});t=1000+120000;const b=await d.onFrame({bytes:jpeg,at:1000+120000});
 assert.equal(a.count,1);assert.equal(b.count,1,'gone window (20 s) passed between samples, so the track restarted');
 d.stop();
});

test('zone validation rejects bad kinds, short or out-of-range polygons and bad names',()=>{
 const ok={zones:[{name:'a',kind:'porch',points:[[0,0],[1,0],[0.5,1]]}]};
 assert.equal(validateZones(ok).zones.length,1);
 const bad=[null,{},{zones:'x'},{zones:[{kind:'lawn',name:'a',points:[[0,0],[1,0],[1,1]]}]},{zones:[{kind:'path',name:'a',points:[[0,0],[1,0]]}]},
  {zones:[{kind:'path',name:'a',points:[[0,0],[1,0],[2,1]]}]},{zones:[{kind:'path',name:'a',points:[[0,0],[1,0],['x',1]]}]},{zones:[{kind:'path',name:'<script>',points:[[0,0],[1,0],[1,1]]}]},
  {zones:[{kind:'ignore',name:'a',min_iou:0,points:[[0,0],[1,0],[1,1]]}]},{zones:Array.from({length:40},()=>ok.zones[0])},{zones:[{kind:'path',name:'a',points:Array.from({length:70},()=>[0.1,0.1])}]}];
 for(const b of bad)assert.throws(()=>validateZones(b),e=>e.status===400,JSON.stringify(b).slice(0,60));
 assert.equal(validateZones({zones:[{kind:'ignore',name:'a',min_iou:0.7,points:[[0,0],[1,0],[1,1]]}]}).zones[0].min_iou,0.7);
 assert.ok(readZonesFile(DEFAULT_ZONES_FILE).zones.length>=6,'shipped defaults validate');
 assert.equal(readZonesFile(DEFAULT_ZONES_FILE).zones.filter(z=>z.kind==='ignore').length,3);
});

test('weights, venv and site zones are gitignored; fetch script pins sha256 and sets 0600',()=>{
 const ignore=readFileSync(here('.gitignore'),'utf8').split('\n').map(l=>l.trim());
 for(const rule of ['detector/models/','detector/.venv/','/data/detector-zones.json','*.onnx','/data/captures/'])assert.ok(ignore.includes(rule),'ignored: '+rule);
 assert.ok(!ignore.includes('detector/zones.default.json'),'default zones are committed');
 const fetchScript=readFileSync(here('detector/fetch-models.sh'),'utf8');
 assert.match(fetchScript,/chmod 600/);assert.equal([...fetchScript.matchAll(/\b[0-9a-f]{64}\b/g)].length,3);assert.match(fetchScript,/0\.1\.1rc0/);
 assert.ok((statSync(here('detector/fetch-models.sh')).mode&0o111)!==0,'fetch script is executable');
});

// ---------- server integration ----------
const startServer=async(env,fetchImpl,extra={})=>{
 const server=createServer({env:{CAMERA_URL:'rtsp://x/stream',OPENAI_API_KEY:'test',AUTO_START:'true',DEBUG_SPEAK:'true',DETECTOR_FPS:'15',...env},captureImpl:async()=>jpeg,fetchImpl,...extra});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));return {server,base:`http://127.0.0.1:${server.address().port}`};
};
const stopServer=async server=>{await server.stopAutomation();await new Promise(r=>server.close(r));};
const two={count:'2',people:[{motion:'arriving',face:'yes'},{motion:'present',face:'yes'}],location:'sidewalk',costumes:['pirate','witch']};
const judgeFetch=(reqs)=>async(url,opts)=>{const body=JSON.parse(opts.body);reqs.push(body);return {ok:true,json:async()=>judgeAnswer(body,two)};};
const names=reqs=>reqs.map(q=>q.questions[0].name);

test('DETECTOR=off never spawns anything and the judges decide exactly as before',async()=>{
 const spawn=fakeSpawn(()=>({persons:[]}));const reqs=[];
 const {server,base}=await startServer({DETECTOR:'off'},judgeFetch(reqs),{detectorSpawnImpl:spawn.fn});
 try{
  const s=await waitFor(async()=>{const x=await(await fetch(base+'/api/judge/status')).json();return x.visitor_count===2&&x;});
  assert.equal(s.visitor_count,2);assert.equal(spawn.calls.length,0);
  const d=await(await fetch(base+'/api/detector/status')).json();assert.equal(d.enabled,false);assert.equal(d.latest,null);
 }finally{await stopServer(server);}
});

test('shadow mode (default) runs the detector next to the judges, changes nothing, and reports agreement',async()=>{
 const spawn=fakeSpawn(()=>({persons:[person([0.45,0.5,0.55,0.95]),person([0.30,0.2,0.36,0.4])],ms:21,width:960,height:540}));const reqs=[];
 const {server,base}=await startServer({DETECTOR_MODE:'shadow'},judgeFetch(reqs),{detectorSpawnImpl:spawn.fn});
 try{
  const s=await waitFor(async()=>{const x=await(await fetch(base+'/api/detector/status')).json();return x.agreement.n>=1&&x;});
  assert.equal(s.mode,'shadow');assert.equal(s.latest.count,2);assert.equal(s.agreement.presence_agree>=1,true);assert.equal(s.agreement.last.judge,2);assert.equal(s.agreement.last.detector,2);
  assert.ok(names(reqs).includes('real_people_count'),'the Presence judge still runs');
  const j=await(await fetch(base+'/api/judge/status')).json();assert.equal(j.visitor_count,2);assert.equal(j.visitor_location,'sidewalk','judge location untouched');
 }finally{await stopServer(server);}
});

test('shadow mode: a detector that disagrees (sees nobody) does not change the judge decision',async()=>{
 const spawn=fakeSpawn(()=>({persons:[],ms:9}));const reqs=[];
 const {server,base}=await startServer({DETECTOR_MODE:'shadow'},judgeFetch(reqs),{detectorSpawnImpl:spawn.fn});
 try{
  const s=await waitFor(async()=>{const x=await(await fetch(base+'/api/detector/status')).json();return x.agreement.judge_only>=1&&x;});
  assert.equal(s.latest.count,0);
  assert.equal((await(await fetch(base+'/api/judge/status')).json()).visitor_count,2);
 }finally{await stopServer(server);}
});

test('primary mode: detector count replaces the Presence judge, which is skipped; zone feeds the location',async()=>{
 const spawn=fakeSpawn(()=>({persons:[person([0.45,0.5,0.55,0.95])],ms:18,width:960,height:540}));const reqs=[];
 const {server,base}=await startServer({DETECTOR_MODE:'primary'},judgeFetch(reqs),{detectorSpawnImpl:spawn.fn});
 try{
  await waitFor(async()=>(await(await fetch(base+'/api/detector/status')).json()).latest);
  const mark=await waitFor(async()=>{const x=await(await fetch(base+'/api/judge/status')).json();return x.last_read&&x.last_read.read_id>=3&&reqs.length;});
  await waitFor(async()=>(await(await fetch(base+'/api/judge/status')).json()).last_read.read_id>=6);
  assert.ok(!names(reqs.slice(mark)).includes('real_people_count'),'no Presence request once the detector is warm');
  assert.ok(names(reqs).includes('costume_1'),'Costume still runs (on PATH entry), gated by the detector count');assert.ok(!names(reqs).some(n=>/person_1_motion/.test(n)),'MOTION_JUDGE is off by default: arriving/leaving come from the YOLO trajectory');
  const j=await(await fetch(base+'/api/judge/status')).json();
  assert.equal(j.visitor_count,1,'detector says one person even though the stub judge would say two');
  assert.equal(j.visitor_location,'porch');
  assert.equal((await(await fetch(base+'/api/detector/status')).json()).primary,true);
 }finally{await stopServer(server);}
});

test('primary mode: a detector count of zero skips Motion and Costume too',async()=>{
 const spawn=fakeSpawn(()=>({persons:[],ms:7}));const reqs=[];
 const {server,base}=await startServer({DETECTOR_MODE:'primary'},judgeFetch(reqs),{detectorSpawnImpl:spawn.fn});
 try{
  await waitFor(async()=>(await(await fetch(base+'/api/detector/status')).json()).latest);
  await waitFor(async()=>(await(await fetch(base+'/api/judge/status')).json()).visitor_count===0);
  const mark=reqs.length,rid=(await(await fetch(base+'/api/judge/status')).json()).last_read.read_id;await waitFor(async()=>(await(await fetch(base+'/api/judge/status')).json()).last_read.read_id>=rid+1,12000);
  assert.deepEqual(reqs.slice(mark).map(q=>q.questions[0].name),[],'no judge calls at all while the detector sees nobody');
 }finally{await stopServer(server);}
});

test('zone API: GET falls back to defaults; POST is origin-checked, validated, saved 0600 and hot-reloaded',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'zones-')),file=join(dir,'sub','detector-zones.json');
 const {server,base}=await startServer({DETECTOR_ZONES_FILE:file,DETECTOR:'off'},async()=>({ok:true,json:async()=>({answers:[]})}));
 try{
  const g=await(await fetch(base+'/api/detector/zones')).json();assert.equal(g.source,'default');assert.equal(g.zones.length,6);
  const body=JSON.stringify({zones:[{name:'Walk',kind:'path',points:[[0.1,0.1],[0.9,0.1],[0.5,0.9]]}]});
  const post=(b,origin=base)=>fetch(base+'/api/detector/zones',{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:b});
  assert.equal((await post(body,'http://evil.example')).status,403);assert.equal((await post(body,null)).status,403);assert.equal(existsSync(file),false);
  assert.equal((await post('{"zones":[{"kind":"lawn","points":[]}]}')).status,400);
  assert.equal((await post('not json')).status,400);
  assert.equal((await post('{"zones":"x"}')).status,400);
  assert.equal((await post('{"zones":['+'{"kind":"path","name":"a","points":[[0,0],[1,0],[1,1]]},'.repeat(40)+'{}]}')).status,400);
  assert.equal(existsSync(file),false,'invalid input never writes');
  const r=await post(body);assert.equal(r.status,200);const saved=await r.json();assert.equal(saved.source,'file');assert.equal(saved.zones[0].name,'Walk');
  assert.equal(statSync(file).mode&0o777,0o600,'zone file is private');assert.equal(statSync(join(dir,'sub')).mode&0o777,0o700);
  assert.equal(JSON.parse(readFileSync(file,'utf8')).zones[0].kind,'path');
  assert.equal((await(await fetch(base+'/api/detector/zones')).json()).zones.length,1);
 }finally{await stopServer(server);}
});

test('SSE feed sends the latest result and the overlay/editor pages are served',async()=>{
 const spawn=fakeSpawn(()=>({persons:[person([0.45,0.5,0.55,0.95])],ms:11,width:960,height:540}));
 const {server,base}=await startServer({},judgeFetch([]),{detectorSpawnImpl:spawn.fn});
 try{
  await waitFor(async()=>(await(await fetch(base+'/api/detector/status')).json()).latest);
  const ac=new AbortController(),res=await fetch(base+'/api/detector/events',{signal:ac.signal});
  assert.match(res.headers.get('content-type'),/text\/event-stream/);
  const reader=res.body.getReader(),chunk=new TextDecoder().decode((await reader.read()).value);
  assert.match(chunk,/^data: \{/);assert.equal(JSON.parse(chunk.slice(6)).persons[0].zone,'porch');
  ac.abort();
  for(const p of ['/zones.html','/zones.js','/overlay.js'])assert.equal((await fetch(base+p)).status,200,p);
  assert.match(readFileSync(here('public/index.html'),'utf8'),/<script type="module" src="\/overlay\.js"><\/script>/);
 }finally{await stopServer(server);}
});

test('countLabel buckets like the Presence judge',()=>{assert.deepEqual([0,1,3,4,5,6,9].map(countLabel),['0','1','3','4_5','4_5','6_plus','6_plus']);});
