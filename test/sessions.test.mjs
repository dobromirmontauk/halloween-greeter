import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSessionRecorder,sessionDetail} from '../src/visits/sessions.mjs';
import {deriveAppState,nextPhase} from '../src/server/app-state.mjs';
import {createServer} from '../server.mjs';

const clock=(t=1_000_000)=>({now:()=>t,set:v=>{t=v;},advance:v=>{t+=v;}});

test('session opens on first confident presence and closes only when people are 0 and Live is done', async()=>{
  const c=clock(),rec=createSessionRecorder({now:c.now});
  assert.equal(rec.observe({count:0}),null);
  rec.observe({count:null});assert.equal(rec.current(),null,'uncertain never opens');
  rec.observe({count:1});assert.ok(rec.current().open);
  c.advance(5000);rec.observe({count:2,liveState:'active',liveSessionId:'live_1',liveStartedAt:c.now()});
  assert.equal(rec.current().peak_people,2);
  c.advance(10000);rec.observe({count:0,liveState:'active',liveSessionId:'live_1'});
  assert.ok(rec.current(),'people gone but Live active: still open');
  c.advance(2000);rec.observe({count:0,liveState:'stopping',liveSessionId:'live_1'});
  assert.ok(rec.current(),'Live closing: still open');
  rec.observe({count:null,liveState:'idle'});assert.ok(rec.current(),'uncertain does not close');
  c.advance(1000);rec.observe({count:0,liveState:'idle'});
  assert.equal(rec.current(),null);
  const [s]=await rec.list();
  assert.equal(s.open,false);assert.equal(s.peak_people,2);assert.deepEqual(s.live_session_ids,['live_1']);
  assert.equal(s.live_seconds,12);
});

test('debug speech keeps a session open; new presence after close starts a new session', async()=>{
  const c=clock(),rec=createSessionRecorder({now:c.now});
  rec.observe({count:1,debugMode:true});
  rec.observe({count:0,debugSpeaking:true,debugMode:true});assert.ok(rec.current());
  assert.equal(rec.current().mode,'debug');
  c.advance(1);rec.observe({count:0,debugMode:true});assert.equal(rec.current(),null);
  c.advance(1000);rec.observe({count:1});assert.ok(rec.current());
  assert.equal((await rec.list()).length,2);
});

test('events, phases and costumes are recorded on the timeline', async()=>{
  const c=clock(),rec=createSessionRecorder({now:c.now});
  rec.observe({count:1});
  rec.noteEvent({type:'NEW_PARTY',at:c.now(),phrase:'New party approaching, 1 person.'});
  rec.noteEvent({type:'COSTUMES',at:c.now(),phrase:'Costumes: witch.',labels:['witch']});
  rec.notePhase('GREETING');rec.notePhase('COSTUMES');
  const detail=await sessionDetail({recorder:rec,transcriptStore:{},readKeys:async()=>[{read_key:'2026-10-25/x'}],id:rec.current().id});
  assert.deepEqual(detail.costumes,['witch']);
  assert.deepEqual(detail.events.map(e=>e.type),['SESSION_START','NEW_PARTY','COSTUMES','PHASE','PHASE']);
  assert.deepEqual(detail.phases.map(p=>p.phase),['GREETING','COSTUMES']);
  assert.equal(detail.reads[0].read_key,'2026-10-25/x');
  assert.equal(await sessionDetail({recorder:rec,transcriptStore:{},id:'../etc/passwd'}),null);
});

test('detail includes transcript turns for Live session ids', async()=>{
  const c=clock(),rec=createSessionRecorder({now:c.now});
  rec.observe({count:1,liveState:'active',liveSessionId:'live_9',liveStartedAt:c.now()});
  const store={readSession:async id=>{assert.equal(id,'live_9');return {turns:[{role:'assistant',text:'Howdy'}]};}};
  const d=await sessionDetail({recorder:rec,transcriptStore:store,id:rec.current().id});
  assert.equal(d.turns[0].text,'Howdy');
});

test('session files are mode 0600 in a 0700 directory and the directory is gitignored', async()=>{
  const base=await mkdtemp(join(tmpdir(),'porch-sess-')),dir=join(base,'sessions');
  try{
    const c=clock(),rec=createSessionRecorder({dir,now:c.now});
    rec.observe({count:1});await rec.flush();
    const s=(await rec.list())[0];
    assert.equal((await stat(dir)).mode&0o777,0o700);
    assert.equal((await stat(join(dir,s.id+'.json'))).mode&0o777,0o600);
    assert.equal(JSON.parse(await readFile(join(dir,s.id+'.json'),'utf8')).id,s.id);
    const fresh=createSessionRecorder({dir,now:c.now});
    assert.equal((await fresh.list()).length,1,'history survives restart');
  }finally{await rm(base,{recursive:true,force:true});}
  const root=new URL('..',import.meta.url).pathname;
  assert.doesNotThrow(()=>execFileSync('git',['check-ignore','-q','data/sessions/example.json'],{cwd:root}));
});

