// Scorecard metrics for one conversation (a replay run or the original clip) and aggregation per backend/settings. Pure.
// Inputs share one clock: ms from the clip start. speech: [{t,kind,...}], timeline: [{t,state}] (group state changes), detections: [{t,boxes}] (to find the first path frame).
import {speechOf} from '../../public/visit-time.js';

const r1=x=>x==null?null:Math.round(x*10)/10;
const PATH_ZONES=new Set(['path','porch']);
export function firstPathFrameT(detections=[]){
  for(const d of detections)if((d.boxes||[]).some(b=>PATH_ZONES.has(b.zone)&&!b.ignored&&!b.suppressed&&!b.weak&&(b.s??1)>=0.5))return d.t;
  return null;
}
// Idle intervals [from,to) in which the group state is EMPTY, up to endMs. Before the first entry the yard is EMPTY.
export function emptyIntervals(timeline=[],endMs){
  const tl=[...timeline].sort((a,b)=>a.t-b.t),out=[];let cur={t:0,state:'EMPTY'};
  const flush=(to)=>{if(cur.state==='EMPTY'&&to>cur.t)out.push([cur.t,to]);};
  for(const e of tl){if(e.t<=0){cur={t:0,state:e.state};continue;}flush(Math.min(e.t,endMs));cur={t:e.t,state:e.state};}
  flush(endMs);return out;
}
const norm=s=>String(s||'').toLowerCase().replace(/[_-]+/g,' ').replace(/[^a-z0-9' ]+/g,' ').replace(/\s+/g,' ').trim();
// Simple label match: the whole label as a phrase, or any single word of 4+ letters of it (e.g. "witch hat" matches "witch").
export function costumeMention(text,labels){
  const hay=' '+norm(text)+' ',list=[...new Set((labels||[]).map(String))];
  if(!list.length)return {labels:[],mentioned:[],hit:null};
  const mentioned=list.filter(l=>{const n=norm(l);return n&&(hay.includes(' '+n+' ')||n.split(' ').some(w=>w.length>=4&&hay.includes(' '+w+' ')));});
  return {labels:list,mentioned,hit:mentioned.length>0};
}
export function scoreRun({speech=[],transcript=[],timeline=[],detections=[],labels={},cost_usd=null,endMs=null,graceMs=300,firstPathT=null}={}){
  const ev=[...speech].filter(e=>e&&Number.isFinite(e.t)).sort((a,b)=>a.t-b.t);
  const end=endMs??Math.max(0,...ev.map(e=>e.t),...detections.map(d=>d.t));
  const sp=speechOf({speech:ev,end_ms:end,video_ms:end,timeline});
  const firstPath=firstPathT??firstPathFrameT(detections)??timeline.find(e=>e.state==='PATH')?.t??null;
  const at=kind=>ev.find(e=>e.kind===kind)?.t??null;
  const welcome=at('welcome_sent'),firstAudio=at('first_audio_out');
  const empties=emptyIntervals(timeline,end);
  let emptyTurns=0,emptyMs=0;
  for(const a of sp.assistant){
    let ov=0;for(const [f,t] of empties)ov+=Math.max(0,Math.min(a.end,t)-Math.max(a.t,f));
    if(ov>graceMs){emptyTurns++;emptyMs+=ov;}
  }
  // barge-ins: explicit interrupted events, else a visitor starting to speak while the assistant is mid-turn
  const interruptedEvents=ev.filter(e=>e.kind==='assistant_interrupted').length;
  const overlapped=sp.user.filter(u=>sp.assistant.some(a=>u.t>a.t+50&&u.t<a.end)).length;
  const assistantText=transcript.filter(x=>x.role==='assistant').map(x=>x.text).join(' ')||sp.assistant.map(a=>a.text).join(' ');
  const costume=costumeMention(assistantText,[...(labels.accepted||[]),...(labels.truth||[])]);
  const goodbyeAt=ev.find(e=>e.kind==='goodbye_sent'||e.kind==='farewell_sent')?.t??null;
  return {
    first_path_t:firstPath,
    welcome_sent_t:welcome,first_audio_out_t:firstAudio,
    path_to_welcome_ms:firstPath!=null&&welcome!=null?r1(welcome-firstPath):null,
    path_to_first_audio_ms:firstPath!=null&&firstAudio!=null?r1(firstAudio-firstPath):null,
    spoke_while_empty:{count:emptyTurns,seconds:r1(emptyMs/1000)},
    interruptions:Math.max(interruptedEvents,overlapped),
    reconnects:ev.filter(e=>e.kind==='live_reconnect').length,
    turns:sp.assistant.length,visitor_turns:sp.user.length,
    cost_usd:cost_usd==null?null:Math.round(cost_usd*1e6)/1e6,
    costume,
    goodbye:goodbyeAt!=null,goodbye_t:goodbyeAt
  };
}
const nums=(list,f)=>list.map(f).filter(x=>Number.isFinite(x));
const mean=a=>a.length?r1(a.reduce((x,y)=>x+y,0)/a.length):null;
const median=a=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y),m=s.length>>1;return r1(s.length%2?s[m]:(s[m-1]+s[m])/2);};
// metrics list -> per-backend/settings aggregate.
export function aggregate(list){
  const n=list.length,w=nums(list,m=>m.path_to_welcome_ms),f=nums(list,m=>m.path_to_first_audio_ms),costumeKnown=list.filter(m=>m.costume?.hit!=null);
  return {runs:n,
    path_to_welcome_ms:{mean:mean(w),median:median(w),max:w.length?Math.max(...w):null,n:w.length},
    path_to_first_audio_ms:{mean:mean(f),median:median(f),max:f.length?Math.max(...f):null,n:f.length},
    spoke_while_empty:{runs_with:list.filter(m=>m.spoke_while_empty?.count>0).length,count:list.reduce((a,m)=>a+(m.spoke_while_empty?.count||0),0),seconds:r1(list.reduce((a,m)=>a+(m.spoke_while_empty?.seconds||0),0))},
    interruptions:list.reduce((a,m)=>a+(m.interruptions||0),0),reconnects:list.reduce((a,m)=>a+(m.reconnects||0),0),
    turns:{mean:mean(nums(list,m=>m.turns)),total:list.reduce((a,m)=>a+(m.turns||0),0)},
    cost_usd:Math.round(list.reduce((a,m)=>a+(m.cost_usd||0),0)*1e6)/1e6,
    costume_mention:{hits:costumeKnown.filter(m=>m.costume.hit).length,of:costumeKnown.length,rate:costumeKnown.length?Math.round(costumeKnown.filter(m=>m.costume.hit).length/costumeKnown.length*100)/100:null},
    goodbye:{yes:list.filter(m=>m.goodbye).length,of:n}};
}
