import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PartyController,sessionLimitMs,HANDOFF_INSTRUCTION,FAREWELL_INSTRUCTION} from '../src/voice/party-flow.mjs';
import {createServer,persona} from '../server.mjs';
import {createLinuxLive} from '../src/voice/linux-live.mjs';

function fixture(options={}){
 let now=0;const timers=[],log=[];
 const voice={start:async o=>log.push(['welcome',o.welcomePrompt]),sendPrompt:(k,t)=>{log.push([k,t]);return true;},instruct:t=>{log.push(['instruct',t]);return true;},rearmPrompts:(...k)=>log.push(['rearm',...k]),stop:async r=>log.push(['stop',r])};
 const flow=new PartyController({voice,describe:async()=>'A pirate.',now:()=>now,schedule:(fn,ms)=>{const t={fn,at:now+ms};timers.push(t);return t;},cancel:t=>{t.cancelled=true;},...options});
 const seen=(extra={})=>({visitor_count:1,visitor_location:'path',arriving:1,present:0,leaving:0,costume_slots:[],...extra});
 return {flow,log,seen,
  step:async d=>{now+=1000;await flow.observe({at:now},d);},
  event:async(type,extra={})=>flow.onJudgeEvent({type,at:now,phrase:type,buckets:{arriving:0,present:0,leaving:0},...extra}),
  advance:async t=>{now=t;for(const timer of [...timers].sort((a,b)=>a.at-b.at))if(!timer.cancelled&&timer.at<=now){timer.cancelled=true;await timer.fn();}},
  instructs:()=>log.filter(e=>e[0]==='instruct').map(e=>e[1]),now:()=>now};
}

