// Speech events on the visit timeline, Live pre-warm on arrival, welcome on the first arriving path frame without waiting on Judges.
// Synthetic data only: fake WebSocket, fake audio children, fake detector sidecar, fake clock.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLinuxLive} from '../src/voice/linux-live.mjs';
import {PartyController} from '../src/voice/party-flow.mjs';
import {createArrival,arrivalOptions} from '../src/presence/arrival.mjs';
import {createPresenceTracker} from '../src/presence/presence-tracker.mjs';
import {analyze} from '../src/presence/person-detector.mjs';
import {createVisitRecorder} from '../src/visits/visit-recorder.mjs';
import {createCosts} from '../src/lib/costs.mjs';
import {speechOf,speechLabel} from '../public/visit-time.js';
import {createServer} from '../server.mjs';
import {judgeAnswer} from './judge-fixtures.mjs';

// Sidewalk on top (y<0.3), path in the middle, porch bottom centre. Porch centre (0.5,0.94): moving down = arriving, up = leaving.
const zones=[
 {name:'sidewalk',kind:'sidewalk',points:[[0,0],[1,0],[1,0.3],[0,0.3]]},
 {name:'path',kind:'path',points:[[0,0.3],[1,0.3],[1,0.88],[0,0.88]]},
 {name:'porch',kind:'porch',points:[[0.3,0.88],[0.7,0.88],[0.7,1],[0.3,1]]}
];
const box=(x,y,w=0.05,h=0.2)=>[x-w/2,y-h,x+w/2,y];
const STEP=250;

// ---- rig: real linux-live over a fake WebSocket, real PartyController, real tracker, manual clock and timers ----
function rig({enabled=()=>true,env={}}={}){
 let t=0;const now=()=>t,timers=[],speech=[],warm=[],sockets=[],children=[];
 const schedule=(fn,ms)=>{const h={fn,at:t+ms,done:false};timers.push(h);return h;},cancel=h=>{if(h)h.done=true;};
 const tick=()=>new Promise(r=>setImmediate(r));
 const advance=async to=>{ // fire due timers in order up to `to`
  for(;;){const due=timers.filter(h=>!h.done&&h.at<=to).sort((a,b)=>a.at-b.at)[0];if(!due)break;due.done=true;t=Math.max(t,due.at);await due.fn();await tick();}
  t=to;
 };
 const webSocketFactory=()=>{
  const ws=new EventEmitter();ws.readyState=0;ws.sent=[];
  ws.send=text=>{const m=JSON.parse(text);ws.sent.push(m);
   if(m.type==='session.start')queueMicrotask(()=>ws.emit('message',Buffer.from(JSON.stringify({type:'session.started',session:{id:'s'+sockets.length}}))));
   if(m.type==='session.close')queueMicrotask(()=>ws.emit('message',Buffer.from(JSON.stringify({type:'session.closed',usage:{seconds:7}}))));};
  ws.close=()=>{ws.readyState=3;};ws.terminate=ws.close;sockets.push(ws);
  setImmediate(()=>{ws.readyState=1;ws.emit('open');});return ws;
 };
 const spawnImpl=(command,args)=>{const c=new EventEmitter();Object.assign(c,{command,args,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null});c.kill=()=>{c.exitCode=0;};children.push(c);return c;};
 const live=createLinuxLive({env:{OPENAI_API_KEY:'k'},webSocketFactory,spawnImpl,now,onSpeech:e=>speech.push(e),onWarm:w=>warm.push(w),closeTimeoutMs:50});
 const party=new PartyController({voice:live,now,schedule,cancel,instructions:'be kind',limitMs:600000});
 const notes=[];
 const arrival=createArrival({env,now,enabled,busy:()=>party.active||party.locked,party:async()=>party,voice:async()=>live,instructions:'be kind',note:(kind,x)=>notes.push({kind,at:t,...x}),schedule,cancel});
 const tracker=createPresenceTracker({});
 const frame=async(x,y,{score=0.9}={})=>{ // one detector frame at the current time, like person-detector.mjs builds it
  const raw={persons:x==null?[]:[{bbox:box(x,y),score}]};
  const r=analyze(raw,{zones,at:t,minScore:0.5});r.group=tracker.update(r.persons,r.at,zones,r.low);
  await arrival.onDetect(r);await tick();await tick();return r;
 };
 return {now,advance,tick,live,party,arrival,speech,warm,sockets,notes,frame,setT:v=>{t=v;},connects:()=>sockets.length,t:()=>t};
}
const kinds=r=>r.speech.map(e=>e.kind);
// A walker going down the sidewalk then the path: foot y from y0 by dy per frame at x.
async function walk(r,{x=0.5,y0=0.05,dy=0.04,n=20}){for(let i=0;i<n;i++){await r.frame(x,y0+i*dy);r.setT(r.t()+STEP);}}

