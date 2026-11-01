// Heckling setting: off (default) = greet only when someone walks up the path; on = also call out to the sidewalk. Fake WebSocket, no real API calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGeminiLive} from '../src/voice/gemini-live.mjs';
import {createHeckling} from '../src/server/heckling.mjs';
import {createServer} from '../server.mjs';

const JPEG=Buffer.from([0xff,0xd8,0xff,0xd9]);
function fixture({env={},...options}={}){
  const sockets=[],speech=[],timers=[];let clock=1000;
  const spawnImpl=(command,args)=>{const c=new EventEmitter();Object.assign(c,{command,args,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null});c.kill=()=>{c.exitCode=0;};return c;};
  const webSocketFactory=()=>{const ws=new EventEmitter();ws.readyState=0;ws.sent=[];ws.send=t=>ws.sent.push(JSON.parse(t));ws.close=()=>{ws.readyState=3;};ws.terminate=ws.close;sockets.push(ws);return ws;};
  const live=createGeminiLive({env:{GEMINI_API_KEY:'k',GEMINI_MODE:'all-gemini',...env},webSocketFactory,spawnImpl,now:()=>clock,onSpeech:e=>speech.push(e),getFrame:()=>({bytes:JPEG,at:1}),usageIntervalMs:1e9,
    setIntervalImpl:()=>({unref(){}}),schedule:(fn,ms)=>{const t={fn,ms,at:clock+ms};timers.push(t);return t;},cancel:t=>{if(t)t.cancelled=true;},...options});
  const settle=()=>new Promise(r=>setImmediate(r));
  const open=async()=>{const p=live.open({instructions:'x'});await settle();const ws=sockets.at(-1);ws.readyState=1;ws.emit('open');ws.emit('message',Buffer.from(JSON.stringify({setupComplete:{}})));await p;return ws;};
  return {live,speech,timers,open,setClock:v=>{clock=v;},fireTimers:()=>{for(const t of timers.filter(x=>!x.cancelled&&!x.done&&x.at<=clock)){t.done=true;t.fn();}},
    texts:ws=>ws.sent.filter(m=>m.clientContent).map(m=>m.clientContent.turns[0].parts[0].text),nudges:()=>speech.filter(e=>e.kind==='nudge_sent')};
}
const ARRIVING={persons:[{score:0.9,zone:'path',dir:'arriving',bbox:[0.4,0.3,0.5,0.6]}],group:{state:'PATH'}};
const PORCH={persons:[{score:0.9,zone:'porch',bbox:[0.4,0.5,0.5,0.95]}],group:{state:'PATH'}};
const SIDE={persons:[{score:0.9,zone:'sidewalk',dir:'arriving',bbox:[0.4,0.05,0.5,0.15]}],group:{state:'SIDEWALK'}};

test('heckling off: sidewalk gets no cue but she stays warm; the path cue fires once; porch nudge 2 follows',async()=>{
  const f=fixture();const ws=await f.open();
  f.live.setPresence('SIDEWALK');f.live.noteDetect(SIDE);
  assert.deepEqual(f.texts(ws),[],'no cue on the sidewalk');
  assert.equal(f.live.status().wanted,true);
  f.live.setPresence('PATH');f.live.noteDetect(ARRIVING);f.live.noteDetect(ARRIVING);
  assert.deepEqual(f.texts(ws),['(Someone is walking up the path toward you.)']);
  assert.deepEqual(f.nudges().map(e=>[e.n,e.heckle]),[[1,false]]);
  f.live.noteDetect(PORCH);f.setClock(2500);f.fireTimers();
  assert.deepEqual(f.nudges().map(e=>e.n),[1,2]);
});

test('heckling off: a person on the porch alone also takes the nudge-1 slot',async()=>{
  const f=fixture();const ws=await f.open();f.live.setPresence('PATH');f.live.noteDetect(PORCH);
  assert.deepEqual(f.texts(ws),['(Someone is walking up the path toward you.)']);
});

test('heckling on: the sidewalk cue fires on leaving EMPTY, flag true; toggling is live',async()=>{
  let on=true;const f=fixture({heckling:()=>on});const ws=await f.open();
  f.live.setPresence('SIDEWALK');
  assert.deepEqual(f.texts(ws),['(Someone is on the sidewalk. Call out and heckle them in.)']);
  assert.deepEqual(f.nudges().map(e=>[e.n,e.heckle]),[[1,true]]);
  f.live.setPresence('EMPTY');on=false;f.live.setPresence('SIDEWALK');
  assert.equal(f.texts(ws).length,1,'now off: no new cue on the sidewalk');
});

test('setting persists across a restart and rejects junk',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'heckle-'));const file=join(dir,'h.json');
  try{
    const a=createHeckling({env:{},file});assert.equal(a.get(),false);
    await a.set('on');assert.equal(createHeckling({env:{},file}).get(),true);
    assert.equal(createHeckling({env:{HECKLING:'on'},file:null}).get(),true);
    await assert.rejects(a.set('maybe'));
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('POST /api/heckling toggles it, status and state show it, origin is checked',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'heckle-'));
  const server=createServer({env:{CAMERA_URL:'rtsp://camera/stream2',OPENAI_API_KEY:'test',AUDIO_MODE:'linux',MODE_FILE:join(dir,'mode.json'),HECKLING_FILE:join(dir,'h.json'),SESSIONS_DIR:join(dir,'s'),JUDGE_LOG:'false'}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  const call=async(path,method='GET',body,origin=base)=>{const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(method==='POST'?{Origin:origin}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,json:await res.json()};};
  try{
    assert.equal((await call('/api/status')).json.heckling,false);
    assert.equal((await call('/api/heckling','POST',{heckling:'on'})).json.heckling,true);
    assert.equal((await call('/api/status')).json.heckling,true);
    assert.equal((await call('/api/state')).json.heckling,true);
    assert.equal((await call('/api/heckling','POST',{heckling:'nope'})).status,400);
    assert.equal((await call('/api/heckling','POST',{heckling:'off'},'http://evil.example')).status,403);
    assert.equal((await call('/api/heckling','POST',{heckling:'off'})).json.heckling,false);
  }finally{await server.stopAutomation();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
