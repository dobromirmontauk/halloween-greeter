import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../server.mjs';
import {createAppMode,normalizeMode,parseSchedule,createSchedule,parseUntil,DEFAULT_SCHEDULE} from '../src/server/app-mode.mjs';

const answers=[{type:'choice',name:'real_people_count',choice:'1',confidence:0.99},{type:'choice',name:'camera_action',choice:'centered',confidence:0.99},{type:'choice',name:'next_capture_ms',choice:'1000',confidence:0.99},{type:'choice',name:'closest_person_location',choice:'porch',confidence:0.99}];
async function boot(extraEnv={},{voice,factory,modeClock}={}){
  const dir=await mkdtemp(join(tmpdir(),'mode-'));const urls=[];
  const server=createServer({
    env:{CAMERA_URL:'rtsp://camera/stream2',OPENAI_API_KEY:'test',AUDIO_MODE:'linux',MODE_FILE:join(dir,'mode.json'),SESSIONS_DIR:join(dir,'s'),EVENT_AUDIT_DIR:join(dir,'e'),TRANSCRIPT_DIR:join(dir,'t'),JUDGE_LOG:'false',...extraEnv},
    captureImpl:async()=>Buffer.from([255,216,255,217]),
    voiceImpl:voice,liveFactory:factory,modeClock,
    fetchImpl:async url=>{urls.push(url);return {ok:true,json:async()=>url.endsWith('/decisions')?{answers}:{output_text:'{}'}};}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  const call=async(path,method='GET',body,origin=base)=>{const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(method==='POST'?{Origin:origin}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,json:await res.json().catch(()=>null)};};
  const close=async()=>{await server.stopAutomation();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});};
  return {server,dir,urls,call,close};
}
const idleVoice=()=>{const v={starts:0,stops:0,active:false,status:()=>({active:v.active}),start:async()=>{v.starts++;v.active=true;},updateContext(){},sendPrompt:async()=>true,stop:async()=>{v.stops++;v.active=false;}};return v;};

test('without a schedule: persisted override, then START_MODE, AUTO_START, default OFF',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mode-'));const file=join(dir,'mode.json');
  assert.equal(createAppMode({env:{},file}).get(),'OFF');
  assert.equal(createAppMode({env:{AUTO_START:'true'},file}).get(),'ON');
  assert.equal(createAppMode({env:{AUTO_START:'true',START_MODE:'data_capture'},file}).get(),'DATA_CAPTURE');
  const m=createAppMode({env:{AUTO_START:'true'},file});await m.set('DATA_CAPTURE');
  assert.equal(JSON.parse(await readFile(file,'utf8')).override.mode,'DATA_CAPTURE');
  assert.equal(createAppMode({env:{AUTO_START:'true'},file}).get(),'DATA_CAPTURE');
  assert.equal(normalizeMode('data-capture'),'DATA_CAPTURE');assert.equal(normalizeMode('bogus'),null);
  await assert.rejects(m.set('nope'));
  await rm(dir,{recursive:true,force:true});
});

test('/api/mode GET/POST, origin check, validation, persistence, derived automatic',async()=>{
  const t=await boot({},{voice:idleVoice()});
  try{
    assert.deepEqual((await t.call('/api/mode')).json.mode,'OFF');
    assert.equal((await t.call('/api/status')).json.automatic,false);
    assert.equal((await t.call('/api/mode','POST',{mode:'ON'},'http://evil.example')).status,403);
    assert.equal((await t.call('/api/mode','POST',{mode:'BOGUS'})).status,400);
    const r=await t.call('/api/mode','POST',{mode:'DATA_CAPTURE'});
    assert.equal(r.status,200);assert.equal(r.json.mode,'DATA_CAPTURE');assert.equal(r.json.automatic,true);
    const st=(await t.call('/api/status')).json;assert.equal(st.mode,'DATA_CAPTURE');assert.equal(st.automatic,true);assert.equal(st.auto_start,true);
    assert.equal(JSON.parse(await readFile(join(t.dir,'mode.json'),'utf8')).override.mode,'DATA_CAPTURE');
    await t.call('/api/mode','POST',{mode:'OFF'});
    assert.equal((await t.call('/api/mode')).json.mode,'OFF');
  }finally{await t.close();}
});