test('pre-warm: a sidewalk arrival connects Live with no prompt and no audio; the session is reused on PATH (one connect) and the welcome goes out on the first arriving path frame',async()=>{
 const r=rig();
 await walk(r,{n:30});
 assert.equal(r.connects(),1,'exactly one WebSocket: the pre-warmed session was reused');
 assert.equal(r.sockets[0].sent.filter(m=>m.type==='session.start').length,1);
 const k=kinds(r);
 assert.ok(k.indexOf('live_connected')>=0&&k.indexOf('welcome_sent')>k.indexOf('live_connected'),'connected before the welcome: '+k);
 assert.ok(k.includes('live_activated'));assert.equal(k.filter(x=>x==='live_start_requested').length,1);
 assert.equal(r.speech.find(e=>e.kind==='live_start_requested').prewarm,true);
 assert.equal(r.speech.find(e=>e.kind==='live_connected').prewarm,true);
 const connectedAt=r.speech.find(e=>e.kind==='live_connected').at,actAt=r.speech.find(e=>e.kind==='live_activated').at;
 assert.ok(actAt>connectedAt,'it sat warm before the welcome');
 assert.equal(r.sockets[0].sent.filter(m=>m.type==='session.commentary.append').length,1,'only the welcome');
 assert.equal(r.warm.length,1);assert.equal(r.warm[0].used,true);
 assert.equal(r.party.active,true);
});

test('budget: first arriving path frame -> welcome_sent <= 300 ms when pre-warmed, with the debounced PATH state NOT yet reached; sidewalk arrival -> live_connected measured',async()=>{
 const r=rig();let firstSide=null,firstPath=null,pathStateAt=null;
 for(let i=0;i<30;i++){
  const y=0.05+i*0.04,res=await r.frame(0.5,y);
  const arrivingSide=res.persons.some(p=>p.dir==='arriving'&&p.zone==='sidewalk');
  if(arrivingSide&&firstSide==null)firstSide=r.t();
  const onPath=(res.group.motion?.persons||[]).some(p=>p.zone==='path'&&p.dir==='arriving');
  if(onPath&&firstPath==null){firstPath=r.t();assert.notEqual(res.group.state,'PATH','the 750 ms PATH debounce has not elapsed yet');}
  if(res.group.state==='PATH'&&pathStateAt==null)pathStateAt=r.t();
  r.setT(r.t()+STEP);
 }
 const connected=r.speech.find(e=>e.kind==='live_connected'),sent=r.speech.find(e=>e.kind==='welcome_sent');
 assert.ok(firstSide!=null&&firstPath!=null&&connected&&sent);
 const warmMs=connected.at-firstSide,welcomeMs=sent.at-firstPath;
 console.log(`[measured, fake WS/virtual clock] sidewalk arriving -> live_connected ${warmMs} ms; first path frame -> welcome_sent ${welcomeMs} ms; debounced PATH state came ${pathStateAt-firstPath} ms after the first path frame`);
 assert.ok(welcomeMs<=300,'welcome within 300 ms of the first path frame: '+welcomeMs);
 assert.ok(sent.at<pathStateAt,'welcome did not wait for the debounced PATH state');
 assert.ok(connected.at<=firstPath,'connected before the path was reached');
});

