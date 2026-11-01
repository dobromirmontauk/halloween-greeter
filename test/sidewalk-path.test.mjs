import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from '../server.mjs';
import {createJudgeEvents,GROUP_LABELS} from '../src/presence/judge-events.mjs';
import {PartyController,welcomePromptFor} from '../src/voice/party-flow.mjs';
import {deriveAppState} from '../src/server/app-state.mjs';
import {CameraDirector,CAPTURE_MS,CUTOFFS,PERSON_LOCATIONS,motionQuestions,parseMotion,parsePresence,mergeRead,groupLocation} from '../src/presence/decisions.mjs';
import {judgeAnswer,ans} from './judge-fixtures.mjs';

const presence=(count,loc,conf=0.99)=>({answers:[ans('real_people_count',count),ans('closest_person_location',loc,conf)]});
const motionOf=(locs,conf=0.99)=>({answers:locs.flatMap((l,i)=>[ans(`person_${i+1}_motion`,'present'),ans(`person_${i+1}_face_or_mask_visible`,'yes'),ans(`person_${i+1}_location`,l,conf)])});

test('per-person location: values, 0.80 cutoff, nearest-door group location, same ordering as motion',()=>{
 assert.equal(CUTOFFS.location,0.8);
 const q=motionQuestions().filter(x=>/_location$/.test(x.name));
 assert.deepEqual(q.map(x=>x.name),['person_1_location','person_2_location','person_3_location']);
 for(const x of q)assert.deepEqual(x.choices.map(c=>c.value),PERSON_LOCATIONS);
 assert.deepEqual(PERSON_LOCATIONS,['sidewalk','path','porch','not_visible','uncertain']);
 assert.equal(motionQuestions().some(x=>x.name==='visitor_location'),false);
 const m=parseMotion(motionOf(['sidewalk','path','porch']),3);
 assert.deepEqual(m.persons.map(p=>p.location),['sidewalk','path','porch']);assert.equal(m.visitor_location,'porch');
 assert.equal(parseMotion(motionOf(['sidewalk','path'],0.79),2).visitor_location,'uncertain','below 0.80 is uncertain');
 assert.equal(parseMotion(motionOf(['sidewalk','path'],0.8),2).visitor_location,'path');
 assert.equal(parseMotion(motionOf(['sidewalk','not_visible']),2).visitor_location,'sidewalk');
 assert.equal(groupLocation([undefined,'sidewalk','path']),'path');assert.equal(groupLocation([]),'uncertain');
});

test('Presence reports closest_person_location with the same cutoff and supplies the location without Motion',()=>{
 assert.equal(parsePresence(presence('2','path')).location,'path');
 assert.equal(parsePresence(presence('2','path',0.79)).location,'uncertain');
 assert.equal(parsePresence(presence('2','none')).location,'uncertain','none is not a location for present people');
 assert.equal(parsePresence(presence('0','sidewalk')).location,'none');
 assert.equal(parsePresence({answers:[ans('real_people_count','1')]}).location,'uncertain','missing answer is uncertain, not a failure');
 const first=mergeRead({presence:parsePresence(presence('1','sidewalk')),motion:null});
 assert.equal(first.visitor_location,'sidewalk');assert.equal(first.arriving,null);
 assert.equal(mergeRead({presence:parsePresence(presence('1','path')),motion:parseMotion(motionOf(['sidewalk']),1)}).visitor_location,'path','either source on the path wins');
});

const read=(loc,o={})=>({visitor_count:1,arriving:null,present:null,leaving:null,costume_slots:[],visitor_location:loc,...o});
const empty={visitor_count:0,arriving:0,present:0,leaving:0,costume_slots:[],visitor_location:'none'};
function machine(){let t=0;const m=createJudgeEvents({now:()=>t});const all=[];return {m,feed(d){t+=1000;const e=m.feed(d);all.push(...e.map(x=>x.type));return e;},all};}

