import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readdirSync,existsSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVisitRecorder,visitConfig,ffmpegEncode} from '../src/visits/visit-recorder.mjs';
import {createPresenceTracker,trackerOptions} from '../src/presence/presence-tracker.mjs';
import {analyze} from '../src/presence/person-detector.mjs';
import {replayClip} from '../scripts/visit-eval/lib.mjs';
import {createServer} from '../server.mjs';

const ZONES=[{name:'walk',kind:'sidewalk',points:[[0,0.5],[1,0.5],[1,0.7],[0,0.7]]},{name:'path',kind:'path',points:[[0.3,0.7],[0.7,0.7],[0.7,1],[0.3,1]]}];
const SIDE=[0.1,0.3,0.2,0.6],PATH=[0.45,0.6,0.55,0.9],STREET=[0.1,0.05,0.2,0.2];
const BASE=Date.UTC(2026,9,26,18,0,0);
const jpeg=Buffer.from([255,216,255,217]);

// A harness: fake clock = sim time, preview frames ~6 fps, detector results 4 fps, a real presence tracker.
function harness(over={}){
  const dir=mkdtempSync(join(tmpdir(),'visits-'));let clk=BASE;
  const encodes=[];
  const rec=createVisitRecorder({dir,now:()=>clk,zones:()=>ZONES,encodeImpl:async o=>{encodes.push(o);return {ms:5};},freeBytes:()=>50*1024**3,tickMs:3600000,trackerOptions:()=>trackerOptions({}),...over});
  const tracker=createPresenceTracker(trackerOptions({}));const live=[];let lastState='EMPTY';
  let nextFrame=0,nextDet=0;
  // personAt(t) -> bbox | null; t is ms from `from`
  function run(from,to,personAt){
    for(let t=from;t<to;t+=50){
      clk=BASE+t;
      if(t>=nextFrame){nextFrame=t+166;rec.onFrame({bytes:jpeg,at:BASE+t});}
      if(t>=nextDet){nextDet=t+250;
        const bb=personAt(t),raw={persons:bb?[{bbox:bb,score:0.9}]:[],ms:5};
        const r=analyze(raw,{zones:ZONES,at:BASE+t,minScore:0.5});r.group=tracker.update(r.persons,r.at,ZONES);
        if(r.group.state!==lastState){live.push({at:r.at,state:r.group.state});lastState=r.group.state;}
        rec.onDetect(r);
      }
    }
  }
  return {dir,rec,run,live,encodes,tracker,clock:()=>clk};
}
const finish=async h=>{h.rec.finalizeNow('test');await h.rec.flush();await h.rec.flush();};
const metas=h=>h.rec.list().map(s=>h.rec.get(s.id));

test('no clip is ever created without a person',async()=>{
  const h=harness();h.run(0,30000,()=>null);
  // a person only on the street ("other" zone) or a weak box is not a visit either
  h.run(30000,40000,()=>STREET);await finish(h);
  assert.equal(h.rec.list().length,0);assert.equal(readdirSync(h.dir).length,0);assert.equal(h.rec.status().recording,false);
  h.rec.close();
});

test('pre-roll is included and the clip ends after the post-roll; video holds only the visit window',async()=>{
  const h=harness();
  h.run(0,5000,()=>null);h.run(5000,9000,()=>SIDE);h.run(9000,25000,()=>null);await finish(h);
  const [m]=metas(h);assert.ok(m,'one clip');assert.equal(h.rec.list().length,1);
  assert.equal(m.frame_times[0],0);
  const firstDet=m.detections.find(d=>d.boxes.some(b=>!b.ignored&&!b.weak)),lastDet=[...m.detections].reverse().find(d=>d.boxes.some(b=>!b.ignored&&!b.weak));
  assert.ok(firstDet.t>=2700&&firstDet.t<=3300,'about 3 s of pre-roll before the first person: '+firstDet.t);
  assert.ok(m.video_ms-lastDet.t<=3000+400&&m.video_ms-lastDet.t>=2500,'about 3 s post-roll: '+(m.video_ms-lastDet.t));
  assert.ok(m.end_ms>=m.video_ms);assert.equal(m.max_state,'SIDEWALK');
  // no frame is written beyond the post-roll even though the detector keeps running through the tail
  const total=Math.round((lastDet.t+3000)/166)+3;assert.ok(m.frame_count<=total,`${m.frame_count} frames`);
  assert.equal(h.encodes.length,1);assert.equal(h.encodes[0].frames.length,m.frame_count);
  h.rec.close();
});

test('a visit longer than VISIT_MAX_MS is split into capped clips',async()=>{
  const h=harness({maxMs:5000});h.run(0,14000,()=>SIDE);h.run(14000,30000,()=>null);await finish(h);
  const ms=metas(h).sort((a,b)=>a.start_ms-b.start_ms);
  assert.ok(ms.length>=3,'clips: '+ms.length);
  for(const m of ms)assert.ok(m.video_ms<=5000+400,'capped '+m.video_ms);
  assert.equal(ms[0].end_reason,'max_length');assert.equal(ms[1].continued,true);
  h.rec.close();
});

