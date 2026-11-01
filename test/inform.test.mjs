// Never interrupt: no-reply info goes out as clientContent turnComplete:false (rate-limited, folded into the next cue);
// needs-reply cues wait for her to finish; realtimeInput.text is never used. Fake WebSocket, no real API calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createGeminiLive} from '../src/voice/gemini-live.mjs';

const JPEG=Buffer.from([0xff,0xd8,0xff,0xd9]);
function fixture({env={},...options}={}){
  const sockets=[],speech=[],timers=[];let clock=1000;
  const spawnImpl=(command,args)=>{const c=new EventEmitter();Object.assign(c,{command,args,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null});c.kill=()=>{c.exitCode=0;};return c;};
  const violations=[];
  const speaking=()=>speech.filter(e=>e.kind==='assistant_turn_start').length>speech.filter(e=>e.kind==='assistant_playback_end').length;
  const webSocketFactory=()=>{const ws=new EventEmitter();ws.readyState=0;ws.sent=[];ws.send=t=>{const m=JSON.parse(t);ws.sent.push(m);if(m.clientContent?.turnComplete===true&&speaking())violations.push(m.clientContent.turns[0].parts[0].text);};ws.close=()=>{ws.readyState=3;};ws.terminate=ws.close;sockets.push(ws);return ws;};
  const live=createGeminiLive({env:{GEMINI_API_KEY:'k',GEMINI_MODE:'all-gemini',HECKLING:'on',...env},webSocketFactory,spawnImpl,now:()=>clock,onSpeech:e=>speech.push(e),getFrame:()=>({bytes:JPEG,at:1}),usageIntervalMs:1e9,
    setIntervalImpl:()=>({unref(){}}),schedule:(fn,ms)=>{const t={fn,ms,at:clock+ms};timers.push(t);return t;},cancel:t=>{if(t)t.cancelled=true;},...options});
  const settle=()=>new Promise(r=>setImmediate(r));
  const open=async()=>{const p=live.open({instructions:'x'});await settle();const ws=sockets.at(-1);ws.readyState=1;ws.emit('open');ws.emit('message',Buffer.from(JSON.stringify({setupComplete:{}})));await p;return ws;};
  return {live,speech,timers,open,violations,sockets,setClock:v=>{clock=v;},clock:()=>clock,
    fireTimers:()=>{for(const t of timers.filter(x=>!x.cancelled&&!x.done&&x.at<=clock)){t.done=true;t.fn();}},
    cc:ws=>ws.sent.filter(m=>m.clientContent).map(m=>m.clientContent)};
}
const msg=o=>Buffer.from(JSON.stringify(o));
const real=ms=>new Promise(r=>setTimeout(r,ms));
const speak=(ws,text='Well hello there')=>ws.emit('message',msg({serverContent:{outputTranscription:{text}}}));
const done=ws=>ws.emit('message',msg({serverContent:{turnComplete:true}}));
const frame=(count,extra={})=>({persons:Array.from({length:count},()=>({score:0.9,zone:'path',bbox:[0.4,0.2,0.5,0.5]})),group:{state:'PATH',count,...extra}});
const NEAR={persons:[{score:0.9,zone:'porch',bbox:[0.4,0.5,0.5,0.95]}],group:{state:'PATH',count:2}};
const text=c=>c.turns[0].parts[0].text;

test('an inform mid-speech goes out at once with turnComplete:false and no interrupt',async()=>{
  const f=fixture();const ws=await f.open();f.live.setPresence('PATH');
  speak(ws);const before=f.cc(ws).length;
  f.live.noteDetect(frame(3));
  const sent=f.cc(ws).slice(before);
  assert.equal(sent.length,1);assert.equal(sent[0].turnComplete,false);assert.equal(text(sent[0]),'(Now 3 guests.)');
  assert.equal(f.speech.filter(e=>e.kind==='assistant_interrupted').length,0);
  const ev=f.speech.find(e=>e.kind==='inform_sent');assert.equal(ev.inform,'count');assert.ok(ev.text.length<=60);
  f.live.noteDetect(frame(3));assert.equal(f.cc(ws).length,before+1,'same count: not repeated');
});

