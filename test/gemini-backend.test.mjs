import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../server.mjs';

const answers=[{type:'choice',name:'real_people_count',choice:'1',confidence:0.99},{type:'choice',name:'camera_action',choice:'centered',confidence:0.99},{type:'choice',name:'next_capture_ms',choice:'1000',confidence:0.99}];
async function boot(extraEnv={},{geminiFactory,liveFactory}={}){
  const dir=await mkdtemp(join(tmpdir(),'gem-'));
  const server=createServer({
    env:{CAMERA_URL:'rtsp://camera/stream2',OPENAI_API_KEY:'test',AUDIO_MODE:'linux',MODE_FILE:join(dir,'mode.json'),SESSIONS_DIR:join(dir,'s'),EVENT_AUDIT_DIR:join(dir,'e'),TRANSCRIPT_DIR:join(dir,'t'),JUDGE_LOG:'false',...extraEnv},
    captureImpl:async()=>Buffer.from([255,216,255,217]),geminiFactory,liveFactory,
    fetchImpl:async url=>({ok:true,json:async()=>url.endsWith('/decisions')?{answers}:{output_text:'{}'}})
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  const call=async(path,method='GET',body)=>{const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(method==='POST'?{Origin:base}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,json:await res.json()};};
  const close=async()=>{await server.stopAutomation();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});};
  return {call,close};
}
const fakeGemini=()=>{
  const created=[],f=opts=>{
    const v={opts,opens:0,closes:0,presence:[],wanted:false,alwaysOn:true,
      status:()=>({state:'idle',active:false,wanted:v.wanted,connected:v.wanted}),
      open:async()=>{v.opens++;v.wanted=true;return v.status();},close:async()=>{v.closes++;v.wanted=false;},setPresence:s=>v.presence.push(s),
      start:async()=>{},stop:async()=>{},prewarm:async()=>{},sendPrompt:async()=>true,instruct:()=>true,setMuted(){},updateContext(){},rearmPrompts(){}};
    created.push(v);return v;};
  f.created=created;return f;
};
const wait=ms=>new Promise(r=>setTimeout(r,ms));

test('default VOICE_BACKEND stays openai: gemini is never constructed, status shows gpt-live-1',async()=>{
  const gem=fakeGemini();const t=await boot({},{geminiFactory:gem});
  try{
    const s=(await t.call('/api/status')).json;assert.equal(s.voice_backend,'openai');assert.equal(s.model,'gpt-live-1');assert.equal(s.voice,'cinder');
    await t.call('/api/mode','POST',{mode:'ON'});await wait(700);assert.equal(gem.created.length,0);
  }finally{await t.close();}
});

test('VOICE_BACKEND=gemini: status line, one open session while mode ON, closed when mode leaves ON, presence gating fed',async()=>{
  const gem=fakeGemini();const t=await boot({VOICE_BACKEND:'gemini',GEMINI_API_KEY:'k',GEMINI_VOICE:'Gacrux'},{geminiFactory:gem});
  try{
    const s=(await t.call('/api/status')).json;
    assert.equal(s.voice_backend,'gemini');assert.equal(s.model,'gemini-3.8-live');assert.equal(s.voice,'Gacrux');assert.equal(s.voice_key_configured,true);
    await wait(700);assert.equal(gem.created.length,0,'mode OFF: no session, not even constructed');
    await t.call('/api/mode','POST',{mode:'ON'});await wait(900);
    assert.equal(gem.created.length,1);const v=gem.created[0];assert.equal(v.opens,1);assert.ok(v.presence.length>0&&v.presence.every(p=>typeof p==='string'));
    await wait(700);assert.equal(v.opens,1,'idempotent: one session only');
    await t.call('/api/mode','POST',{mode:'DATA_CAPTURE'});await wait(900);
    assert.equal(v.closes,1);assert.equal(v.wanted,false);
    await t.call('/api/mode','POST',{mode:'ON'});await wait(900);assert.equal(v.opens,2);
    await t.call('/api/mode','POST',{mode:'OFF'});await wait(900);assert.equal(v.closes,2);
  }finally{await t.close();}
});

test('gemini key missing is reported without a session',async()=>{
  const gem=fakeGemini();gem.created.length=0;
  const factory=()=>({status:()=>({wanted:false}),open:async()=>{throw new Error('GEMINI_API_KEY is required');},close:async()=>{},setPresence(){},alwaysOn:true});
  const t=await boot({VOICE_BACKEND:'gemini'},{geminiFactory:factory});
  try{await t.call('/api/mode','POST',{mode:'ON'});await wait(900);const s=(await t.call('/api/status')).json;assert.equal(s.voice_key_configured,false);assert.match(s.voice_error,/GEMINI_API_KEY/);}finally{await t.close();}
});