test('sidewalk then path: PEOPLE_ON_SIDEWALK, then PEOPLE_ON_PATH, each after two reads',()=>{
 const f=machine();
 assert.equal(f.m.status().group_state,'EMPTY');
 f.feed(read('sidewalk',{visitor_count:2}));assert.deepEqual(f.all,[]);assert.equal(f.m.status().group_state,'EMPTY');
 f.feed(read('sidewalk',{visitor_count:2}));assert.deepEqual(f.all,['PEOPLE_ON_SIDEWALK']);
 const s=f.m.status();assert.equal(s.group_state,'SIDEWALK');assert.equal(s.group_label,'PEOPLE ON SIDEWALK');assert.equal(s.phrase,'People on sidewalk, 2 people.');
 f.feed(read('path',{visitor_count:2}));assert.deepEqual(f.all,['PEOPLE_ON_SIDEWALK']);
 f.feed(read('path',{visitor_count:2}));assert.deepEqual(f.all,['PEOPLE_ON_SIDEWALK','PEOPLE_ON_PATH']);
 assert.equal(f.m.status().group_state,'PATH');assert.equal(f.m.status().group_label,'PEOPLE ON PATH');assert.equal(f.m.status().last_event.count,2);
 assert.equal(GROUP_LABELS.EMPTY,null);
});

test('path first sighting from Presence alone fires PEOPLE_ON_PATH and one NEW_PARTY alias on the second read',()=>{
 const f=machine();f.feed(read('porch'));assert.deepEqual(f.all,[]);f.feed(read('porch'));
 assert.deepEqual(f.all,['NEW_PARTY','PEOPLE_ON_PATH']);assert.equal(f.m.status().last_event.type,'PEOPLE_ON_PATH','the announced event is last');
 for(let i=0;i<5;i++)f.feed(read('porch'));assert.equal(f.all.length,2);
});

test('path drifting back to the sidewalk fires PEOPLE_ON_SIDEWALK after two reads; returning is not a new party',()=>{
 const f=machine();f.feed(read('path'));f.feed(read('path'));
 f.feed(read('sidewalk'));assert.equal(f.m.status().group_state,'PATH','one sidewalk read is not enough');
 f.feed(read('path'));f.feed(read('sidewalk'));f.feed(read('sidewalk'));
 assert.deepEqual(f.all,['NEW_PARTY','PEOPLE_ON_PATH','PEOPLE_ON_SIDEWALK']);assert.equal(f.m.status().group_state,'SIDEWALK');
 f.feed(read('path'));f.feed(read('path'));assert.deepEqual(f.all.slice(3),['PEOPLE_ON_PATH'],'no second NEW_PARTY, so no handoff greeting');
});

test('an uncertain location or read breaks the streak and keeps the state; empty returns to EMPTY',()=>{
 const f=machine();f.feed(read('path'));f.feed(read('uncertain'));f.feed(read('path'));assert.deepEqual(f.all,[]);
 f.feed(read('path'));assert.deepEqual(f.all,['NEW_PARTY','PEOPLE_ON_PATH']);
 f.feed(read('uncertain'));f.feed(read('uncertain'));assert.equal(f.m.status().group_state,'PATH');
 f.feed(empty);assert.equal(f.m.status().group_state,'PATH');
 f.feed(empty);assert.equal(f.m.status().group_state,'EMPTY');
});

test('sidewalk people never open a party through the buckets; they do once they are on the path',()=>{
 const f=machine();const a=loc=>read(loc,{arriving:1});
 for(let i=0;i<4;i++)f.feed(a('sidewalk'));assert.deepEqual(f.all,['PEOPLE_ON_SIDEWALK']);
 f.feed(a('path'));f.feed(a('path'));assert.deepEqual(f.all,['PEOPLE_ON_SIDEWALK','NEW_PARTY','PEOPLE_ON_PATH']);
});

test('Live starts only on PATH; sidewalk people count as present and never reset absence',async()=>{
 let now=0;const log=[];
 const voice={start:async o=>log.push(['welcome',o.welcomePrompt]),sendPrompt:()=>true,instruct:t=>{log.push(['instruct',t]);return true;},stop:async r=>log.push(['stop',r])};
 const flow=new PartyController({voice,now:()=>now,schedule:()=>({}),cancel:()=>{}});
 const step=async d=>{now+=1000;await flow.observe({at:now},{visitor_count:1,costume_slots:[],arriving:null,present:null,leaving:null,...d});};
 await step({visitor_location:'sidewalk',group_state:'SIDEWALK'});await step({visitor_location:'sidewalk',group_state:'SIDEWALK'});
 assert.equal(flow.active,false);assert.deepEqual(log,[]);assert.equal(flow.absentSince,null);
 await step({visitor_location:'path',group_state:'SIDEWALK'});assert.equal(flow.active,false,'the debounced group state decides, not one read');
 await step({visitor_location:'path',group_state:'PATH'});assert.equal(flow.active,true);assert.equal(log.length,1);
 assert.doesNotMatch(log[0][1],/Trick or treat/);assert.match(log[0][1],/Happy Halloween/);
 await step({visitor_location:'sidewalk',group_state:'SIDEWALK'});assert.equal(flow.active,true,'drift back keeps the session');
 await flow.onJudgeEvent({type:'PEOPLE_ON_SIDEWALK',count:2,buckets:{arriving:null,present:null,leaving:null}});
 assert.deepEqual(log.filter(e=>e[0]==='instruct'),[],'no handoff greeting for sidewalk-only newcomers');
});