test('pre-warm closes after PREWARM_MAX_MS without PATH, is not re-opened for the same group, and re-arms after EMPTY',async()=>{
 const r=rig({env:{PREWARM_MAX_MS:'15000'}});
 assert.equal(arrivalOptions({}).prewarmMaxMs,15000);
 for(let i=0;i<6;i++){await r.frame(0.5,0.05+i*0.04);r.setT(r.t()+STEP);}
 assert.equal(r.live.status().state,'warm');assert.equal(r.connects(),1);
 while(r.t()<30000){await r.advance(r.t()+STEP);await r.frame(0.5,0.25);}
 assert.equal(r.live.status().state,'idle','closed by PREWARM_MAX_MS');
 assert.equal(r.connects(),1,'not re-opened while the same group stands there');
 assert.deepEqual(r.warm.map(w=>w.used),[false],'counted as wasted pre-warm');
 assert.ok(r.notes.some(n=>n.kind==='prewarm_close'&&n.reason==='timeout'));
 assert.equal(r.party.active,false);
 for(let i=0;i<30;i++){await r.frame(null);r.setT(r.t()+STEP);}
 for(let i=0;i<6;i++){await r.frame(0.5,0.05+i*0.04);r.setT(r.t()+STEP);}
 assert.equal(r.connects(),2);
});

test('pre-warm closes when the group goes EMPTY before the limit',async()=>{
 const r=rig();
 for(let i=0;i<6;i++){await r.frame(0.5,0.05+i*0.04);r.setT(r.t()+STEP);}
 assert.equal(r.live.status().state,'warm');
 for(let i=0;i<20;i++){await r.frame(null);r.setT(r.t()+STEP);}
 assert.equal(r.live.status().state,'idle');assert.equal(r.warm[0].used,false);
 assert.ok(r.notes.some(n=>n.kind==='prewarm_close'&&n.reason==='empty'));
});

test('no pre-warm and no early welcome when not enabled (OFF, DATA_CAPTURE, DEBUG_SPEAK, rehearsal) or PREWARM=off',async()=>{
 const off=rig({enabled:()=>false});await walk(off,{n:30});
 assert.equal(off.connects(),0);assert.equal(off.party.active,false);
 const np=rig({env:{PREWARM:'off'}});
 for(let i=0;i<6;i++){await np.frame(0.5,0.05+i*0.04);np.setT(np.t()+STEP);}
 assert.equal(np.connects(),0,'PREWARM=off: no connect on the sidewalk');
 await walk(np,{y0:0.4,n:10});
 assert.equal(np.party.active,true,'the welcome still comes on the path (cold start)');
});

test('a sidewalk walker clipping the path mouth, a path walker who is leaving, and one who stays put do not trigger the welcome',async()=>{
 const a=rig();for(const y of [0.2,0.24,0.28,0.30,0.31,0.31,0.30,0.28,0.24,0.2]){await a.frame(0.5,y);a.setT(a.t()+STEP);}
 assert.equal(a.party.active,false,'path mouth clip');assert.ok(!a.speech.some(e=>e.kind==='welcome_sent'));
 const b=rig();for(let i=0;i<12;i++){await b.frame(0.5,0.8-i*0.04);b.setT(b.t()+STEP);}
 assert.equal(b.party.active,false,'leaving');assert.equal(b.notes.filter(n=>n.kind==='welcome_triggered').length,0);
 const c=rig();for(let i=0;i<12;i++){await c.frame(0.5,0.6);c.setT(c.t()+STEP);}
 assert.equal(c.party.active,false,'present on path');
});

