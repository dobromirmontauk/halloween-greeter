// ByteTrack-lite tracker (Kalman + Hungarian + low-score bridge), mixed arriving/leaving events, detector throughput (gap from start).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPresenceTracker,hungarian} from '../src/presence/presence-tracker.mjs';
import {createJudgeEvents,phraseFor} from '../src/presence/judge-events.mjs';
import {PartyController,FAREWELL_INSTRUCTION} from '../src/voice/party-flow.mjs';
import {createPersonDetector,analyze} from '../src/presence/person-detector.mjs';
import {replayClip} from '../scripts/visit-eval/lib.mjs';

// Simple full-frame zones: sidewalk on top, path in the middle, porch at the bottom centre. Porch centre (0.5, 0.94): moving down = arriving, up = leaving.
const zones=[
 {name:'sidewalk',kind:'sidewalk',points:[[0,0],[1,0],[1,0.3],[0,0.3]]},
 {name:'path',kind:'path',points:[[0,0.3],[1,0.3],[1,0.88],[0,0.88]]},
 {name:'porch',kind:'porch',points:[[0.3,0.88],[0.7,0.88],[0.7,1],[0.3,1]]}
];
const box=(x,y,w=0.05,h=0.2)=>[x-w/2,y-h,x+w/2,y]; // foot = (x,y)
const P=(x,y,score=0.9,w)=>({bbox:box(x,y,w),score});
const STEP=250;

test('hungarian: optimal rectangular assignment',()=>{
 assert.deepEqual(hungarian([[4,1,3],[2,0,5],[3,2,2]]).sort((a,b)=>a[0]-b[0]),[[0,1],[1,0],[2,2]]);
 assert.equal(hungarian([[1,9],[9,1],[5,5]]).length,2,'3 rows x 2 cols assigns the smaller side');
 assert.deepEqual(hungarian([]),[]);
});

test('two walkers crossing paths keep their ids (at most one swap)',()=>{
 const tr=createPresenceTracker({});let swaps=0,prev=null;const ids=[];
 for(let i=0;i<14;i++){
  const a=P(0.2+0.04*i,0.50),b=P(0.72-0.04*i,0.53); // cross near i=6, boxes overlap there
  tr.update([a,b],i*STEP,zones);
  const cur=[a.track,b.track];ids.push(cur);
  if(prev&&(cur[0]!==prev[0]||cur[1]!==prev[1]))swaps++;prev=cur;
 }
 assert.ok(swaps<=1,'id changes: '+swaps+' '+JSON.stringify(ids));
 assert.notEqual(ids.at(-1)[0],ids.at(-1)[1]);
});

test('a 4-kid cluster keeps count 4 and dir arriving through a one-frame occlusion (low-score bridge)',()=>{
 const tr=createPresenceTracker({});const xs=[0.44,0.50,0.56,0.62];let g,ids0=null,idsN=null;
 for(let i=0;i<16;i++){
  const y=0.40+0.03*i,kids=xs.map(x=>P(x,y,0.9,0.04));
  const occluded=i===9;
  const high=occluded?kids.filter((_,k)=>k!==2):kids,low=occluded?[{bbox:kids[2].bbox,score:0.3}]:[];
  g=tr.update(high,i*STEP,zones,low);
  if(i===3)ids0=kids.map(k=>k.track);
  if(i===15)idsN=kids.map(k=>k.track);
  if(i>=4)assert.equal(g.count,4,'count at frame '+i);
 }
 assert.deepEqual(idsN,ids0,'the occluded kid kept their id');
 assert.equal(g.motion.arriving,4);assert.equal(g.motion.leaving,0);assert.equal(g.tracks,4);
});

test('a low-score detection never starts a track and never counts',()=>{
 const tr=createPresenceTracker({});let g;
 for(let i=0;i<10;i++)g=tr.update([],i*STEP,zones,[{bbox:box(0.5,0.6),score:0.3}]);
 assert.equal(g.tracks,0);assert.equal(g.count,0);assert.equal(g.state,'EMPTY');
 // ...and a tentative (never confirmed) track is not bridged by low boxes either
 const t2=createPresenceTracker({});t2.update([P(0.5,0.6)],0,zones);
 assert.equal(t2.update([],STEP,zones,[{bbox:box(0.5,0.6),score:0.3}]).instant.confirmed,0);
});

test('the Kalman prediction carries a track through a 500 ms gap (no box overlap, 0.24 away)',()=>{
 const tr=createPresenceTracker({});let id=null,now=0;
 for(let i=0;i<6;i++){const p=P(0.2+0.08*i,0.5);tr.update([p],now,zones);id=p.track;now+=STEP;} // 0.32/s, last seen at x=0.6
 tr.update([],now,zones);now+=STEP;tr.update([],now,zones);now+=STEP; // 500 ms with no detections
 const back=P(0.6+0.08*3,0.5); // where constant velocity puts it after 750 ms
 tr.update([back],now,zones);
 assert.equal(back.track,id,'same track after the gap');
});

