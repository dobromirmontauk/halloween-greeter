// Pure helpers for scripts/visit-eval: load visit clips, build piecewise-constant timelines, score predicted vs truth, replay the tracker offline.
// Time is ms from the clip start. Truth is piecewise constant between samples ({clip,t,state}); the last sample extends to the clip's end_ms.
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {createPresenceTracker,trackerOptions} from '../../src/presence/presence-tracker.mjs';

export const STATES=['EMPTY','SIDEWALK','PATH'];
export const TRUTH_STATES=[...STATES,'unsure'];
export const FLAP_MATCH_MS=2000;

export function loadVisits(dir){
  const out=[];
  let ids=[];try{ids=readdirSync(dir).filter(n=>/^\d{8}-\d{6}-[a-f0-9]{6}$/.test(n)).sort();}catch{return out;}
  for(const id of ids){try{const m=JSON.parse(readFileSync(join(dir,id,'visit.json'),'utf8'));out.push({...m,id,dir:join(dir,id),has_video:existsSync(join(dir,id,'video.mp4'))});}catch{}}
  return out;
}
export function loadTruth(file){
  const by=new Map();
  for(const line of readFileSync(file,'utf8').split('\n')){
    if(!line.trim())continue;let r;try{r=JSON.parse(line);}catch{continue;}
    if(!r||typeof r.clip!=='string'||!Number.isFinite(r.t)||!TRUTH_STATES.includes(r.state))continue;
    if(!by.has(r.clip))by.set(r.clip,[]);by.get(r.clip).push({t:r.t,state:r.state});
  }
  for(const list of by.values())list.sort((a,b)=>a.t-b.t);
  return by;
}

// ---- intervals ----
// timeline [{t,state}] -> [{from,to,state}] covering [0,end]. Before the first entry the first state holds.
export function segments(timeline,end){
  if(!timeline.length||!(end>0))return [];
  const segs=[];
  timeline.forEach((e,i)=>{
    const from=i===0?0:Math.max(0,Math.min(end,e.t)),to=i+1<timeline.length?Math.min(end,Math.max(from,timeline[i+1].t)):end;
    if(to>from)segs.push({from,to,state:e.state});
  });
  return mergeSame(segs);
}
const mergeSame=segs=>{const out=[];for(const s of segs){const l=out.at(-1);if(l&&l.state===s.state&&l.to===s.from)l.to=s.to;else out.push({...s});}return out;};
const overlap=(a,b)=>Math.max(0,Math.min(a.to,b.to)-Math.max(a.from,b.from));
// Truth samples -> segments (the last runs to `end`). 'unsure' segments stay, to be masked.
export const truthSegments=(samples,end)=>segments(samples,end);

function episodes(segs,state){return mergeSame(segs.filter(s=>s.state===state));}
const known=tsegs=>tsegs.filter(s=>s.state!=='unsure');
const stats=a=>a.length?{n:a.length,mean:round(a.reduce((x,y)=>x+y,0)/a.length),median:round(median(a)),max:a.reduce((m,x)=>Math.abs(x)>Math.abs(m)?x:m,a[0])}:{n:0,mean:null,median:null,max:null};
const median=a=>{const s=[...a].sort((x,y)=>x-y),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;};
const round=x=>Math.round(x*10)/10;