const base=o=>({automatic:true,live:null,visitorCount:null,now:100_000,...o});
const live=(o={})=>({state:'active',muted:false,error:null,startedAt:40_000,...o});

test('app_state derivation covers every state', ()=>{
  assert.equal(deriveAppState(base({automatic:false})).app_state,'OFF');
  assert.equal(deriveAppState(base({visitorCount:0})).app_state,'WATCHING');
  assert.equal(deriveAppState(base({visitorCount:2})).app_state,'PARTY_DETECTED');
  assert.equal(deriveAppState(base({visitorCount:2,live:live({state:'starting'})})).app_state,'LIVE_STARTING');
  const active=deriveAppState(base({visitorCount:2,live:live()}));
  assert.equal(active.app_state,'LIVE_ACTIVE');assert.equal(active.elapsed_seconds,60);assert.equal(active.limit_seconds,1800);
  assert.equal(deriveAppState(base({visitorCount:2,live:live({muted:true})})).app_state,'MUTED');
  const closing=deriveAppState(base({visitorCount:0,live:live(),absentSince:90_000}));
  assert.equal(closing.app_state,'CLOSING');assert.equal(closing.absence_seconds_left,20);
  assert.equal(deriveAppState(base({visitorCount:0,live:live({state:'stopping'})})).app_state,'CLOSING');
  const debug=deriveAppState(base({debugSpeak:true,visitorCount:1,speaker:{speaking:true,current:'New party approaching, 1 person.'}}));
  assert.equal(debug.app_state,'DEBUG_SPEAKING');assert.equal(debug.phrase,'New party approaching, 1 person.');assert.equal(debug.mode,'debug');
  const err=deriveAppState(base({live:live({state:'error',error:'Linux capture exited unexpectedly'})}));
  assert.equal(err.app_state,'ERROR');assert.match(err.message,/capture/);
  assert.equal(deriveAppState(base({automatic:false,live:live({state:'idle'})})).app_state,'OFF');
});

test('live_phase follows prompts: greeting, costumes, goodbye, handoff back to greeting; null when Live is not active', ()=>{
  let p=null;
  p=nextPhase(p,'welcome');assert.equal(p,'GREETING');
  p=nextPhase(p,'costume');assert.equal(p,'COSTUMES');
  p=nextPhase(p,'handoff');assert.equal(p,'GREETING');
  p=nextPhase(p,'costume');p=nextPhase(p,'farewell');assert.equal(p,'GOODBYE');
  assert.equal(nextPhase('COSTUMES','unknown-kind'),'COSTUMES');
  assert.equal(deriveAppState(base({visitorCount:1,live:live(),phase:'COSTUMES'})).live_phase,'COSTUMES');
  assert.equal(deriveAppState(base({visitorCount:1,live:live()})).live_phase,'GREETING');
  assert.equal(deriveAppState(base({visitorCount:1,live:live({state:'starting'}),phase:'COSTUMES'})).live_phase,null);
  assert.equal(deriveAppState(base({visitorCount:1})).live_phase,null);
});

test('Stop session ends Live but leaves the greeter on; /api/state and /api/sessions respond', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'porch-sess-'));let active=true;const stops=[];
  const voice={status:()=>({active,state:active?'active':'idle',muted:false,startedAt:Date.now()-5000,sessionId:'live_t'}),stop:async r=>{stops.push(r);active=false;},start:async()=>{},setMuted(){}};
  const server=createServer({env:{AUDIO_MODE:'linux',OPENAI_API_KEY:'t',AUTO_START:'true',SESSIONS_DIR:dir,JUDGE_LOG:'false',TRANSCRIPT_DIR:join(dir,'tr')},voiceImpl:voice});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
  try{
    await fetch(url+'/api/status');await fetch(url+'/api/audio/status');
    const before=await (await fetch(url+'/api/state')).json();
    assert.equal(before.greeter,true);
    const res=await fetch(url+'/api/audio/end-session',{method:'POST',headers:{Origin:url},body:'{}'});
    assert.equal(res.status,200);
    assert.deepEqual(stops,['Operator ended session']);
    const status=await (await fetch(url+'/api/status')).json();
    assert.equal(status.auto_start,true);
    const after=await (await fetch(url+'/api/state')).json();
    assert.equal(after.greeter,true);assert.notEqual(after.app_state,'OFF');
    assert.deepEqual(await (await fetch(url+'/api/sessions')).json(),[]);
    assert.equal((await fetch(url+'/api/sessions/nope')).status,404);
  }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