test('speech events: first word, assistant turns (text cut to 80 chars) and user speech carry timestamps from the same clock',async()=>{
 const r=rig();await walk(r,{n:30});
 const t0=r.t();
 const out=text=>r.sockets[0].emit('message',Buffer.from(JSON.stringify({type:'session.output_transcript.delta',delta:text})));
 const audio=bytes=>r.sockets[0].emit('message',Buffer.from(JSON.stringify({type:'session.output_audio.delta',delta:Buffer.alloc(bytes).toString('base64')})));
 r.setT(t0+500);audio(48000);out('Well, hey there! '+'x'.repeat(100)); // 1 s of audio queued
 await r.tick();
 const start=r.speech.find(e=>e.kind==='assistant_turn_start');assert.equal(start.at,t0+500);
 assert.equal(r.speech.find(e=>e.kind==='first_audio_out').source,'audio');assert.ok(r.speech.some(e=>e.kind==='first_transcript'));
 await new Promise(res=>setTimeout(res,1900)); // the end timer = queued audio (1 s) + turn gap (0.7 s)
 const end=r.speech.find(e=>e.kind==='assistant_turn_end');
 assert.equal(end.at,t0+500+1000,'turn ends when the queued audio has finished playing');assert.equal(end.text.length,80);assert.ok(end.text.startsWith('Well, hey there!'));
 r.setT(t0+4000);r.sockets[0].emit('message',Buffer.from(JSON.stringify({type:'session.input_transcript.delta',delta:'hi'})));
 await new Promise(res=>setTimeout(res,1200));
 const us=r.speech.find(e=>e.kind==='user_speech_start'),ue=r.speech.find(e=>e.kind==='user_speech_end');
 assert.equal(us.at,t0+4000);assert.equal(ue.at,t0+4000);assert.ok(!JSON.stringify(r.speech).includes('"hi"'),'user words are never stored');
 await r.party.close('test');await r.tick();
 assert.ok(kinds(r).includes('live_end'));
});

// ---- the sidecar ----
test('the visit sidecar records speech events with t = ms from the clip start; the Speech row model and label degrade gracefully',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sp-'));let clk=1_000_000;
 const rec=createVisitRecorder({dir,now:()=>clk,zones:()=>zones,encodeImpl:async()=>({ms:1}),freeBytes:()=>50*1024**3,tickMs:3600000});
 try{
  const tr=createPresenceTracker({});
  for(let i=0;i<12;i++){clk=1_000_000+i*250;const r=analyze({persons:[{bbox:box(0.5,0.35+i*0.03),score:0.9}]},{zones,at:clk,minScore:0.5});r.group=tr.update(r.persons,r.at,zones);rec.onFrame({bytes:Buffer.from([255,216,255,217]),at:clk});rec.onDetect(r);}
  rec.noteSpeech({kind:'live_connected',at:1_000_700});
  rec.noteSpeech({kind:'welcome_sent',at:1_001_100});
  rec.noteSpeech({kind:'first_audio_out',at:1_002_500,source:'audio'});
  rec.noteSpeech({kind:'assistant_turn_start',at:1_002_500});
  rec.noteSpeech({kind:'assistant_turn_end',at:1_004_000,text:'Well, hey there!'});
  rec.noteSpeech({kind:'user_speech_start',at:1_004_500});rec.noteSpeech({kind:'user_speech_end',at:1_005_000});
  rec.finalizeNow('test');await rec.flush();
  const meta=rec.get(rec.list()[0].id);
  assert.deepEqual(meta.speech.map(e=>[e.kind,e.t]),[['live_connected',700],['welcome_sent',1100],['first_audio_out',2500],['assistant_turn_start',2500],['assistant_turn_end',4000],['user_speech_start',4500],['user_speech_end',5000]]);
  assert.equal(meta.speech[2].source,'audio');assert.equal(meta.speech[4].text,'Well, hey there!');
  assert.equal(meta.start_ms,1_000_000);
  const withTl={...meta,timeline:[{t:0,state:'SIDEWALK'},{t:1000,state:'PATH'}]};
  const m=speechOf(withTl);
  assert.deepEqual(m.assistant.map(a=>[a.t,a.end,a.text]),[[2500,4000,'Well, hey there!']]);assert.deepEqual(m.user.map(u=>[u.t,u.end]),[[4500,5000]]);
  assert.deepEqual(m.markers.map(k=>k.label),['connected','welcome sent','first word']);
  assert.deepEqual(m.firstWord,{t:2500,source:'audio'});assert.equal(m.afterPathMs,1500);
  assert.equal(speechLabel(withTl),'first word 1.5s after PATH');
  const old=speechOf({timeline:[{t:0,state:'PATH'}],end_ms:5000});assert.equal(old.has,false);assert.equal(old.firstWord,null);assert.equal(speechLabel({}),'Speech');
  const open=speechOf({end_ms:9000,speech:[{t:100,kind:'assistant_turn_start'}]});assert.deepEqual(open.assistant,[{t:100,end:9000,text:''}]);
 }finally{rec.close();rmSync(dir,{recursive:true,force:true});}
});

