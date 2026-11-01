// Replay harness: file camera, fake backend through the real server pipeline, scorecards, bulk cost cap, guards, run storage.
// Synthetic data only: a fake clip (stub JPEGs, saved boxes), the scripted fake voice, no network, no real audio devices.
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runReplay,requireConfirm} from '../src/replay/replay-run.mjs';
import {createFileCamera,createReplayAudio} from '../src/replay/replay-media.mjs';
import {scoreRun,aggregate,costumeMention,emptyIntervals} from '../src/replay/replay-score.mjs';
import {runBulk,pickClips} from '../src/replay/replay-bulk.mjs';
import {createReplayManager} from '../src/replay/replay-manager.mjs';
import {listRuns,readRun} from '../src/replay/replay-store.mjs';
import {parseWav,toWav} from '../src/visits/visit-audio.mjs';
import {createVisitRecorder} from '../src/visits/visit-recorder.mjs';
import {createServer} from '../server.mjs';

const jpeg=Buffer.from([255,216,255,217]);
const ZONES=[
  {name:'sidewalk',kind:'sidewalk',points:[[0,0],[1,0],[1,0.3],[0,0.3]]},
  {name:'path',kind:'path',points:[[0,0.3],[1,0.3],[1,0.88],[0,0.88]]},
  {name:'porch',kind:'porch',points:[[0.3,0.88],[0.7,0.88],[0.7,1],[0.3,1]]}];
const zoneOf=y=>y<0.3?'sidewalk':y<0.88?'path':'porch';
// A walker that comes down the sidewalk and path (one saved detection per 250 ms), then stays.
function syntheticClip(visits,{seconds=7,id='20261026-190000-abc123'}={}){
  const dir=join(visits,id);mkdirSync(dir,{recursive:true});
  const dets=[];
  for(let t=0;t<=seconds*1000;t+=250){const k=t/250,y=Math.min(0.8,0.15+Math.max(0,k-4)*0.03);const present=t>=500;
    dets.push({at:0,t,boxes:present?[{b:[0.63,y-0.2,0.69,y],s:0.9,zone:zoneOf(y)}]:[]});}
  const frames=Math.round(seconds*6);
  const meta={version:1,id,fps:6,video_ms:seconds*1000,end_ms:seconds*1000,frame_count:frames,frame_times:Array.from({length:frames},(_,i)=>Math.round(i*1000/6)),zones:ZONES,detections:dets,timeline:[{t:0,state:'EMPTY'},{t:1500,state:'SIDEWALK'},{t:4000,state:'PATH'}],
    speech:[{t:4200,kind:'welcome_sent'},{t:5000,kind:'first_audio_out'},{t:5000,kind:'assistant_turn_start'},{t:7000,kind:'assistant_turn_end',text:'Evening folks'}],
    transcript:[{t:5000,role:'assistant',text:'Evening, folks. Nice witch hat.'}],judge_reads:[{t:4500,judges:{costume:{answers:[{name:'costume_1',choice:'witch',confidence:0.95,accepted:true}]}}}],audio:null};
  writeFileSync(join(dir,'visit.json'),JSON.stringify(meta));writeFileSync(join(dir,'video.mp4'),'stub');
  return {dir,id,meta,frames};
}
const stubFrames=n=>async()=>Array.from({length:n},(_,k)=>({bytes:jpeg,t:Math.round(k*1000/6)}));
const tmp=p=>mkdtempSync(join(tmpdir(),p));