test('ring buffer keeps the newest VISIT_MAX_CLIPS and evicts the oldest',async()=>{
  assert.equal(visitConfig({}).maxClips,100);assert.equal(visitConfig({VISIT_MAX_GB:'2'}).maxBytes,2*1024**3);
  const h=harness({maxClips:3});
  for(let i=0;i<5;i++){const s=i*40000;h.run(s,s+3000,()=>SIDE);h.run(s+3000,s+40000,()=>null);await h.rec.flush();}
  await finish(h);
  const ids=h.rec.list().map(c=>c.id);assert.equal(ids.length,3);
  const all=[...ids];assert.deepEqual(all,[...all].sort().reverse(),'newest first');
  h.rec.close();
  // the default limit of 100: 105 old directories shrink to 100, oldest first
  const dir=mkdtempSync(join(tmpdir(),'visits100-'));const rec=createVisitRecorder({...visitConfig({}),dir,freeBytes:()=>50*1024**3,tickMs:3600000});
  for(let i=0;i<105;i++){const id=`20261026-${100000+i}-aaaaaa`;mkdirSync(join(dir,id));writeFileSync(join(dir,id,'visit.json'),'{}');}
  assert.equal(readdirSync(dir).length,105);rec.prune();
  const left=readdirSync(dir).sort();assert.equal(left.length,100);assert.ok(left[0]==='20261026-100005-aaaaaa');
  rec.close();
});

test('size cap evicts oldest too',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'visitsgb-'));const rec=createVisitRecorder({dir,maxBytes:1500,freeBytes:()=>50*1024**3,tickMs:3600000});
  for(let i=0;i<4;i++){const id=`20261026-10000${i}-00000${i}`;mkdirSync(join(dir,id));writeFileSync(join(dir,id,'video.mp4'),Buffer.alloc(600));}
  rec.prune();assert.deepEqual(readdirSync(dir).sort(),['20261026-100002-000002','20261026-100003-000003']);rec.close();
});

test('disk guard: no recording below the free-space floor',async()=>{
  const low=harness({freeBytes:()=>1*1024**3,minFreeBytes:3*1024**3});low.run(0,6000,()=>SIDE);await finish(low);
  assert.equal(low.rec.list().length,0);assert.equal(low.rec.status().low_disk,true);assert.ok(low.rec.status().rejected_disk>0);assert.equal(readdirSync(low.dir).length,0);low.rec.close();
  const ok=harness({freeBytes:()=>10*1024**3,minFreeBytes:3*1024**3});ok.run(0,6000,()=>SIDE);ok.run(6000,20000,()=>null);await finish(ok);
  assert.equal(ok.rec.list().length,1);ok.rec.close();
});

test('no recording in app mode OFF or with VISITS=off',async()=>{
  const off=harness({mode:()=>'OFF'});off.run(0,6000,()=>SIDE);await finish(off);assert.equal(off.rec.list().length,0);off.rec.close();
  assert.equal(visitConfig({VISITS:'off'}).enabled,false);
  const dis=harness({enabled:()=>false});dis.run(0,6000,()=>SIDE);await finish(dis);assert.equal(dis.rec.list().length,0);dis.rec.close();
});

test('sidecar timeline equals the live tracker transitions; replay reproduces it deterministically',async()=>{
  const h=harness();
  h.run(0,4000,()=>null);h.run(4000,7000,()=>SIDE);h.run(7000,11000,()=>PATH);h.run(11000,14000,()=>SIDE);h.run(14000,40000,()=>null);await finish(h);
  const [m]=metas(h);assert.equal(h.rec.list().length,1);
  assert.deepEqual(m.timeline.map(e=>e.state),['EMPTY','SIDEWALK','PATH','SIDEWALK','EMPTY']);
  const live=h.live.map(e=>e.state);assert.deepEqual(live,m.timeline.slice(1).map(e=>e.state)); // live list holds the changes after the initial EMPTY
  const origin=h.live[0].at-m.timeline[1].t;
  assert.deepEqual(h.live.map(e=>e.at-origin),m.timeline.slice(1).map(e=>e.t));
  assert.equal(m.max_state,'PATH');assert.ok(m.zones.length===2&&m.commit!==undefined&&m.tuning&&m.tracker.enterPathMs===750);
  const a=replayClip(m),b=replayClip(JSON.parse(JSON.stringify(m)));
  assert.deepEqual(a.map(e=>[e.t,e.state]),m.timeline.map(e=>[e.t,e.state]));assert.deepEqual(a,b);
  assert.notDeepEqual(replayClip(m,{enterPathMs:5000}).map(e=>e.state),m.timeline.map(e=>e.state)); // other tuning changes the outcome
  h.rec.close();
});