test('the NEW_PARTY that matches the first welcome sends no handoff; a later NEW_PARTY sends exactly one',async()=>{
 const f=fixture();await f.step(f.seen());await f.event('NEW_PARTY');
 assert.deepEqual(f.instructs(),[]);
 await f.event('NEW_PARTY');
 assert.deepEqual(f.instructs(),[HANDOFF_INSTRUCTION]);
 assert.match(HANDOFF_INSTRUCTION,/do not reuse anything the previous group said/);assert.match(HANDOFF_INSTRUCTION,/quick goodbye/);
 assert.deepEqual(f.log.filter(e=>e[0]==='rearm'),[['rearm','costume']]);
 assert.equal(f.flow.active,true);
});
test('a NEW_PARTY event that preceded the session start is treated as already greeted',async()=>{
 const g=fixture();await g.event('NEW_PARTY');await g.step(g.seen());assert.equal(g.instructs().length,0);
 await g.event('NEW_PARTY');assert.equal(g.instructs().length,1,'second party after start is a handoff');
});
test('LEAVING with nobody arriving or present sends one farewell and does not close the session',async()=>{
 const f=fixture();await f.step(f.seen());
 await f.event('LEAVING',{buckets:{arriving:1,present:0,leaving:1}});assert.deepEqual(f.instructs(),[]);
 await f.event('LEAVING',{buckets:{arriving:0,present:null,leaving:1}});assert.deepEqual(f.instructs(),[]);
 await f.event('LEAVING');assert.deepEqual(f.instructs(),[FAREWELL_INSTRUCTION]);
 await f.advance(f.now()+20000);assert.equal(f.log.some(e=>e[0]==='stop'),false,'still open');
});
test('session closes only after thirty seconds of confident zeros',async()=>{
 const f=fixture();await f.step(f.seen());
 for(let i=0;i<29;i++)await f.step({visitor_count:0});assert.equal(f.log.some(e=>e[0]==='stop'),false);
 await f.step({visitor_count:0});await f.step({visitor_count:0});assert.equal(f.log.some(e=>e[0]==='stop'),true);
});
test('after the time limit stops a session while the same party stays, no fresh greeting; a later NEW_PARTY allows one',async()=>{
 const f=fixture({limitMs:120000});await f.step(f.seen());
 await f.advance(114000);assert.ok(f.log.some(e=>e[0]==='goodbye'),'goodbye eight seconds before the limit');
 await f.advance(122000);assert.deepEqual(f.log.at(-1),['stop','session time limit']);assert.equal(f.flow.active,false);
 for(let i=0;i<5;i++)await f.step(f.seen({arriving:0,present:1}));
 assert.equal(f.log.filter(e=>e[0]==='welcome').length,1,'same party present: no restart');
 await f.event('NEW_PARTY');await f.step(f.seen());
 assert.equal(f.log.filter(e=>e[0]==='welcome').length,2);
});
test('session limit comes from SESSION_LIMIT_SECONDS, defaulting to and capped at thirty minutes',()=>{
 assert.equal(sessionLimitMs({}),1800000);assert.equal(sessionLimitMs({SESSION_LIMIT_SECONDS:'600'}),600000);assert.equal(sessionLimitMs({SESSION_LIMIT_SECONDS:'99999'}),1800000);assert.equal(sessionLimitMs({SESSION_LIMIT_SECONDS:'abc'}),1800000);
});
test('server passes the configured limit to Linux Live and reports it',async()=>{
 let liveOptions;
 const voice={status:()=>({active:false}),start:async()=>{},stop:async()=>{},updateContext:()=>{}};
 const server=createServer({env:{AUDIO_MODE:'linux',SESSION_LIMIT_SECONDS:'900'},liveFactory:o=>{liveOptions=o;return voice;}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const base=`http://127.0.0.1:${server.address().port}`;assert.equal((await(await fetch(base+'/api/status')).json()).session_limit_seconds,900);await fetch(base+'/api/audio/status');assert.equal(liveOptions.maxSessionMs,900000);}
 finally{await new Promise(r=>server.close(r));}
 const d=createServer({env:{}});await new Promise(r=>d.listen(0,'127.0.0.1',r));
 try{assert.equal((await(await fetch(`http://127.0.0.1:${d.address().port}/api/status`)).json()).session_limit_seconds,1800);}finally{await new Promise(r=>d.close(r));}
});
test('persona says handoffs only come through explicit instructions',()=>{
 assert.match(persona,/announced only by such an instruction/);assert.match(persona,/treat them as strangers/i);assert.doesNotMatch(persona,/under one minute/);
});

function liveFixture(options={}){
 const ws=new EventEmitter();ws.readyState=0;ws.sent=[];ws.send=t=>ws.sent.push(JSON.parse(t));ws.close=()=>{ws.readyState=3;};ws.terminate=ws.close;
 const spawnImpl=()=>{const c=new EventEmitter();Object.assign(c,{stdin:{on(){},destroy(){},write(){},writableLength:0},stdout:new EventEmitter(),stderr:{resume(){}},exitCode:null,kill(){c.exitCode=0;}});return c;};
 const live=createLinuxLive({env:{OPENAI_API_KEY:'k'},webSocketFactory:()=>ws,spawnImpl,closeTimeoutMs:15,...options});
 return {live,ws,start:async()=>{const p=live.start({instructions:'x'});await Promise.resolve();ws.readyState=1;ws.emit('open');ws.emit('message',Buffer.from(JSON.stringify({type:'session.started',session:{id:'s'}})));await p;}};
}
test('Live instruct sends an untyped commentary append only while active, and prompt kinds can be re-armed',async()=>{
 const f=liveFixture();assert.equal(f.live.instruct('hi'),false);await f.start();
 assert.equal(f.live.instruct('A new group is arriving.'),true);
 const sent=f.ws.sent.filter(e=>e.type==='session.commentary.append');assert.equal(sent.at(-1).delegation_id,null);assert.match(sent.at(-1).content,/new group/);
 assert.equal(f.live.sendPrompt('costume','a pirate'),true);assert.equal(f.live.sendPrompt('costume','again'),false);f.live.rearmPrompts('costume');assert.equal(f.live.sendPrompt('costume','again'),true);
 await f.live.stop('test');
});