test('informs are rate-limited: coalesced, latest wins',async()=>{
  const f=fixture();const ws=await f.open();f.live.setPresence('PATH');
  f.live.noteDetect(frame(1));f.live.noteDetect(frame(2));f.live.noteDetect(frame(3));
  assert.deepEqual(f.cc(ws).filter(c=>c.turnComplete===false).map(text),['(Now 1 guest.)'],'only the first went out');
  f.setClock(f.clock()+3000);f.fireTimers();
  assert.deepEqual(f.cc(ws).filter(c=>c.turnComplete===false).map(text),['(Now 1 guest.)','(Now 3 guests.)'],'one coalesced inform, the latest');
  assert.equal(f.live.noteCrowd({newcomers:2}),true);
  f.setClock(f.clock()+3000);f.fireTimers();
  assert.equal(text(f.cc(ws).at(-1)),'(2 more just arrived.)');
});

test('a due inform is folded into the needs-reply cue instead of a second message',async()=>{
  const f=fixture();const ws=await f.open();f.live.setPresence('PATH');
  f.live.noteDetect(frame(1)); // inform out; nudge 1 (sidewalk/path cue) already went with heckling on
  speak(ws);f.live.noteDetect(frame(2)); // inform pending (rate limit), nudge 2 not yet due
  f.live.noteDetect(NEAR); // nudge 2 queued while she talks
  const before=f.cc(ws).length;
  done(ws);await real(20);f.setClock(f.clock()+1000);f.fireTimers(); // past the cue gap, before the inform is due
  const added=f.cc(ws).slice(before);
  assert.equal(added.length,1,'one message');assert.equal(added[0].turnComplete,true);
  assert.equal(text(added[0]),"(Now 2 guests.) (They're at the porch now. Your turn.)");
  assert.ok(f.speech.some(e=>e.kind==='inform_sent'&&e.folded===true));
});

test('events mode: costume and crowd briefs go out as informs; handoff and welcome stay needs-reply',async()=>{
  const f=fixture({env:{GEMINI_MODE:'events',INFORM_MIN_MS:'0'}});const ws=await f.open();await f.live.start({welcomePrompt:'Hello there'});
  speak(ws);const before=f.cc(ws).length;
  assert.equal(f.live.sendPrompt('costume','She is a witch.'),true);
  assert.equal(f.live.instruct('Two arriving.','newcomers'),true);
  const sent=f.cc(ws).slice(before);assert.deepEqual(sent.map(c=>c.turnComplete),[false,false]);
  assert.equal(f.speech.filter(e=>e.kind==='assistant_interrupted').length,0);
  f.live.instruct('Hand off.','handoff');assert.equal(f.cc(ws).length,before+2,'handoff waits');
});

test('walk a whole visit with speech overlapping every event: no turnComplete:true while she is speaking',async()=>{
  const f=fixture();const ws=await f.open();
  const gap=async()=>{done(ws);await real(20);f.setClock(f.clock()+5000);f.fireTimers();};
  speak(ws);f.live.setPresence('SIDEWALK');                 // nudge 1 (heckle) while speaking
  f.live.setPresence('PATH');f.live.noteDetect(frame(2));  // count inform
  f.live.noteDetect(NEAR);f.live.noteCrowd({newcomers:1}); // nudge 2 due, crowd inform
  await gap();speak(ws);f.live.noteDetect(frame(3));f.live.noteCrowd({departures:1});
  await gap();f.setClock(f.clock()+10000);f.fireTimers();  // silence joke
  speak(ws);await gap();f.live.setPresence('EMPTY');
  assert.deepEqual(f.violations,[]);
  const kinds=f.cc(ws).map(c=>c.turnComplete);assert.ok(kinds.includes(true)&&kinds.includes(false));
  assert.ok(f.speech.filter(e=>e.kind==='nudge_sent').length>=2);
});

test('no code path sends realtimeInput.text',async()=>{
  const src=await readFile(new URL('../src/voice/gemini-live.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(src,/realtimeInput:\s*\{\s*text/);assert.doesNotMatch(src,/realtimeInput\.text/);
  const f=fixture();const ws=await f.open();f.live.setPresence('PATH');f.live.noteDetect(frame(2));f.live.noteDetect(NEAR);f.live.noteCrowd({newcomers:1});await f.live.stop?.('x');
  assert.equal(ws.sent.filter(m=>m.realtimeInput&&'text' in m.realtimeInput).length,0);
});
