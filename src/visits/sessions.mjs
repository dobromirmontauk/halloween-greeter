// Porch session history. A session runs from the first confident presence >= 1 after empty
// until people are back at 0 AND Live (or debug speech) is no longer running.
import {mkdir,writeFile,readFile,readdir,chmod} from 'node:fs/promises';
import {join} from 'node:path';

const ID_RE=/^[A-Za-z0-9_-]{1,64}$/;
export const validSessionId=id=>typeof id==='string'&&ID_RE.test(id);
const stamp=ms=>new Date(ms).toISOString().replace(/[:.]/g,'-');
const LIVE_STATES=['starting','active','stopping'];

export function createSessionRecorder({dir,now=Date.now,flushMs=10000}={}){
 let open=null;const closed=new Map();let chain=Promise.resolve(),lastWrite=0,dirty=false,error=null,seq=0;
 const queue=fn=>{chain=chain.then(fn).catch(e=>{error='Session history write failed: '+(e.code||e.message||'error');});return chain;};
 const liveSeconds=s=>Math.round(s.live_sessions.reduce((sum,l)=>sum+Math.max(0,(l.ended_at??l.last_seen_at)-l.started_at),0)/1000);
 const view=s=>({id:s.id,started_at:s.started_at,ended_at:s.ended_at,open:s.ended_at==null,duration_ms:(s.ended_at??now())-s.started_at,peak_people:s.peak_people,mode:s.mode,
  live_seconds:liveSeconds(s),live_session_ids:s.live_sessions.map(l=>l.id),costumes:s.costumes,event_count:s.events.length});
 async function persist(s){
  if(!dir)return;
  await mkdir(dir,{recursive:true,mode:0o700});await chmod(dir,0o700).catch(()=>{});
  const file=join(dir,s.id+'.json');
  await writeFile(file,JSON.stringify(s,null,1),{mode:0o600});await chmod(file,0o600).catch(()=>{});
 }
 const save=()=>{if(!open)return;lastWrite=now();dirty=false;const snap=structuredClone(open);return queue(()=>persist(snap));};
 function close(t){
  for(const l of open.live_sessions)if(l.ended_at==null)l.ended_at=Math.min(t,l.last_seen_at);
  open.ended_at=t;open.events.push({type:'SESSION_END',at:t,phrase:''});save();closed.set(open.id,structuredClone(open));open=null;
 }
 // count: confident people count, or null when the Judge was uncertain (never opens or closes a session).
 function observe({count=null,liveState='idle',liveSessionId=null,liveStartedAt=null,debugSpeaking=false,debugMode=false}={}){
  const t=now(),liveRunning=LIVE_STATES.includes(liveState)||debugSpeaking;
  if(!open&&Number.isInteger(count)&&count>=1){
   open={id:stamp(t)+'-'+(++seq),started_at:t,ended_at:null,peak_people:count,mode:debugMode?'debug':'live',live_sessions:[],events:[],costumes:[],phases:[]};
   open.events.push({type:'SESSION_START',at:t,phrase:`${count} ${count===1?'person':'people'}`});dirty=true;save();
  }
  if(!open)return null;
  if(Number.isInteger(count)&&count>open.peak_people){open.peak_people=count;dirty=true;}
  const mine=LIVE_STATES.includes(liveState)&&liveSessionId;
  if(mine){
   let l=open.live_sessions.find(x=>x.id===liveSessionId);
   if(!l){l={id:liveSessionId,started_at:liveStartedAt||t,ended_at:null,last_seen_at:t};open.live_sessions.push(l);dirty=true;}
   l.last_seen_at=t;
  }
  for(const l of open.live_sessions)if(l.ended_at==null&&!(mine&&l.id===liveSessionId)){l.ended_at=l.last_seen_at;dirty=true;}
  if(count===0&&!liveRunning){close(t);return null;}
  if(dirty&&t-lastWrite>=flushMs)save();
  return open;
 }
 function noteEvent(event){
  if(!open||!event)return;
  open.events.push({type:event.type,at:event.at||now(),phrase:event.phrase||''});
  if(event.type==='COSTUMES'&&Array.isArray(event.labels))for(const label of event.labels)if(!open.costumes.includes(label))open.costumes.push(label);
  save();
 }
 function notePhase(phase){
  if(!open||!phase)return;
  const at=now();open.phases.push({phase,at});open.events.push({type:'PHASE',at,phrase:phase});save();
 }
 const readFileSafe=async id=>{try{return JSON.parse(await readFile(join(dir,id+'.json'),'utf8'));}catch{return null;}};
 async function list(){
  const out=new Map();
  if(dir){let names=[];try{names=await readdir(dir);}catch{}
   for(const n of names){if(!n.endsWith('.json'))continue;const id=n.slice(0,-5);if(!validSessionId(id))continue;const s=await readFileSafe(id);if(s)out.set(id,view(s));}}
  for(const [id,s] of closed)if(!out.has(id))out.set(id,view(s));
  if(open)out.set(open.id,view(open));
  return [...out.values()].sort((a,b)=>b.started_at-a.started_at);
 }
 async function raw(id){
  if(!validSessionId(id))return null;
  if(open&&open.id===id)return structuredClone(open);
  return closed.get(id)||(dir?await readFileSafe(id):null);
 }
 return {observe,noteEvent,notePhase,current:()=>open?view(open):null,list,raw,view,flush:()=>chain,status:()=>({open:!!open,error})};
}

// Detail view: recorded fields + transcript turns (from transcript-store) + judge-log read keys in the window.
export async function sessionDetail({recorder,transcriptStore,readKeys=async()=>[],id}){
 const s=await recorder.raw(id);
 if(!s)return null;
 const turns=[];
 for(const liveId of s.live_sessions.map(l=>l.id)){
  try{const rec=await transcriptStore.readSession(liveId);for(const t of rec.turns)turns.push(t);}catch{}
 }
 let reads=[];
 try{reads=await readKeys(s);}catch{}
 return {...recorder.view(s),events:s.events,phases:s.phases,live_sessions:s.live_sessions,transcript_session_ids:s.live_sessions.map(l=>l.id),turns,reads};
}