test('real frame timestamps: irregular frame gaps still predict correctly',()=>{
 const tr=createPresenceTracker({});let id=null;const ts=[0,100,450,500,900,1000];
 let last=null;
 ts.forEach(t=>{const p=P(0.2+0.3*t/1000,0.5);tr.update([p],t,zones);id=id??p.track;last=p.track;});
 assert.equal(last,id);
});

test('replayClip still runs on the saved sidecar format (with and without weak boxes)',()=>{
 const visit={zones,presence_score:0.5,detections:[...Array(8)].map((_,i)=>({t:i*250,boxes:[{b:box(0.5,0.5+0.02*i),s:0.9,zone:'path'},{b:box(0.2,0.5),s:0.3,weak:true}]}))};
 const tl=replayClip(visit,{});assert.ok(tl.length>=1);assert.equal(tl.at(-1).state,'PATH');
});

test('analyze: weak boxes in [0.2,0.5) are exposed as low, below 0.2 are dropped, none count as persons',()=>{
 const r=analyze({persons:[{bbox:box(0.5,0.6),score:0.9},{bbox:box(0.3,0.6),score:0.3},{bbox:box(0.7,0.6),score:0.1}]},{zones,minScore:0.5});
 assert.equal(r.count,1);assert.equal(r.low.length,1);assert.equal(r.weak.length,2);
});

// ---------- crowd events ----------
function scenario({guests,newcomers=[],leaversAt=Infinity,leavers=[],arriveAt=0,frames=24}){
 // guests: [{x,y}] standing on the path (greeted at the welcome). leavers: indexes of guests that walk up from leaversAt. newcomers: [{x}] walking down from y=0.4 starting at arriveAt.
 let now=0;const events=[];const tr=createPresenceTracker({});
 const judge=createJudgeEvents({now:()=>now,onEvent:e=>events.push(e)});
 const out={events,tr,judge,decisions:[],party:null,instructs:[],stopped:0,at:()=>now};
 const voice={start:async()=>{},sendPrompt:()=>true,stop:async()=>{out.stopped++;},instruct:text=>{out.instructs.push(text);return true;},rearmPrompts(){}};
 const party=new PartyController({voice,now:()=>now,schedule:()=>0,cancel:()=>{}});out.party=party;
 let g;
 const step=async i=>{
  now=i*STEP;
  const persons=guests.map((p,k)=>P(p.x,leavers.includes(k)&&i>=leaversAt?p.y-0.03*(i-leaversAt):p.y,0.9,0.04));
  newcomers.forEach(n=>{if(i>=arriveAt)persons.push(P(n.x,0.40+0.03*(i-arriveAt),0.9,0.04));});
  g=tr.update(persons,now,zones);
  if(i%4===3){ // one detector read per second
   const crowd={...g.crowd,...tr.takeCrowd()};
   const m=g.motion||{arriving:0,present:0,leaving:0};
   const decision={visitor_count:g.count,visitor_location:g.location,arriving:m.arriving,present:m.present,leaving:m.leaving,presence_source:'detector',crowd,leaveGroup:g.leaveGroup,costume_slots:[]};
   out.decisions.push(decision);
   for(const e of judge.feed(decision))await party.onJudgeEvent({...e,buckets:{arriving:m.arriving,present:m.present,leaving:m.leaving}});
  }
 };
 out.run=async()=>{
  for(let i=0;i<8;i++)await step(i); // guests settle, group is on PATH
  await party.begin('welcome');tr.setLive(true); // the welcome fires: everybody on the path is greeted
  for(let i=8;i<8+frames;i++)await step(i);
  return out;
 };
 return out;
}
const G=[{x:0.30,y:0.60},{x:0.38,y:0.60},{x:0.62,y:0.60}];

test('MIXED: 2 greeted guests leave while 2 newcomers arrive -> one MIXED event, one combined line, session stays open',async()=>{
 const s=await scenario({guests:G.slice(0,2),newcomers:[{x:0.55},{x:0.62}],leavers:[0,1],leaversAt:10,arriveAt:9,frames:28}).run();
 const crowd=s.events.filter(e=>['NEWCOMERS','DEPARTURES','MIXED'].includes(e.type));
 assert.deepEqual(crowd.map(e=>e.type),['MIXED'],JSON.stringify(s.events.map(e=>e.type)));
 assert.equal(crowd[0].newcomers,2);assert.equal(crowd[0].departures,2);assert.equal(crowd[0].phrase,'2 arriving, 2 leaving.');
 assert.equal(s.instructs.length,1);assert.match(s.instructs[0],/leaving/i);assert.match(s.instructs[0],/arriving/i);assert.match(s.instructs[0],/easy question/);
 assert.equal(s.party.active,true);assert.equal(s.stopped,0);
});

test('NEWCOMERS only: greeted guests stay, one newcomer arrives -> short welcome, costumes re-armed, session open',async()=>{
 const s=await scenario({guests:G.slice(0,2),newcomers:[{x:0.55}],arriveAt:9,frames:26}).run();
 const crowd=s.events.filter(e=>['NEWCOMERS','DEPARTURES','MIXED'].includes(e.type));
 assert.deepEqual(crowd.map(e=>e.type),['NEWCOMERS']);assert.equal(crowd[0].count,1);assert.equal(crowd[0].phrase,'1 arriving.');
 assert.equal(s.instructs.length,1);assert.match(s.instructs[0],/Newcomers brief/);assert.equal(s.party.active,true);
});