test('the visits page has a Speech row and renders assistant segments, user segments and markers',()=>{
 const html=readFileSync(new URL('../public/visits.html',import.meta.url),'utf8'),js=readFileSync(new URL('../public/visits.js',import.meta.url),'utf8');
 assert.match(html,/id="t-speech"/);assert.match(html,/id="l-speech"/);
 assert.match(js,/speechOf\(meta\)/);assert.match(js,/segments\(T\.speech,/);assert.match(js,/speechLabel\(meta\)/);
 const m=speechOf({end_ms:10000,timeline:[{t:0,state:'PATH'}],speech:[{t:500,kind:'welcome_sent'},{t:900,kind:'first_audio_out',source:'transcript'},{t:900,kind:'assistant_turn_start'},{t:2000,kind:'assistant_turn_end',text:'hi'}]});
 assert.equal(m.assistant.length,1);assert.equal(m.markers.length,2);assert.equal(m.firstWord.source,'transcript');
 assert.equal(speechLabel({end_ms:10000,timeline:[{t:0,state:'PATH'}],speech:[{t:900,kind:'first_audio_out',source:'transcript'}]}),'first word 0.9s after PATH (transcript)');
});

// ---- costs ----
test('pre-warm cost attribution: live.prewarm counts wasted vs used sessions; total_usd is not double counted',()=>{
 const c=createCosts({});
 c.recordLive({sessionId:'a',seconds:12});c.recordPrewarm({seconds:12,used:false});
 c.recordLive({sessionId:'b',seconds:100});c.recordPrewarm({seconds:3,used:true});
 const s=c.snapshot().since_start,p=s.by_category.live.prewarm;
 assert.equal(p.sessions,2);assert.equal(p.used_sessions,1);assert.equal(p.wasted_sessions,1);assert.equal(p.wasted_seconds,12);
 assert.ok(Math.abs(p.wasted_usd-12/60*0.05)<1e-9);assert.ok(Math.abs(s.total_usd-112/60*0.05)<1e-6,'total comes only from recordLive');
});

// ---- server level ----
const jpeg=Buffer.from([255,216,255,217]);
function fakeSpawn(reply){
 return ()=>{
  const child=new EventEmitter();child.stdout=new EventEmitter();child.kill=()=>{};
  child.stdin={on(){},end(){},write(line){const req=JSON.parse(line);if(req.cmd==='shutdown')return;const rr=reply(req);if(rr===null)return;setImmediate(()=>child.stdout.emit('data',Buffer.from(JSON.stringify({id:req.id,ok:true,...rr})+'\n')));}};
  setImmediate(()=>child.stdout.emit('data',Buffer.from('{"ready":true}\n')));return child;
 };
}
const waitFor=async(fn,ms=20000)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw Error('timeout');await new Promise(r=>setTimeout(r,25));}};
// A walker going down the default-zone sidewalk then the path (x=0.66), one detector call per step; stays at the last step.
const STEPS=[0.2,0.24,0.28,0.33,0.37,0.41,0.45,0.49,0.53,0.57,0.61,0.65,0.69,0.73];
function walkerReply(){let i=0;return ()=>{const y=STEPS[Math.min(i++,STEPS.length-1)];return {persons:[{bbox:[0.63,y-0.2,0.69,y],score:0.9}],ms:4,width:960,height:540};};}
async function serverRun({env={},costumeDelayMs=0,reply=walkerReply()},body){
 const dir=mkdtempSync(join(tmpdir(),'arr-'));
 const voice={prewarms:0,starts:[],active:false,warm:false,stops:0,status(){return {active:this.active,warm:this.warm,state:this.active?'active':this.warm?'warm':'idle',transcripts:[]};},
  async prewarm(){this.prewarms++;this.warm=true;},async start(o){this.starts.push({at:Date.now(),welcome:o.welcomePrompt,wasWarm:this.warm});this.warm=false;this.active=true;},async stop(){this.stops++;this.active=false;this.warm=false;},sendPrompt:()=>true,instruct:()=>true,rearmPrompts(){}};
 const judgeCalls=[];
 const fetchImpl=async(url,opts)=>{const b=JSON.parse(opts.body),names=b.questions.map(q=>q.name);
  const isCostume=!names.includes('real_people_count')&&!names.includes('person_1_motion');
  judgeCalls.push({at:Date.now(),isCostume});
  if(isCostume)await new Promise(r=>setTimeout(r,costumeDelayMs));
  return {ok:true,json:async()=>judgeAnswer(b,{count:'1',location:'path',people:[{motion:'present',face:'yes',location:'path'}],costumes:['witch']})};};
 const server=createServer({env:{CAMERA_URL:'rtsp://x/stream',OPENAI_API_KEY:'test',AUTO_START:'true',AUDIO_MODE:'linux',DETECTOR_FPS:'15',PRIMARY_READ_MS:'250',JUDGE_LOG_DIR:join(dir,'log'),SESSIONS_DIR:join(dir,'s'),EVENT_AUDIT_DIR:join(dir,'e'),TRANSCRIPT_DIR:join(dir,'t'),MODE_FILE:join(dir,'mode.json'),...env},
  captureImpl:async()=>jpeg,fetchImpl,voiceImpl:voice,detectorSpawnImpl:fakeSpawn(reply)});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{return await body({voice,judgeCalls,base:`http://127.0.0.1:${server.address().port}`});}
 finally{await server.stopAutomation();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
}

test('server: pre-warms on a sidewalk arrival and the welcome is sent while a 2 s costume Judge is still running',async()=>{
 await serverRun({costumeDelayMs:2000},async({voice,judgeCalls})=>{
  await waitFor(()=>voice.prewarms>=1);
  await waitFor(()=>voice.starts.length>=1,12000);
  assert.equal(voice.prewarms,1);assert.equal(voice.starts[0].wasWarm,true,'the welcome reused the warm session');
  assert.match(voice.starts[0].welcome||'',/\S/);
  const welcomeAt=voice.starts[0].at,firstCostume=judgeCalls.find(c=>c.isCostume);
  // The welcome must not wait for a costume read to finish: either no costume read has even started, or it started less than 2 s before the welcome.
  assert.ok(!firstCostume||welcomeAt-firstCostume.at<2000,'welcome was not held back by the 2 s costume Judge');
 });
});

test('server: no pre-warm in DATA_CAPTURE, in DEBUG_SPEAK or when PREWARM=off; a control run in ON does pre-warm',async()=>{
 for(const env of [{START_MODE:'DATA_CAPTURE',CAPTURE_DIR:mkdtempSync(join(tmpdir(),'cap-')),CAPTURE_MIN_FREE_GB:'0'},{DEBUG_SPEAK:'true'},{PREWARM:'off'}]){
  await serverRun({env},async({voice,base})=>{
   await waitFor(async()=>(await (await fetch(base+'/api/detector/status')).json()).processed>=8);
   await new Promise(r=>setTimeout(r,500));
   assert.equal(voice.prewarms,0,JSON.stringify(env));
   if(!env.PREWARM)assert.equal(voice.starts.length,0,JSON.stringify(env));
  });
 }
 await serverRun({},async({voice})=>{await waitFor(()=>voice.prewarms>=1);});
});