test('no sidewalk greeting mode remains',()=>{
 assert.doesNotMatch(welcomePromptFor('sidewalk'),/Trick or treat/);
 for(const file of ['src/voice/linux-live.mjs','src/voice/party-flow.mjs','server.mjs'])assert.doesNotMatch(readFileSync(new URL('../'+file,import.meta.url),'utf8'),/greetingMode|Trick or treat/,file);
});

test('cadence: EMPTY polls every 5 s, any people (sidewalk or path) every 1 s',async()=>{
 assert.deepEqual(CAPTURE_MS,{present:1000,empty:5000});
 const delays=[];let n=0,director;const reads=[presence('0','none'),presence('2','sidewalk'),presence('2','sidewalk'),presence('2','path')];
 director=new CameraDirector({capture:async()=>({at:Date.now(),bytes:Buffer.from([1])}),decide:async()=>mergeRead({presence:parsePresence(reads[n++])}),delay:async ms=>{delays.push(ms);if(delays.length>=reads.length)await director.stop();}});
 await director.start(false);for(let i=0;i<200&&delays.length<reads.length;i++)await new Promise(r=>setTimeout(r,5));
 assert.ok(delays[0]>4900&&delays[0]<=5000,'empty: about 5 s');assert.ok(delays.slice(1,4).every(d=>d>900&&d<=1000),'sidewalk and path: about 1 s');
});

test('app state exposes the group state and banner label',()=>{
 assert.equal(deriveAppState({automatic:true,visitorCount:2,groupState:'SIDEWALK'}).group_label,'PEOPLE ON SIDEWALK');
 assert.equal(deriveAppState({automatic:true,visitorCount:2,groupState:'PATH'}).group_state,'PATH');
 const e=deriveAppState({automatic:true,visitorCount:0});assert.equal(e.group_state,'EMPTY');assert.equal(e.group_label,null);
});

async function liveRun(location,expectStart){
 let resolveStart,active=false,timer;const started=new Promise(r=>{resolveStart=r;});
 const server=createServer({env:{CAMERA_URL:'rtsp://camera/stream2',OPENAI_API_KEY:'test',AUDIO_MODE:'linux',AUTO_START:'true'},
  captureImpl:async()=>Buffer.from([255,216,255,217]),
  voiceImpl:{status:()=>({active}),start:async input=>{active=true;resolveStart(input);},updateContext:()=>{},stop:async()=>{active=false;}},
  fetchImpl:async(url,opts)=>({ok:true,json:async()=>{
   if(!url.endsWith('/decisions'))return {output_text:JSON.stringify({people_visible:true,visitor_count:1,audience:'uncertain',costumes:[],props:[],clothing:[],costume_status:'uncertain',description:'A visitor.',speech_context:'A visitor.'})};
   return judgeAnswer(JSON.parse(opts.body),{count:'1',location,people:[{motion:'present',face:'yes'}]});}})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  const want=location==='sidewalk'?'SIDEWALK':'PATH';
  const deadline=Date.now()+9000;let status;
  do{status=await(await fetch(base+'/api/judge/status')).json();if(status.group_state===want)break;await new Promise(r=>setTimeout(r,150));}while(Date.now()<deadline);
  assert.equal(status.group_state,want,'first sighting location comes from Presence (Motion has no previous frame)');
  if(expectStart){const input=await Promise.race([started,new Promise((_,j)=>{timer=setTimeout(()=>j(Error('no start')),6000);})]);assert.doesNotMatch(input.welcomePrompt,/Trick or treat/);}
  else{await new Promise(r=>setTimeout(r,2500));assert.equal(active,false,'sidewalk people never start Live');const state=await(await fetch(base+'/api/state')).json();assert.equal(state.group_label,'PEOPLE ON SIDEWALK');}
 }finally{clearTimeout(timer);await server.stopAutomation();await new Promise(r=>server.close(r));}
}
test('server: sidewalk-only never starts Live; path and porch do, with no Trick or treat line',async()=>{
 await liveRun('sidewalk',false);await liveRun('path',true);await liveRun('porch',true);
});
