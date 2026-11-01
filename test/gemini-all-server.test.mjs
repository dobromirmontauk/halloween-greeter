// Server wiring for GEMINI_MODE. Fake gemini factory, no real API calls.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../server.mjs';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function boot(extraEnv={},{geminiFactory}={}){
  const dir=await mkdtemp(join(tmpdir(),'gema-'));
  const server=createServer({
    env:{CAMERA_URL:'rtsp://camera/stream2',OPENAI_API_KEY:'test',AUDIO_MODE:'linux',MODE_FILE:join(dir,'mode.json'),SESSIONS_DIR:join(dir,'s'),EVENT_AUDIT_DIR:join(dir,'e'),TRANSCRIPT_DIR:join(dir,'t'),JUDGE_LOG:'false',FACE_DATA_DIR:join(dir,'f'),...extraEnv},
    captureImpl:async()=>Buffer.from([255,216,255,217]),geminiFactory,
    fetchImpl:async()=>({ok:true,json:async()=>({output_text:'{}'})})
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  const call=async(path,method='GET',body)=>{const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(method==='POST'?{Origin:base}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,json:await res.json()};};
  return {call,close:async()=>{await server.stopAutomation();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}};
}
const fakeGemini=()=>{
  const created=[],f=opts=>{const v={opts,opens:0,wanted:false,alwaysOn:true,calls:[],
    status:()=>({state:'idle',active:false,wanted:v.wanted,connected:v.wanted}),
    open:async()=>{v.opens++;v.wanted=true;return v.status();},close:async()=>{v.wanted=false;},setPresence(){},
    start:async()=>{v.calls.push('start');},stop:async()=>{},prewarm:async()=>{},sendPrompt:async()=>{v.calls.push('prompt');return true;},instruct:()=>{v.calls.push('instruct');return true;},barker:()=>{v.calls.push('barker');return true;},setMuted(){},updateContext(){},rearmPrompts(){}};
    created.push(v);return v;};
  f.created=created;return f;
};

test('status exposes gemini_mode and the world prompt sha; default is events with no sha; openai has no mode',async()=>{
  const t=await boot({VOICE_BACKEND:'gemini',GEMINI_API_KEY:'k'},{geminiFactory:fakeGemini()});
  try{const s=(await t.call('/api/status')).json;assert.equal(s.gemini_mode,'events');assert.equal(s.prompt_sha,null);}finally{await t.close();}
  const a=await boot({VOICE_BACKEND:'gemini',GEMINI_API_KEY:'k',GEMINI_MODE:'all-gemini'},{geminiFactory:fakeGemini()});
  try{const s=(await a.call('/api/status')).json;assert.equal(s.gemini_mode,'all-gemini');assert.match(s.prompt_sha,/^[0-9a-f]{12}$/);}finally{await a.close();}
  const o=await boot({},{});
  try{const s=(await o.call('/api/status')).json;assert.equal(s.gemini_mode,null);}finally{await o.close();}
});

test('all-gemini: the session opens, the party voice is never used, rehearsal is refused',async()=>{
  const gem=fakeGemini();const t=await boot({VOICE_BACKEND:'gemini',GEMINI_API_KEY:'k',GEMINI_MODE:'all-gemini'},{geminiFactory:gem});
  try{
    await t.call('/api/mode','POST',{mode:'ON'});await wait(1500);
    const v=gem.created[0];assert.ok(v);assert.equal(v.opens,1);assert.deepEqual(v.calls,[]);
    const r=await t.call('/api/audio/rehearsal','POST',{event:'welcome'});assert.equal(r.status,409);
  }finally{await t.close();}
});

test('all-gemini: the costume Judge is never called',async()=>{
  const {COSTUME_PROMPT}=await import('../src/presence/decisions.mjs');
  let costume=0,reads=0;
  const answers=[{type:'choice',name:'real_people_count',choice:'1',confidence:0.99},{type:'choice',name:'closest_person_location',choice:'path',confidence:0.99},{type:'choice',name:'camera_action',choice:'centered',confidence:0.99},{type:'choice',name:'next_capture_ms',choice:'1000',confidence:0.99}];
  const dir=await mkdtemp(join(tmpdir(),'gemc-'));
  const server=createServer({env:{CAMERA_URL:'rtsp://camera/stream2',OPENAI_API_KEY:'test',AUDIO_MODE:'linux',VOICE_BACKEND:'gemini',GEMINI_API_KEY:'k',GEMINI_MODE:'all-gemini',MODE_FILE:join(dir,'mode.json'),SESSIONS_DIR:join(dir,'s'),EVENT_AUDIT_DIR:join(dir,'e'),TRANSCRIPT_DIR:join(dir,'t'),JUDGE_LOG:'false'},
    captureImpl:async()=>Buffer.from([255,216,255,217]),geminiFactory:fakeGemini(),
    fetchImpl:async(url,opts)=>{reads++;if(String(opts?.body||'').includes(COSTUME_PROMPT))costume++;return {ok:true,json:async()=>({answers,output_text:'{}'})};}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    await fetch(base+'/api/mode',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({mode:'ON'})});
    await wait(4000);
    assert.equal(costume,0);
  }finally{await server.stopAutomation();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