test('DEPARTURES only: one greeted guest leaves, the others remain -> short goodbye to the leaver, session open',async()=>{
 const s=await scenario({guests:G,leavers:[0],leaversAt:10,frames:24}).run();
 const crowd=s.events.filter(e=>['NEWCOMERS','DEPARTURES','MIXED'].includes(e.type));
 assert.deepEqual(crowd.map(e=>e.type),['DEPARTURES']);assert.equal(crowd[0].phrase,'1 leaving.');
 assert.equal(s.instructs.length,1);assert.match(s.instructs[0],/Departures brief/);assert.equal(s.party.active,true);assert.equal(s.stopped,0);
});

test('everyone leaving: no DEPARTURES/MIXED, the normal farewell fires once and nothing closes the session',async()=>{
 const s=await scenario({guests:G,leavers:[0,1,2],leaversAt:10,frames:32}).run();
 assert.equal(s.events.filter(e=>['NEWCOMERS','DEPARTURES','MIXED'].includes(e.type)).length,0,JSON.stringify(s.events.map(e=>e.type)));
 assert.ok(s.events.some(e=>e.type==='LEAVING'));
 assert.deepEqual(s.instructs,[FAREWELL_INSTRUCTION]);assert.equal(s.stopped,0);
});

test('a greeted person who is briefly lost and re-found does not become a newcomer; tracks are only crowd-counted when live',()=>{
 const tr=createPresenceTracker({});
 for(let i=0;i<6;i++)tr.update([P(0.3,0.6),P(0.5,0.6)],i*STEP,zones);
 tr.setLive(true);
 for(let i=6;i<8;i++)tr.update([P(0.5,0.6)],i*STEP,zones); // 0.3 lost for 500 ms
 for(let i=8;i<14;i++)tr.update([P(0.3,0.6),P(0.5,0.6)],i*STEP,zones);
 assert.deepEqual(tr.takeCrowd(),{newcomers:0,departures:0});
 const off=createPresenceTracker({});for(let i=0;i<10;i++)off.update([P(0.5,0.4+0.03*i)],i*STEP,zones);
 assert.deepEqual(off.takeCrowd(),{newcomers:0,departures:0},'not live: nothing is reported');
});

test('phrases for debug speech',()=>{
 assert.equal(phraseFor({type:'NEWCOMERS',newcomers:2}),'2 arriving.');
 assert.equal(phraseFor({type:'DEPARTURES',departures:1}),'1 leaving.');
 assert.equal(phraseFor({type:'MIXED',newcomers:2,departures:1}),'2 arriving, 1 leaving.');
});

// ---------- detector throughput ----------
test('detector at DETECTOR_FPS=4 really processes ~4/s from a 6 fps preview with 130 ms inference (gap from start, newest frame wins)',async()=>{
 let clock=0,seq=0;const timers=[];
 const addTimer=(at,fn)=>{const t={at,fn,id:++seq,live:true};timers.push(t);return t;};
 const sidecar={status:()=>({state:'ready'}),start(){},stop(){},call:()=>new Promise(res=>addTimer(clock+130,()=>res({persons:[],ms:130,width:960,height:540})))};
 const det=createPersonDetector({env:{DETECTOR_FPS:'4'},sidecar,zonesFile:null,now:()=>clock,schedule:(fn,ms)=>addTimer(clock+ms,fn),cancel:t=>{if(t)t.live=false;}});
 det.start();
 const flush=async()=>{for(let i=0;i<4;i++)await new Promise(r=>setImmediate(r));};
 const DURATION=10000,INTERVAL=1000/6;let nextFrame=0,k=0;const startedAt=[];
 det.subscribe(r=>startedAt.push(r.at));
 for(;;){
  const due=timers.filter(t=>t.live).sort((a,b)=>a.at-b.at||a.id-b.id)[0];
  const tf=nextFrame<=DURATION?nextFrame:Infinity;
  if(!due&&tf===Infinity)break;
  if(due&&due.at<=tf){clock=due.at;due.live=false;due.fn();}
  else{clock=tf;nextFrame=(++k)*INTERVAL;det.onFrame({bytes:Buffer.from([1,2,3]),at:clock});}
  await flush();
 }
 const st=det.status(),rate=st.processed/(DURATION/1000);
 assert.ok(Math.abs(rate-4)<=0.3,`processed ${st.processed} in 10 s = ${rate}/s`);
 // each processed frame was fresh (the newest at the time), gaps are ~250 ms
 const gaps=startedAt.slice(1).map((v,i)=>v-startedAt[i]);assert.ok(gaps.every(g=>g>=160&&g<=340),'gaps '+gaps.map(Math.round));
 console.log(`# synthetic throughput: ${rate.toFixed(2)} frames/s (${st.processed} processed, ${st.dropped} superseded of ${k+1} preview frames)`);
 det.stop();
});