test('file camera publishes frames at their clip timestamps, in order, none skipped',()=>{
  let t=1000;const timers=[],pub=[];
  const cam=createFileCamera({frames:[0,100,300,1500,1600].map(x=>({bytes:Buffer.from([x&255,1]),t:x})),now:()=>t,schedule:(fn,ms)=>{const h={fn,at:t+ms};timers.push(h);return h;},cancel:h=>{if(h)h.dead=true;}});
  cam.subscribe(f=>pub.push([f.at-1000,f.bytes[0]]));cam.start();cam.play(1000);
  assert.deepEqual(pub.map(p=>p[0]),[0],'only the frame due now');
  for(let guard=0;guard<20;guard++){const h=timers.filter(x=>!x.dead&&!x.done).sort((a,b)=>a.at-b.at)[0];if(!h)break;h.done=true;t=Math.max(t,h.at);h.fn();}
  assert.deepEqual(pub.map(p=>p[0]),[0,100,300,1500,1600]);assert.equal(cam.done(),true);
  // a late timer catches up without skipping
  const late=[];t=0;const timers2=[];
  const c2=createFileCamera({frames:[0,100,200].map(x=>({bytes:jpeg,t:x})),now:()=>t,schedule:(fn,ms)=>{timers2.push({fn,at:t+ms});return timers2.at(-1);}});
  c2.subscribe(f=>late.push(f.at));c2.start();c2.play(0);t=250;timers2.at(-1).fn();assert.equal(late.length,3);
});

test('replay audio: pw-record streams the clip mic from the replay clock, pw-play is a sink',async()=>{
  let now=0;const pcm=Buffer.alloc(16000*2);for(let i=0;i<16000;i++)pcm.writeInt16LE(i%100,i*2);
  const got=[];const ra=createReplayAudio({mic:{pcm,rate:16000},tNow:()=>now,chunkMs:5});
  const rec=ra.spawnImpl('pw-record',['--rate','16000','-']);rec.stdout.on('data',b=>got.push(b));
  now=500;await new Promise(r=>setTimeout(r,30));now=1000;await new Promise(r=>setTimeout(r,30));
  const all=Buffer.concat(got);assert.equal(all.length,32000,'one second of 16 kHz s16 from t=0 to t=1000');assert.equal(all.readInt16LE(2*50),50);
  const sunk=[];const play=createReplayAudio({sink:b=>sunk.push(b)}).spawnImpl('pw-play',['-']);play.stdin.write(Buffer.from([1,2]));assert.equal(Buffer.concat(sunk).length,2);
  rec.kill();play.kill();ra.close();
});

test('scorecard metrics on a synthetic run',()=>{
  const speech=[{t:3900,kind:'welcome_sent'},{t:4500,kind:'first_audio_out'},{t:4500,kind:'assistant_turn_start'},{t:6500,kind:'assistant_turn_end',text:'Nice witch hat'},
    {t:6000,kind:'user_speech_start'},{t:6800,kind:'user_speech_end'},{t:9000,kind:'assistant_turn_start'},{t:11000,kind:'assistant_turn_end',text:'bye'},{t:9000,kind:'goodbye_sent'},{t:8000,kind:'live_reconnect'},{t:5000,kind:'assistant_interrupted'}];
  const timeline=[{t:0,state:'EMPTY'},{t:2000,state:'PATH'},{t:10000,state:'EMPTY'}];
  const m=scoreRun({speech,timeline,firstPathT:3000,transcript:[{t:4500,role:'assistant',text:'Nice witch hat. What is your favorite candy?'}],labels:{accepted:['witch'],truth:['pirate']},cost_usd:0.0123456789,endMs:12000});
  assert.equal(m.path_to_welcome_ms,900);assert.equal(m.path_to_first_audio_ms,1500);
  assert.equal(m.spoke_while_empty.count,1);assert.equal(m.spoke_while_empty.seconds,1);
  assert.equal(m.interruptions,1);assert.equal(m.reconnects,1);assert.equal(m.turns,2);assert.equal(m.visitor_turns,1);
  assert.deepEqual(m.costume,{labels:['witch','pirate'],mentioned:['witch'],hit:true});assert.equal(m.goodbye,true);assert.equal(m.cost_usd,0.012346);
  assert.equal(scoreRun({speech:[],timeline:[],labels:{}}).costume.hit,null);
  assert.deepEqual(emptyIntervals(timeline,12000),[[0,2000],[10000,12000]]);
  assert.equal(costumeMention('A fine Witch Hat','witch_hat'.split(',')).hit,true);
  const agg=aggregate([m,{...m,path_to_welcome_ms:1100,spoke_while_empty:{count:0,seconds:0},goodbye:false,costume:{hit:false,labels:['x'],mentioned:[]}}]);
  assert.equal(agg.runs,2);assert.equal(agg.path_to_welcome_ms.mean,1000);assert.equal(agg.spoke_while_empty.runs_with,1);assert.deepEqual(agg.costume_mention,{hits:1,of:2,rate:0.5});assert.deepEqual(agg.goodbye,{yes:1,of:2});
});

