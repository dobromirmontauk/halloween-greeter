// Simulated visitor for replays (scripted kid with local TTS), conversation.wav, and the nudge / visitor lanes of /visits.html. Fake TTS, fake backend, no network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVisitor,pickReply,ttsAvailable,mixPcm,mulberry32} from '../src/replay/replay-visitor.mjs';
import {createReplayAudio} from '../src/replay/replay-media.mjs';
import {runReplay} from '../src/replay/replay-run.mjs';
import {parseWav} from '../src/visits/visit-audio.mjs';
import {speechOf} from '../public/visit-time.js';
import {runRow} from '../public/visit-runs.js';
import {parseArgs} from '../scripts/replay/run.mjs';

const tone=(ms,rate=16000,amp=6000)=>{const n=Math.round(ms/1000*rate),b=Buffer.alloc(n*2);for(let i=0;i<n;i++)b.writeInt16LE(Math.round(Math.sin(i/9)*amp),i*2);return b;};
const settle=()=>new Promise(r=>setTimeout(r,5));
function rig(opts={}){
  const timers=[],injected=[],lines=[];let clock=0;
  const v=createVisitor({tts:async text=>tone(1000),inject:p=>injected.push(p),record:l=>lines.push(l),tNow:()=>clock,rng:()=>0.5,
    schedule:(fn,ms)=>{const t={fn,ms};timers.push(t);return t;},cancel:t=>{if(t)t.cancelled=true;},...opts});
  const fire=async()=>{for(const t of timers.filter(x=>!x.cancelled&&!x.done)){t.done=true;await t.fn();}await settle();};
  return {v,timers,injected,lines,fire,setClock:n=>{clock=n;}};
}

test('scripted visitor: "trick or treat!" after the first greeting once on the path, 0.8-2.0 s later; only after a question afterwards',async()=>{
  const r=rig();r.v.onSpeech({kind:'assistant_turn_end',text:'Evening!'});assert.equal(r.timers.length,0,'nobody on the path yet');
  r.v.onDetect('PATH');r.v.onTranscript({role:'assistant',text:'Evening, folks. Nice cape.'});r.v.onSpeech({kind:'assistant_turn_end',text:'Evening, folks. Nice c'});
  assert.equal(r.timers.length,1);assert.ok(r.timers[0].ms>=800&&r.timers[0].ms<=2000);
  await r.fire();assert.equal(r.injected.length,1);assert.equal(r.lines[0].text,'trick or treat!');
  r.v.onTranscript({role:'assistant',text:'Take some candy.'});r.v.onSpeech({kind:'assistant_turn_end',text:'x'});assert.equal(r.timers.filter(t=>!t.done).length,0,'a statement needs no reply');
  r.v.onTranscript({role:'assistant',text:'What is your favorite candy?'});r.v.onSpeech({kind:'assistant_turn_end',text:'What is your favorite c'});
  await r.fire();assert.equal(r.lines.length,2);assert.match(r.lines[1].text,/!$/);
  r.v.onTranscript({role:'assistant',text:'And what are you supposed to be?'});r.v.onSpeech({kind:'assistant_turn_end'});await r.fire();assert.match(r.lines[2].text,/ninja|witch/);
  for(let i=0;i<5;i++){r.v.onTranscript({role:'assistant',text:'Really?'});r.v.onSpeech({kind:'assistant_turn_end'});await r.fire();}
  assert.equal(r.lines.length,4,'at most 4 lines per visit');
});
test('pickReply pools',()=>{
  assert.equal(pickReply('hi',{first:true}),'trick or treat!');assert.equal(pickReply('Fine night.'),null);
  assert.match(pickReply('Which candy do you like?',{rng:mulberry32(1)}),/!$/);assert.match(pickReply('What are you supposed to be?',{rng:()=>0}),/ninja/);assert.match(pickReply('Cold out?',{n:0}),/yeah/);assert.match(pickReply('Cold out?',{n:1}),/thank/);
});
test('the visitor stops when the state goes EMPTY and does not talk over the assistant; --visitor-silent-after limits replies (0 = never)',async()=>{
  const a=rig();a.v.onDetect('PATH');a.v.onSpeech({kind:'assistant_turn_end',text:'Hi'});a.v.onDetect('EMPTY');await a.fire();assert.equal(a.injected.length,0);
  const b=rig();b.v.onDetect('PATH');b.v.onSpeech({kind:'assistant_turn_end',text:'Hi'});b.v.onSpeech({kind:'assistant_turn_start'});await b.fire();assert.equal(b.injected.length,0,'she started talking again');
  const z=rig({silentAfter:0});z.v.onDetect('PATH');z.v.onSpeech({kind:'assistant_turn_end',text:'Hi'});await z.fire();assert.equal(z.injected.length,0);
  const one=rig({silentAfter:1});one.v.onDetect('PATH');one.v.onSpeech({kind:'assistant_turn_end',text:'Hi'});await one.fire();one.v.onTranscript({role:'assistant',text:'Name?'});one.v.onSpeech({kind:'assistant_turn_end'});await one.fire();assert.equal(one.injected.length,1);
  assert.equal(parseArgs(['--clip','c','--visitor','scripted','--visitor-silent-after','0'])['visitor-silent-after'],'0');
});
test('inject delivers visitor audio through the fake mic child in real time',()=>{
  let clock=0,tick=null;const ra=createReplayAudio({mic:null,tNow:()=>clock,setIntervalImpl:fn=>{tick=fn;return {unref(){}};}});
  const rec=ra.spawnImpl('pw-record',['--rate','16000']),got=[];rec.stdout.on('data',b=>got.push(b));
  clock=100;tick();assert.equal(got.length,0,'silent without a visitor');
  ra.inject(tone(500));clock=300;tick();clock=600;tick();clock=2000;tick();
  const all=Buffer.concat(got);assert.equal(all.length,500*16*2);assert.ok(all.some(x=>x!==0));assert.equal(all.length,tone(500).length);rec.kill();ra.close();
});
test('ttsAvailable names the missing engine; mixPcm sums with clamping',()=>{
  assert.match(ttsAvailable({platform:'linux',spawnSyncImpl:()=>({status:1})}).message,/espeak-ng/);assert.equal(ttsAvailable({platform:'darwin',spawnSyncImpl:()=>({status:0})}).ok,true);
  const m=mixPcm(tone(10,16000,30000),tone(10,16000,30000));assert.ok(Math.max(...Array.from({length:m.length/2},(_,i)=>m.readInt16LE(i*2)))<=32767);
});