test('judge reads during a visit are kept in the sidecar',async()=>{
  const h=harness();h.run(0,4000,()=>SIDE);h.rec.noteRead({at:BASE+3500,judges:{costume:{answers:['pirate']}}});h.run(4000,20000,()=>null);await finish(h);
  const [m]=metas(h);assert.equal(m.judge_reads.length,1);assert.equal(m.judge_reads[0].judges.costume.answers[0],'pirate');assert.ok(m.judge_reads[0].t>=3000);
  h.rec.close();
});

test('files are private and the JPEG spool is deleted after encode',async()=>{
  const h=harness();h.run(0,5000,()=>SIDE);h.run(5000,20000,()=>null);await finish(h);
  const [s]=h.rec.list();const d=join(h.dir,s.id);
  assert.equal(existsSync(join(d,'frames')),false);assert.ok(existsSync(join(d,'video.mp4')));
  const {statSync}=await import('node:fs');
  assert.equal(statSync(d).mode&0o777,0o700);assert.equal(statSync(join(d,'visit.json')).mode&0o777,0o600);
  h.rec.close();
});

test('real ffmpeg encode benchmark (<=300 frames, nice 10, temp files only)',{skip:!existsSync('/opt/homebrew/bin/ffmpeg')&&!existsSync('/usr/bin/ffmpeg')&&!existsSync('/usr/local/bin/ffmpeg')},async()=>{
  const {spawnSync}=await import('node:child_process');
  const dir=mkdtempSync(join(tmpdir(),'visit-bench-'));mkdirSync(join(dir,'frames'));const N=Number(process.env.VISIT_BENCH_FRAMES)||120;
  const gen=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=960x540:rate=6','-frames:v',String(N),'-q:v','5',join(dir,'frames','%06d.jpg')]);
  assert.equal(gen.status,0);
  const frames=readdirSync(join(dir,'frames')).sort().map((name,i)=>({name,t:Math.round(i*1000/6)}));assert.equal(frames.length,N);
  const t0=Date.now(),r=await ffmpegEncode({dir,frames,fps:6,crf:28});
  const {statSync}=await import('node:fs');
  console.log(`encode benchmark: ${N} frames 960x540 -> wall ${r.ms} ms, ffmpeg cpu user ${r.user_s}s sys ${r.sys_s}s, ${statSync(join(dir,'video.mp4')).size} bytes (total ${Date.now()-t0} ms)`);
  assert.ok(statSync(join(dir,'video.mp4')).size>1000);rmSync(dir,{recursive:true,force:true});
});

test('HTTP: list, meta, Range video, frame, DELETE needs Origin',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'visits-http-'));const id='20261026-120000-abcdef',d=join(dir,id);mkdirSync(d,{recursive:true});
  writeFileSync(join(d,'visit.json'),JSON.stringify({id,started_at:'2026-10-26T12:00:00.000Z',end_ms:5000,video_ms:5000,frame_count:3,max_state:'PATH',timeline:[{t:0,state:'EMPTY'}],detections:[],video:'video.mp4'}));
  writeFileSync(join(d,'video.mp4'),Buffer.from('0123456789'));
  const server=createServer({env:{VISIT_DIR:dir,DETECTOR:'off',CAMERA_URL:'rtsp://x/s',OPENAI_API_KEY:'t'}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const list=await (await fetch(base+'/api/visits')).json();assert.equal(list.visits.length,1);assert.equal(list.visits[0].id,id);assert.equal(list.visits[0].max_state,'PATH');assert.equal(list.visits[0].video,true);
    assert.equal((await (await fetch(`${base}/api/visits/${id}/meta`)).json()).max_state,'PATH');
    const full=await fetch(`${base}/api/visits/${id}/video`);assert.equal(full.headers.get('accept-ranges'),'bytes');assert.equal(await full.text(),'0123456789');
    const part=await fetch(`${base}/api/visits/${id}/video`,{headers:{Range:'bytes=2-4'}});assert.equal(part.status,206);assert.equal(part.headers.get('content-range'),'bytes 2-4/10');assert.equal(await part.text(),'234');
    assert.equal((await fetch(`${base}/api/visits/${id}/video`,{headers:{Range:'bytes=50-'}})).status,416);
    assert.equal((await fetch(`${base}/api/visits/nope/meta`)).status,404);
    assert.equal((await fetch(`${base}/api/visits/${id}/frame?t=x`)).status,400);
    assert.equal((await fetch(`${base}/api/visits/${id}`,{method:'DELETE'})).status,403);
    assert.equal(existsSync(d),true);
    assert.equal((await fetch(`${base}/api/visits/${id}`,{method:'DELETE',headers:{Origin:base}})).status,200);
    assert.equal(existsSync(d),false);
    assert.equal((await fetch(base+'/visits.html')).status,200);assert.equal((await fetch(base+'/visits.js')).status,200);
  }finally{await new Promise(r=>server.close(r));}
});
