import http from 'node:http';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,SCENE_PROMPT,FRAMING_PROMPT} from '../server.mjs';
import {judgeAnswer} from './judge-fixtures.mjs';
const decisionResult=(n=1)=>judgeAnswer({questions:[{name:'real_people_count'}]},{count:String(n)});

test('missing real camera blocks scene and paid Live session, without returning a fake frame', async () => {
  let upstream=0;
  const server=createServer({env:{OPENAI_API_KEY:'test'},fetchImpl:async()=>{upstream++;throw Error('must not call');}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ['/api/frame','/api/scene','/api/session']) {
      const res=await fetch(base+path,path==='/api/frame'?{}:{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({sdp:'v=0'})});
      assert.equal(res.status,503); assert.match((await res.json()).error,/camera/i);
    }
    assert.equal(upstream,0);
  } finally {await new Promise(r=>server.close(r));}
});

import {GreetingGate,sceneContext} from '../public/scene.js';
test('fresh arrival is greeted once; two empty frames and cooldown permit next group; stale frames never greet',()=>{
 const gate=new GreetingGate(),at=100000;
 const seen=(people_visible,captured_at)=>({people_visible,captured_at});
 assert.equal(gate.update(seen(true,at),at),true);
 assert.equal(gate.update(seen(true,at+12000),at+12000),false);
 gate.update(seen(false,at+24000),at+24000);gate.update(seen(false,at+36000),at+36000);
 assert.equal(gate.update(seen(true,at+48000),at+48000),true);
 assert.equal(gate.update(seen(true,at),at+80000),false);
 assert.match(sceneContext(seen(true,at),at+80000),/stale/);
});
test('real frame bytes reach Responses; typed scene feeds documented GPT-Live WebRTC payload, and no key reaches browser',async()=>{
 const requests=[];
 const scene={people_visible:true,visitor_count:1,audience:'uncertain',costumes:[],props:[],clothing:[],costume_status:'uncertain',speech_context:'A visitor in ordinary clothing is here. Ask their favorite candy.',description:'One person.'};
 const server=createServer({env:{CAMERA_URL:'rtsp://private:password@camera/stream2',OPENAI_API_KEY:'server-only'},captureImpl:async()=>Buffer.from([255,216,255,217]),fetchImpl:async(url,opts)=>{
  requests.push({url,body:JSON.parse(opts.body),headers:opts.headers});
  return {ok:true,json:async()=>url.endsWith('/decisions')?decisionResult():url.endsWith('/responses')?{output:[{content:[{type:'output_text',text:JSON.stringify(scene)}]}]}:{session:{id:'live_test'},transport:{type:'webrtc',sdp:'answer'}}};
 }});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{
  const session=await fetch(base+'/api/session',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({sdp:'offer'})});
  assert.equal(session.status,201);const answer=await session.json();assert.equal(answer.transport.sdp,'answer');assert.equal(JSON.stringify(answer).includes('server-only'),false);
  assert.equal(requests[0].body.model,'gpt-6-luna');assert.equal(requests[0].body.questions[0].name,'real_people_count');assert.equal(requests[0].body.input[0].content[1].image_url,'data:image/jpeg;base64,/9j/2Q==');
  const live=requests.at(-1);assert.equal(live.body.session.model,'gpt-live-1');assert.equal(live.body.session.audio.output.voice,'cinder');
  assert.equal(live.body.session.input[0].content[0].type,'input_text');assert.equal(live.body.transport.sdp,'offer');
  const status=await (await fetch(base+'/api/status')).text();assert.equal(status.includes('server-only'),false);assert.equal(status.includes('password'),false);
  const denied=await fetch(base+'/api/scene',{method:'POST',headers:{Origin:'https://evil.example'}});assert.equal(denied.status,403);
 }finally{await new Promise(r=>server.close(r));}
});