test('/api/audio/start and /stop alias ON and OFF; start is refused in DATA_CAPTURE',async()=>{
  const voice=idleVoice();const t=await boot({},{voice});
  try{
    assert.equal((await t.call('/api/audio/start','POST')).status,200);assert.equal((await t.call('/api/mode')).json.mode,'ON');
    assert.equal((await t.call('/api/audio/stop','POST')).status,200);assert.equal((await t.call('/api/mode')).json.mode,'OFF');
    await t.call('/api/mode','POST',{mode:'DATA_CAPTURE'});
    const before=voice.starts;
    assert.equal((await t.call('/api/audio/start','POST')).status,409);
    assert.equal((await t.call('/api/mode')).json.mode,'DATA_CAPTURE');assert.equal(voice.starts,before);
    assert.equal((await t.call('/api/audio/stop','POST')).status,200);assert.equal((await t.call('/api/mode')).json.mode,'OFF');
  }finally{await t.close();}
});

test('DATA_CAPTURE runs the Judge but never calls Luna scene analysis or Live',async()=>{
  let factoryCalls=0;const voice=idleVoice();
  const t=await boot({START_MODE:'DATA_CAPTURE'},{factory:()=>{factoryCalls++;return voice;}});
  try{
    await new Promise(r=>setTimeout(r,500));
    assert.ok(t.urls.some(u=>u.endsWith('/decisions')),'Judge ran');
    assert.equal((await t.call('/api/scene','POST')).status,409);
    assert.equal((await t.call('/api/session','POST',{sdp:'v=0'})).status,409);
    assert.equal((await t.call('/api/audio/start','POST')).status,409);
    assert.equal((await t.call('/api/audio/rehearsal','POST',{event:'welcome'})).status,409);
    await new Promise(r=>setTimeout(r,200));
    assert.deepEqual(t.urls.filter(u=>!u.endsWith('/decisions')),[],'only Judge requests were made');
    assert.equal(factoryCalls,0,'Live was never constructed');assert.equal(voice.starts,0);
  }finally{await t.close();}
});

test('ON to DATA_CAPTURE and ON to OFF close an active Live session',async()=>{
  for(const target of ['DATA_CAPTURE','OFF']){
    const voice=idleVoice();const t=await boot({START_MODE:'ON',MODE_GOODBYE_MS:'0'},{voice});
    try{
      await (async()=>{for(let i=0;i<80&&!voice.active;i++)await new Promise(r=>setTimeout(r,50));})();
      assert.equal(voice.starts,1,'ON started Live');assert.equal(voice.active,true);
      const r=await t.call('/api/mode','POST',{mode:target});assert.equal(r.json.mode,target);
      assert.equal(voice.active,false);assert.ok(voice.stops>=1);
      const starts=voice.starts;await new Promise(r=>setTimeout(r,2200));assert.equal(voice.starts,starts,'no new Live in '+target);
    }finally{await t.close();}
  }
});

test('ON to DATA_CAPTURE mid-conversation sends the goodbye prompt before closing Live',async()=>{
  const voice=idleVoice();const prompts=[];voice.sendPrompt=async kind=>{prompts.push(kind);return true;};
  const t=await boot({START_MODE:'ON',MODE_GOODBYE_MS:'150'},{voice});
  try{
    await (async()=>{for(let i=0;i<80&&!voice.active;i++)await new Promise(r=>setTimeout(r,50));})();assert.equal(voice.active,true);
    await t.call('/api/mode','POST',{mode:'DATA_CAPTURE'});
    assert.ok(prompts.includes('goodbye'),'goodbye prompt sent');assert.equal(voice.active,true,'still open during the goodbye');
    await new Promise(r=>setTimeout(r,400));assert.equal(voice.active,false);
  }finally{await t.close();}
});

test('OFF stops the Judge loop',async()=>{
  const t=await boot({START_MODE:'ON'},{voice:idleVoice()});
  try{
    await new Promise(r=>setTimeout(r,300));await t.call('/api/mode','POST',{mode:'OFF'});
    await new Promise(r=>setTimeout(r,100));const n=t.urls.length;await new Promise(r=>setTimeout(r,1500));
    assert.equal(t.urls.length,n);
  }finally{await t.close();}
});