// Score one clip. pred: timeline [{t,state}], truth: samples [{t,state}], end: clip end_ms.
export function scoreClip(pred,truth,end){
  const P=segments(pred,end),T=truthSegments(truth,end),K=known(T);
  const perState={};
  for(const S of STATES){
    const ps=P.filter(s=>s.state===S),ts=K.filter(s=>s.state===S);
    let tp=0,predT=0,truthT=0;
    // predicted time is counted only where truth is known
    for(const p of ps){for(const k of K)predT+=overlap(p,k);}
    for(const t of ts)truthT+=t.to-t.from;
    for(const p of ps)for(const t of ts)tp+=overlap(p,t);
    perState[S]={tp_ms:tp,pred_ms:predT,truth_ms:truthT};
  }
  const lat={SIDEWALK:{entry:[],exit:[],missed:0},PATH:{entry:[],exit:[],missed:0}};
  for(const S of ['SIDEWALK','PATH']){
    const pe=episodes(P,S);
    for(const te of episodes(T,S)){
      const hits=pe.filter(p=>overlap(p,te)>0);
      if(!hits.length){lat[S].missed++;continue;}
      lat[S].entry.push(hits[0].from-te.from);lat[S].exit.push(hits.at(-1).to-te.to);
    }
  }
  // flaps: predicted transitions with no truth transition (same destination, one-to-one, nearest first) within FLAP_MATCH_MS
  const trans=segs=>{const o=[];for(let i=1;i<segs.length;i++)o.push({t:segs[i].from,from:segs[i-1].state,to:segs[i].state});return o;};
  const kt=[];{let prev=null;for(const s of K){if(prev&&prev.state!==s.state)kt.push({t:s.from,to:s.state});prev=s;}}
  const used=new Set();let flaps=0,matched=0;const pt=trans(P);
  for(const p of pt){
    let best=-1,bd=Infinity;kt.forEach((k,i)=>{if(used.has(i)||k.to!==p.to)return;const d=Math.abs(k.t-p.t);if(d<=FLAP_MATCH_MS&&d<bd){bd=d;best=i;}});
    if(best>=0){used.add(best);matched++;}else flaps++;
  }
  // PATH events
  const pp=episodes(P,'PATH'),tp=episodes(K,'PATH'),inKnown=e=>K.some(k=>overlap(e,k)>0);
  let exactlyOne=0,missed=0,fragmented=0;
  for(const te of tp){const n=pp.filter(p=>overlap(p,te)>0).length;if(n===1)exactlyOne++;else if(n===0)missed++;else fragmented++;}
  const predScored=pp.filter(inKnown),predTrue=predScored.filter(p=>tp.some(te=>overlap(p,te)>0));
  const sidewalkOnly=!tp.length&&K.some(k=>k.state==='SIDEWALK');
  const pathEvents={truth:tp.length,pred:predScored.length,exactly_one:exactlyOne,missed,fragmented,false_pred:predScored.length-predTrue.length,sidewalk_only_clip:sidewalkOnly,false_path_on_sidewalk_only:sidewalkOnly?predScored.length:0};
  return {per_state:perState,latency:lat,flaps,matched_transitions:matched,pred_transitions:pt.length,truth_transitions:kt.length,path_events:pathEvents,known_ms:K.reduce((a,s)=>a+s.to-s.from,0)};
}

const ratio=(a,b)=>b>0?Math.round(a/b*1000)/1000:null;
// clips: [{clip,end_ms,pred,truth}] -> overall + per-clip report.
export function scoreAll(clips){
  const per=clips.map(c=>({clip:c.clip,...scoreClip(c.pred,c.truth,c.end_ms)}));
  const states={};
  for(const S of STATES){
    const tp=per.reduce((a,c)=>a+c.per_state[S].tp_ms,0),pr=per.reduce((a,c)=>a+c.per_state[S].pred_ms,0),tr=per.reduce((a,c)=>a+c.per_state[S].truth_ms,0);
    states[S]={iou:ratio(tp,pr+tr-tp),precision:ratio(tp,pr),recall:ratio(tp,tr),pred_s:round(pr/1000),truth_s:round(tr/1000),overlap_s:round(tp/1000)};
  }
  const latency={};
  for(const S of ['SIDEWALK','PATH'])latency[S]={entry_ms:stats(per.flatMap(c=>c.latency[S].entry)),exit_ms:stats(per.flatMap(c=>c.latency[S].exit)),missed:per.reduce((a,c)=>a+c.latency[S].missed,0)};
  const pe=per.reduce((a,c)=>{for(const k of Object.keys(c.path_events))if(typeof c.path_events[k]==='number')a[k]=(a[k]||0)+c.path_events[k];return a;},{});
  const predOk=pe.pred-pe.false_pred;
  const path_events={...pe,precision:ratio(predOk,pe.pred),recall:ratio(pe.exactly_one,pe.truth)};
  return {clips:per.length,flaps:per.reduce((a,c)=>a+c.flaps,0),states,latency,path_events,per_clip:per.map(c=>({clip:c.clip,known_s:round(c.known_ms/1000),flaps:c.flaps,
    iou:Object.fromEntries(STATES.map(S=>[S,ratio(c.per_state[S].tp_ms,c.per_state[S].pred_ms+c.per_state[S].truth_ms-c.per_state[S].tp_ms)])),path_truth:c.path_events.truth,path_pred:c.path_events.pred,path_exactly_one:c.path_events.exactly_one,false_path:c.path_events.false_pred}))};
}
export function joinTruth(visits,truthByClip,predOf=v=>v.timeline){
  return visits.filter(v=>truthByClip.has(v.id)).map(v=>({clip:v.id,end_ms:v.end_ms,pred:predOf(v),truth:truthByClip.get(v.id)}));
}