test('the confirm flag is required for real backends and real judges; the fake backend needs none',async()=>{
  assert.throws(()=>requireConfirm({backend:'gemini'}),e=>e.code==='CONFIRM_REQUIRED');
  assert.throws(()=>requireConfirm({backend:'openai',judges:'recorded'}),e=>e.code==='CONFIRM_REQUIRED');
  assert.throws(()=>requireConfirm({backend:'fake',judges:'real'}),e=>e.code==='CONFIRM_REQUIRED');
  assert.equal(requireConfirm({backend:'fake',judges:'fake'}),false);assert.equal(requireConfirm({backend:'gemini',confirm:true}),true);
  const visits=tmp('rv-');const c=syntheticClip(visits);
  await assert.rejects(runReplay({visitsDir:visits,clipId:c.id,backend:'gemini',env:{GEMINI_API_KEY:'k'}}),e=>e.code==='CONFIRM_REQUIRED');
  const mgr=createReplayManager({visitsDir:visits,spawnImpl:()=>{throw new Error('must not spawn');}});
  assert.throws(()=>mgr.start({clip:c.id,backend:'openai'}),e=>e.status===400&&e.code==='CONFIRM_REQUIRED');
  assert.throws(()=>mgr.start({clip:c.id,backend:'fake',set:{CAMERA_URL:'x'}}),e=>e.status===400);
  rmSync(visits,{recursive:true,force:true});
});

test('manager: one run at a time, refused while someone is present, kills only its own child',async()=>{
  const visits=tmp('rv-');const c=syntheticClip(visits);let present='Someone is present. Replays run only while the yard is empty.';
  const spawned=[];const spawnImpl=(cmd,args)=>{const p=new EventEmitter();p.stdout=new PassThrough();p.stderr=new PassThrough();p.kill=sig=>{p.killed=sig;queueMicrotask(()=>p.emit('close',null));};spawned.push({cmd,args,p});return p;};
  const mgr=createReplayManager({visitsDir:visits,spawnImpl,canStart:()=>present});
  assert.throws(()=>mgr.start({clip:c.id,backend:'fake'}),e=>e.status===409&&/present/.test(e.message));assert.equal(spawned.length,0);
  present=null;const st=mgr.start({clip:c.id,backend:'fake'});assert.equal(st.state,'running');
  assert.equal(spawned[0].args.includes('--send-recorded-media'),false);
  assert.throws(()=>mgr.start({clip:c.id,backend:'fake'}),e=>e.status===409&&/already/.test(e.message));
  spawned[0].p.stdout.write(JSON.stringify({progress:{t_ms:1000,of_ms:9000}})+'\n');await new Promise(r=>setTimeout(r,10));assert.equal(mgr.status().progress.t_ms,1000);
  mgr.cancel();await new Promise(r=>setTimeout(r,10));assert.equal(spawned[0].p.killed,'SIGTERM');assert.equal(mgr.status().state,'cancelled');
  rmSync(visits,{recursive:true,force:true});
});