test('configured LAN origin is accepted while unrelated hosts and origins are refused', async () => {
  const server=createServer({env:{PUBLIC_ORIGIN:'http://192.0.2.10:3031'}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const statusForHost=host=>new Promise((resolve,reject)=>{http.get(base+'/api/status',{headers:{Host:host}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);});
    assert.equal(await statusForHost('192.0.2.10:3031'),200);
    assert.equal(await statusForHost('unrelated.example'),403);
    const request=origin=>fetch(base+'/api/scene',{method:'POST',headers:{Host:'192.0.2.10:3031',Origin:origin,'Content-Type':'application/json'},body:'{}'});
    assert.equal((await request('http://192.0.2.10:3031')).status,503);
    assert.equal((await request('http://unrelated.example')).status,403);
  } finally {await new Promise(r=>server.close(r));}
});

test('fresh zero visitors blocks paid Live call and preserves exact image query history',async()=>{
 const calls=[];const server=createServer({env:{CAMERA_URL:'rtsp://private:secret@camera/stream2',OPENAI_API_KEY:'test'},captureImpl:async()=>Buffer.from([255,216,255,217]),fetchImpl:async(url,opts)=>{calls.push(url);return {ok:true,json:async()=>({...decisionResult(0),usage:{input_tokens:12}})};}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{const response=await fetch(base+'/api/session',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({sdp:'offer'})});assert.equal(response.status,409);assert.equal(calls.length,1);assert.ok(calls[0].endsWith('/decisions'));
 const records=await (await fetch(base+'/api/vision/history')).json();assert.equal(records.length,1);assert.equal(records[0].result.answers[0].choice,'0');assert.match(records[0].prompt,/Count living visitors/);assert.equal(records[0].questions[0].name,'real_people_count');assert.equal(records[0].status,'complete');assert.equal(records[0].usage.input_tokens,12);const image=Buffer.from(await(await fetch(base+records[0].image_url)).arrayBuffer());assert.deepEqual(image,Buffer.from([255,216,255,217]));assert.equal(JSON.stringify(records).includes('secret'),false);
 }finally{await new Promise(r=>server.close(r));}
});

import {AbsenceGate} from '../public/scene.js';
test('absence closes after30s valid observations; brief misses, people, stale and errors reset',()=>{
 const gate=new AbsenceGate(),scene=(n,t)=>({people_visible:n>0,visitor_count:n,captured_at:t});
 assert.equal(gate.update(scene(0,1000),1000),false);assert.equal(gate.update(scene(0,13000),13000),false);assert.equal(gate.update(scene(0,25000),25000),false);assert.equal(gate.update(scene(0,37000),37000),true);
 gate.reset();gate.update(scene(0,1000),1000);gate.update(scene(1,13000),13000);assert.equal(gate.update(scene(0,25000),25000),false);
 gate.update(null,30000);assert.equal(gate.update(scene(0,37000),37000),false);assert.equal(gate.update(scene(0,38000),80000),false);assert.equal(gate.update(scene(0,81000),81000),false);
});

test('both exact prompts exclude skeleton decorations but include actual skeleton-costumed visitors',()=>{
 for(const prompt of [SCENE_PROMPT,FRAMING_PROMPT]){assert.match(prompt,/skeleton decorations/);assert.match(prompt,/real (visitor|person) (wearing|in) a skeleton costume/i);assert.match(prompt,/reflections/);}
});

test('standalone Linux mode starts Decisions, Luna context and voice without any browser request',async()=>{
 const requests=[],voiceInputs=[];let active=false,started;const voiceStarted=new Promise(r=>{started=r;});
 const server=createServer({env:{CAMERA_URL:'rtsp://private:secret@camera/stream2',OPENAI_API_KEY:'test',AUDIO_MODE:'linux',AUTO_START:'true'},captureImpl:async()=>Buffer.from([255,216,255,217]),voiceImpl:{status:()=>({active}),start:async input=>{voiceInputs.push(input);active=true;started();},updateContext:()=>{},stop:async()=>{active=false;}},fetchImpl:async(url,opts)=>{requests.push({url,body:JSON.parse(opts.body)});return {ok:true,json:async()=>url.endsWith('/decisions')?decisionResult():{output_text:JSON.stringify({people_visible:true,visitor_count:1,audience:'uncertain',costumes:[],props:[],clothing:['blue hoodie'],costume_status:'no_evident_costume',description:'A visitor in a blue hoodie.',speech_context:'A visitor wears a blue hoodie. Ask what they are dressed as.'})}};}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{await Promise.race([voiceStarted,new Promise((_,reject)=>setTimeout(()=>reject(Error('standalone start timeout')),5000))]);assert.equal(requests[0].url,'https://api.openai.com/v1/decisions');assert.equal(requests.filter(r=>r.url.endsWith('/decisions')).length,5,'Live starts on the second read (PATH is debounced): read 1 = Presence + Costume (no previous frame, no Motion); read 2 = Presence + Motion + Costume');assert.match(voiceInputs[0].welcomePrompt,/Happy Halloween/);assert.equal(voiceInputs[0].scenePrompt,undefined);assert.doesNotMatch(voiceInputs[0].welcomePrompt,/visitor_count|next_capture_ms|camera_action/);
 }finally{await server.stopAutomation();await new Promise(r=>server.close(r));}
});

test('browser preview polling reads scheduled captures without grabbing more camera images',async()=>{
 let captures=0,decided;const decisionSeen=new Promise(r=>{decided=r;});
 const server=createServer({env:{CAMERA_URL:'rtsp://private:secret@camera/stream2',OPENAI_API_KEY:'test',AUTO_START:'true'},captureImpl:async()=>{captures++;return Buffer.from([255,216,255,217]);},fetchImpl:async()=>{decided();return {ok:true,json:async()=>decisionResult(0)};}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{await decisionSeen;await new Promise(r=>setImmediate(r));for(let n=0;n<4;n++)assert.equal((await fetch(base+'/api/frame')).status,200);assert.equal(captures,1);const state=await(await fetch(base+'/api/camera/status')).json();assert.equal(state.next_capture_ms,5000);assert.equal(state.visitor_count,0);
 }finally{await server.stopAutomation();await new Promise(r=>server.close(r));}
});

test('Luna-only visible history preserves matching image/results while Decisions debug remains available',async()=>{
 const server=createServer({env:{CAMERA_URL:'rtsp://private:secret@camera/stream2',OPENAI_API_KEY:'test'},captureImpl:async()=>Buffer.from([255,216,255,217]),fetchImpl:async(url)=>({ok:true,json:async()=>url.endsWith('/decisions')?decisionResult():{output_text:JSON.stringify({people_visible:true,visitor_count:1,audience:'uncertain',costumes:[],props:[],clothing:['blue hoodie'],costume_status:'no_evident_costume',description:'Visitor in a blue hoodie.',speech_context:'Ask their favorite candy.'})}})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{assert.equal((await fetch(base+'/api/scene',{method:'POST',headers:{Origin:base},body:'{}'})).status,200);const visible=await(await fetch(base+'/api/vision/history?kind=luna')).json(),all=await(await fetch(base+'/api/vision/history')).json();assert.equal(visible.length,1);assert.equal(visible[0].endpoint,'responses');assert.equal(visible[0].result.clothing[0],'blue hoodie');assert.ok(all.some(record=>record.endpoint==='decisions'));assert.deepEqual(Buffer.from(await(await fetch(base+visible[0].image_url)).arrayBuffer()),Buffer.from([255,216,255,217]));
 }finally{await new Promise(r=>server.close(r));}
});

test('saved text conversations list readable grouped turns and download without audio',async()=>{
 const events=[{session_id:'test_session',received_at:'2026-10-25T20:00:00Z',role:'user',text:'Hello '},{session_id:'test_session',received_at:'2026-10-25T20:00:01Z',role:'user',text:'there.'},{session_id:'test_session',received_at:'2026-10-25T20:00:05Z',role:'assistant',text:'Happy Halloween!'}];
 const {groupTranscriptEvents}=await import('../src/visits/transcript-store.mjs');const turns=groupTranscriptEvents(events);
 const store={listSessions:async()=>[{session_id:'test_session',event_count:3,started_at:events[0].received_at,last_at:events[2].received_at}],readSession:async id=>{assert.equal(id,'test_session');return {session_id:id,events,turns};}};
 const server=createServer({env:{AUDIO_MODE:'linux'},transcriptStoreImpl:store,voiceImpl:{status:()=>({active:true,sessionId:'test_session',transcripts:events})}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{const sessions=await(await fetch(base+'/api/transcripts')).json();assert.equal(sessions[0].duration_ms,5000);const saved=await(await fetch(base+'/api/transcripts/test_session')).json();assert.equal(saved.turns.length,2);assert.equal(saved.turns[0].text,'Hello there.');const live=await(await fetch(base+'/api/audio/status')).json();assert.equal(live.turns[0].text,'Hello there.');const download=await fetch(base+'/api/transcripts/test_session/download');assert.match(download.headers.get('Content-Disposition'),/attachment/);const text=await download.text();assert.match(text,/Guest: Hello there\./);assert.match(text,/Banjo player: Happy Halloween!/);assert.equal((await fetch(base+'/api/transcripts/..%2Fprivate')).status,404);
 }finally{await new Promise(r=>server.close(r));}
});

test('runtime persona includes approved standing jokes and excludes review candidates',async()=>{
 const {persona,approvedJokeBank}=await import('../server.mjs');assert.match(persona,/Welcome to the skeleton crew/);assert.match(persona,/The neighbors say it works on the living/);assert.equal(approvedJokeBank.includes('Unapproved review candidates'),false);assert.doesNotMatch(persona,/The skeleton crew never misses a deadline/);assert.doesNotMatch(persona,/You teenagers travel in packs now/);
});