// ---- replay: re-run the real tracker over saved boxes ----
// opts: tracker option overrides (camelCase, as trackerOptions returns) ; presenceScore: cutoff over saved scores (boxes below it are ignored).
export function replayClip(visit,opts={},presenceScore=visit.presence_score??0.5){
  const tracker=createPresenceTracker({...(visit.tracker||trackerOptions({})),...opts});
  const zones=visit.zones||[];const timeline=[];
  for(const d of visit.detections||[]){
    const persons=(d.boxes||[]).filter(b=>!b.ignored&&!b.suppressed&&!b.weak&&b.s>=presenceScore).map(b=>({bbox:b.b,score:b.s}));
    const low=(d.boxes||[]).filter(b=>b.weak&&b.src!=='band'&&!b.ignored&&!b.suppressed&&b.s>=0.2&&b.s<presenceScore).map(b=>({bbox:b.b,score:b.s})); // low-score bridge boxes (present when the sidecar floor was below the presence score)
    const side=(d.boxes||[]).filter(b=>b.zone==='sidewalk'&&!b.ignored&&!b.suppressed&&b.s>=0.35&&(b.src==='band'||(b.weak&&b.s<presenceScore))).map(b=>({bbox:b.b,score:b.s})); // weak/band sidewalk boxes: SIDEWALK state only
    const g=tracker.update(persons,d.t,zones,low,side);
    if(!timeline.length||timeline.at(-1).state!==g.state)timeline.push({t:d.t,state:g.state});
  }
  return timeline;
}
// "--GROUP_ENTER_MS_PATH=1000" env-style flags -> tracker options
export function optsFromFlags(flags){
  const env={};for(const [k,v] of Object.entries(flags))if(/^[A-Z_]+$/.test(k))env[k]=v;
  const base=trackerOptions(env),def=trackerOptions({}),out={};
  for(const k of Object.keys(base))if(base[k]!==def[k])out[k]=base[k];
  return out;
}
export function parseArgs(argv){
  const o={_:[]};
  for(let i=0;i<argv.length;i++){
    const a=argv[i];
    if(a.startsWith('--')){const eq=a.indexOf('=');if(eq>0)o[a.slice(2,eq)]=a.slice(eq+1);else if(argv[i+1]!==undefined&&!argv[i+1].startsWith('--'))o[a.slice(2)]=argv[++i];else o[a.slice(2)]=true;}
    else o._.push(a);
  }
  return o;
}
export const SWEEP_GRID={enterSidewalkMs:[500,1000,1500],enterPathMs:[500,750,1000,1500],exitMs:[2000,3000,4000],pathExitMs:[1000,1500,2500],holdMs:[500,1000]};
export function* gridOpts(grid=SWEEP_GRID){
  const keys=Object.keys(grid),rec=function*(i,acc){if(i===keys.length){yield {...acc};return;}for(const v of grid[keys[i]])yield* rec(i+1,{...acc,[keys[i]]:v});};
  yield* rec(0,{});
}