test('bulk: the hard cost cap stops the run; the scorecard is saved',async()=>{
  const visits=tmp('rv-');for(const id of ['20261026-190000-aaaaaa','20261026-190100-bbbbbb','20261026-190200-cccccc','20261026-190300-dddddd'])syntheticClip(visits,{id});
  assert.deepEqual(pickClips(visits,'2'),['20261026-190300-dddddd','20261026-190200-cccccc']);assert.equal(pickClips(visits,'all').length,4);
  const calls=[];const cards=tmp('rc-');
  const runImpl=async o=>{calls.push(o);const m=scoreRun({speech:[{t:100,kind:'welcome_sent'}],timeline:[]});return {id:'r'+calls.length,state:'done',cost_usd:0.3,metrics:{...m,cost_usd:0.3},original_metrics:m,errors:[]};};
  const {card,saved}=await runBulk({visitsDir:visits,clips:'all',backend:'gemini',judges:'recorded',confirm:true,maxCostUsd:0.5,runImpl,scorecardDir:cards});
  assert.equal(calls.length,2,'the third clip is never started');assert.equal(card.stopped_reason,'max_cost');assert.ok(Math.abs(card.total_cost_usd-0.6)<1e-9);
  assert.equal(calls[0].maxCostUsd,0.5);assert.ok(Math.abs(calls[1].maxCostUsd-0.2)<1e-9,'each run only gets the remaining budget');
  assert.equal(card.aggregate.runs,2);assert.ok(existsSync(saved.file));assert.equal(JSON.parse(readFileSync(saved.file,'utf8')).stopped_reason,'max_cost');
  await assert.rejects(runBulk({visitsDir:visits,backend:'gemini',confirm:true,runImpl}),/max-cost/);
  await assert.rejects(runBulk({visitsDir:visits,backend:'gemini',maxCostUsd:1,runImpl}),e=>e.code==='CONFIRM_REQUIRED');
  rmSync(visits,{recursive:true,force:true});rmSync(cards,{recursive:true,force:true});
});

test('fake backend replay runs the real pipeline and reproduces the same speech-event ordering every time; runs are deleted with the clip',{timeout:60000},async()=>{
  const visits=tmp('rv-');const c=syntheticClip(visits);
  const go=()=>runReplay({visitsDir:visits,clipId:c.id,backend:'fake',judges:'recorded',detector:'recorded',set:{DETECTOR_FPS:'8',PRIMARY_READ_MS:'250'},tailMs:2500,extractImpl:stubFrames(c.frames),env:{}});
  const a=await go(),b=await go();
  const kinds=r=>r.speech.map(e=>e.kind);
  assert.equal(a.state,'done',JSON.stringify(a.errors));
  for(const k of ['live_start_requested','live_connected','welcome_sent','first_audio_out','assistant_turn_start','assistant_turn_end'])assert.ok(kinds(a).includes(k),k+' in '+kinds(a));
  assert.ok(kinds(a).indexOf('welcome_sent')<kinds(a).indexOf('first_audio_out'));
  assert.deepEqual(kinds(a),kinds(b),'deterministic ordering');
  assert.equal(a.speech.find(e=>e.kind==='welcome_sent').t>=0,true);
  assert.equal(a.transcript[0].role,'assistant');assert.match(a.transcript[0].text,/witch hat/,'the fake voice reuses the clip\'s own assistant lines');
  assert.equal(a.metrics.spoke_while_empty.count,0);assert.ok(a.metrics.path_to_welcome_ms>=0,'welcome after the first path frame: '+a.metrics.path_to_welcome_ms);
  assert.equal(a.cost_usd,0);assert.equal(a.one_sided,true,'clip without audio replays one-sided');
  const wav=parseWav(readFileSync(join(c.dir,'runs',a.id,'assistant.wav')));assert.ok(wav&&wav.pcm.some(x=>x!==0),'assistant audio captured');
  assert.equal(listRuns(c.dir).length,2);assert.equal(readRun(c.dir,a.id).backend,'fake');
  // the run folder is inside the clip, so the recorder's accounting sees it and deleting the clip deletes the runs
  const rec=createVisitRecorder({dir:visits,tickMs:3600000,freeBytes:()=>1e12});
  assert.ok(rec.summary(c.id).size_bytes>wav.pcm.length);assert.equal(rec.summary(c.id).runs,2);
  assert.equal(rec.remove(c.id),true);assert.equal(existsSync(c.dir),false);rec.close();
  rmSync(visits,{recursive:true,force:true});
});