// ---- full replay with the fake backend ----
const jpeg=Buffer.from([255,216,255,217]);
const ZONES=[{name:'sidewalk',kind:'sidewalk',points:[[0,0],[1,0],[1,0.3],[0,0.3]]},{name:'path',kind:'path',points:[[0,0.3],[1,0.3],[1,0.88],[0,0.88]]},{name:'porch',kind:'porch',points:[[0.3,0.88],[0.7,0.88],[0.7,1],[0.3,1]]}];
const zoneOf=y=>y<0.3?'sidewalk':y<0.88?'path':'porch';
function clip(visits,id='20261026-190000-abc123',seconds=7){
  const dir=join(visits,id);mkdirSync(dir,{recursive:true});const dets=[];
  for(let t=0;t<=seconds*1000;t+=250){const k=t/250,y=Math.min(0.8,0.15+Math.max(0,k-4)*0.03);dets.push({at:0,t,boxes:t>=500?[{b:[0.63,y-0.2,0.69,y],s:0.9,zone:zoneOf(y)}]:[]});}
  const frames=Math.round(seconds*6);
  const meta={version:1,id,fps:6,video_ms:seconds*1000,end_ms:seconds*1000,frame_count:frames,frame_times:Array.from({length:frames},(_,i)=>Math.round(i*1000/6)),zones:ZONES,detections:dets,
    timeline:[{t:0,state:'EMPTY'},{t:1500,state:'SIDEWALK'},{t:4000,state:'PATH'}],speech:[],transcript:[{t:5000,role:'assistant',text:'Evening, folks. Nice witch hat.'}],judge_reads:[],audio:null};
  writeFileSync(join(dir,'visit.json'),JSON.stringify(meta));writeFileSync(join(dir,'video.mp4'),'stub');return {dir,id,frames};
}
const stubFrames=n=>async()=>Array.from({length:n},(_,k)=>({bytes:jpeg,t:Math.round(k*1000/6)}));
const go=(visits,c,extra={})=>runReplay({visitsDir:visits,clipId:c.id,backend:'fake',judges:'recorded',detector:'recorded',set:{DETECTOR_FPS:'8',PRIMARY_READ_MS:'250'},tailMs:3500,extractImpl:stubFrames(c.frames),env:{},ttsImpl:async()=>tone(1000),...extra});
const wavOf=(c,r,f)=>parseWav(readFileSync(join(c.dir,'runs',r.id,f)));
const loud=(pcm,from,to,rate)=>{for(let i=Math.floor(from*rate/1000);i<Math.min(pcm.length/2,Math.floor(to*rate/1000));i++)if(Math.abs(pcm.readInt16LE(i*2))>500)return true;return false;};