test('HTTP: replay needs the Origin and the confirm flag, is refused while someone is present, and runs/audio are served with Range',{timeout:60000},async()=>{
  const visits=tmp('rv-');const c=syntheticClip(visits);
  const run=join(c.dir,'runs','20261026-191000-fake-aaaa');mkdirSync(run,{recursive:true});
  const pcm=Buffer.alloc(24000*2);for(let i=0;i<24000;i++)pcm.writeInt16LE(Math.round(Math.sin(i/10)*8000),i*2);
  writeFileSync(join(run,'assistant.wav'),toWav(pcm,24000));writeFileSync(join(run,'run.json'),JSON.stringify({id:'20261026-191000-fake-aaaa',backend:'fake',model:'fake-voice',metrics:{turns:1},cost_usd:0,speech:[],transcript:[]}));
  writeFileSync(join(c.dir,'mic.wav'),toWav(pcm.subarray(0,16000),16000));
  const spawned=[];
  const server=createServer({env:{VISIT_DIR:visits,REPLAY_DIR:join(visits,'..','replay-x'),DETECTOR:'off',OPENAI_API_KEY:'k'},replaySpawnImpl:(cmd,args)=>{spawned.push(args);const p=new EventEmitter();p.stdout=new EventEmitter();p.stderr=new EventEmitter();p.kill=()=>{};return p;}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const list=await (await fetch(`${base}/api/visits/${c.id}/runs`)).json();assert.equal(list.runs.length,1);assert.equal(list.runs[0].audio,true);
    const one=await (await fetch(`${base}/api/visits/${c.id}/runs/20261026-191000-fake-aaaa`)).json();assert.equal(one.backend,'fake');
    const part=await fetch(`${base}/api/visits/${c.id}/runs/20261026-191000-fake-aaaa/audio`,{headers:{range:'bytes=0-99'}});assert.equal(part.status,206);assert.equal((await part.arrayBuffer()).byteLength,100);
    const mic=await fetch(`${base}/api/visits/${c.id}/audio/mic`,{headers:{range:'bytes=44-'}});assert.equal(mic.status,206);
    assert.equal((await fetch(`${base}/api/visits/${c.id}/audio/assistant`)).status,404);
    const lv=await (await fetch(`${base}/api/visits/${c.id}/levels?track=assistant&run=20261026-191000-fake-aaaa`)).json();assert.equal(lv.levels.length,10);assert.ok(Math.max(...lv.levels)>5);
    assert.equal((await fetch(`${base}/api/visits/${c.id}/runs/..%2f..`)).status,404);
    const post=(body,origin=base)=>fetch(`${base}/api/visits/${c.id}/replay`,{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(body)});
    assert.equal((await post({backend:'fake'},'http://evil.example')).status,403);
    const noConfirm=await post({backend:'gemini'});assert.equal(noConfirm.status,400);assert.match((await noConfirm.json()).error,/send-recorded-media|confirm/i);
    const ok=await post({backend:'fake'});assert.equal(ok.status,202);assert.equal(spawned.length,1);
    assert.equal((await post({backend:'fake'})).status,409,'one at a time');
    assert.equal((await fetch(`${base}/api/replay/status`).then(r=>r.json())).state,'running');
    assert.equal((await fetch(`${base}/api/visits/${c.id}`,{method:'DELETE',headers:{origin:base}})).status,409,'cannot delete a clip while it is being replayed');
  }finally{await server.stopAutomation();await new Promise(r=>server.close(r));rmSync(visits,{recursive:true,force:true});}
});