test('replay: a scripted visitor replies after the greeting, is saved as visitor_line, and conversation.wav holds both tracks; silent-after 0 never speaks',{timeout:90000},async()=>{
  const visits=mkdtempSync(join(tmpdir(),'rvis-'));const c=clip(visits);
  try{
    const a=await go(visits,c,{visitor:'scripted'});
    assert.equal(a.state,'done',JSON.stringify(a.errors));assert.equal(a.visitor,'scripted');
    const lines=a.speech.filter(e=>e.kind==='visitor_line');assert.ok(lines.length>=1&&lines.length<=4);assert.equal(lines[0].text,'trick or treat!');
    const turnEnd=a.speech.find(e=>e.kind==='assistant_turn_end');assert.ok(lines[0].t-turnEnd.t>=700&&lines[0].t-turnEnd.t<=2300,'0.8-2.0 s after her turn: '+(lines[0].t-turnEnd.t));
    assert.equal(a.metrics.visitor_turns_simulated,lines.length);assert.equal(a.metrics.silence_joke_fired,false);assert.deepEqual(Object.keys(a.metrics.nudges),['1','2','silence']);
    const conv=wavOf(c,a,'conversation.wav'),asst=wavOf(c,a,'assistant.wav');assert.equal(conv.rate,24000);
    assert.ok(loud(conv.pcm,lines[0].t+100,lines[0].t+900,24000),'visitor audio is in conversation.wav');
    const first=asst.pcm.findIndex((x,i)=>i%2===0&&Math.abs(asst.pcm.readInt16LE(i))>500)/2/24;assert.ok(loud(conv.pcm,first,first+200,24000),'assistant audio is in conversation.wav');
    assert.equal(a.conversation_audio,'conversation.wav');
    const z=await go(visits,c,{visitor:'scripted',visitorSilentAfter:0});assert.equal(z.speech.filter(e=>e.kind==='visitor_line').length,0);assert.equal(z.metrics.visitor_turns_simulated,0);
    const s=await go(visits,c,{visitor:'silent'});assert.equal(s.conversation_audio,null);
  }finally{rmSync(visits,{recursive:true,force:true});}
});
test('replay: an unknown --visitor value is rejected',async()=>{
  const visits=mkdtempSync(join(tmpdir(),'rvis-'));const c=clip(visits);
  try{
    await assert.rejects(runReplay({visitsDir:visits,clipId:c.id,backend:'fake',visitor:'bogus',extractImpl:stubFrames(c.frames)}),e=>e.status===400&&/visitor must be/.test(e.message));
  }finally{rmSync(visits,{recursive:true,force:true});}
});

// ---- runs UI model: nudge markers and the visitor lane ----
test('speechOf: nudges are labelled markers, visitor_line is its own lane, runRow shows them',()=>{
  const m=speechOf({speech:[{t:1000,kind:'nudge_sent',n:1},{t:2500,kind:'nudge_sent',n:2},{t:6500,kind:'nudge_sent',n:'silence'},{t:3000,kind:'visitor_line',text:'trick or treat!',dur_ms:1200},{t:5000,kind:'visitor_line',text:'yeah!'}],end_ms:9000,video_ms:9000});
  assert.deepEqual(m.markers.map(x=>[x.kind,x.label,x.short]),[['nudge_sent','nudge 1','n1'],['nudge_sent','nudge 2','n2'],['nudge_sent','silence joke','zz']]);
  assert.deepEqual(m.visitor.map(v=>[v.t,v.text]),[[3000,'trick or treat!'],[5000,'yeah!']]);assert.equal(m.visitor[0].end,4200);assert.ok(m.visitor[1].end>5000);
  assert.ok(!m.markers.some(x=>x.kind==='visitor_line'));
  assert.match(runRow({backend:'gemini',metrics:{visitor_turns_simulated:2,silence_joke_fired:true}}),/visitor 2 lines.*silence joke/);
  const js=readFileSync(new URL('../public/visits.js',import.meta.url),'utf8'),html=readFileSync(new URL('../public/visits.html',import.meta.url),'utf8');
  assert.match(js,/speechMarkers\(k1,sp2\.markers/);assert.match(js,/visitorLane\(k3,sp2\.visitor/);assert.match(html,/id="t-vis"/);assert.match(html,/\.mk\.sp\.nudge/);
});

test('scripted visitor only talks up close: a reply planned on the path is dropped once the group is back on the sidewalk',async()=>{
  const r=rig();r.v.onDetect('PATH');r.v.onSpeech({kind:'assistant_turn_end',text:'Evening!'});assert.equal(r.timers.length,1);
  r.v.onDetect('SIDEWALK');await r.fire();assert.equal(r.injected.length,0,'out of earshot on the sidewalk');
  r.v.onTranscript({role:'assistant',text:'Leaving already?'});r.v.onSpeech({kind:'assistant_turn_end'});assert.equal(r.timers.filter(t=>!t.done).length,0);
  r.v.onDetect('PORCH');r.v.onTranscript({role:'assistant',text:'Back again?'});r.v.onSpeech({kind:'assistant_turn_end'});await r.fire();assert.equal(r.lines.length,1);
});
