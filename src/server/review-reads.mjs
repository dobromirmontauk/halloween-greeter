// Unified Review reads: Judge-log entries + capture-store clip reads, scored by p_people and sorted into three tiers.
import {CUTOFFS} from '../presence/decisions.mjs';
import {validKey} from '../presence/judge-log.mjs';
import {validClipId} from '../presence/capture-store.mjs';
import {sanitizeAiLabel,parseAiBody,aiView,aiConsensus,aiDisagrees,aiState,humanVsAi,causesOf,aiSummary} from '../presence/ai-labels.mjs';

export const DEFAULT_HIGH=0.9,DEFAULT_LOW=0.1,MIN_LABELS=30;
export const TIERS=['borderline','people','no_people'];
export const PEOPLE_LABELS=['yes','no','unsure'];
const clamp01=v=>Math.min(1,Math.max(0,v));
const num=v=>Number.isFinite(v);

// Server thresholds: env REVIEW_HIGH / REVIEW_LOW, overridable per request (?high=&low=). low must stay below high.
export function thresholds(env={},q=null){
 const pick=(v,d)=>{if(v==null||v==='')return d;const n=Number(v);return Number.isFinite(n)&&n>=0&&n<=1?n:d;};
 let high=pick(q?.get?.('high'),pick(env.REVIEW_HIGH,DEFAULT_HIGH)),low=pick(q?.get?.('low'),pick(env.REVIEW_LOW,DEFAULT_LOW));
 if(low>=high){high=DEFAULT_HIGH;low=DEFAULT_LOW;}
 return {high,low,cutoff:CUTOFFS.count};
}

// p_people = 1 - P("0") from the Presence answer's top-3 probabilities.
//  - "0" in the top choices: p = 1 - P("0").
//  - "0" absent from the top choices: P("0") <= 1 - sum(top), so use the conservative lower bound p = sum(top) (capped at 1).
//  - no top choices: winner "0" -> p = 1 - confidence; non-zero winner -> p = confidence (lower bound).
//  - winner "uncertain" (or no answer): flagged uncertain; p is still computed when possible but the read is always Borderline.
export function pPeople(answers){
 const a=(answers||[]).find(x=>x&&x.name==='real_people_count');
 if(!a||a.choice==null)return {p:null,winner:null,confidence:null,top:null,uncertain:true};
 const winner=String(a.choice),conf=num(a.confidence)?a.confidence:null;
 const top=Array.isArray(a.top)?a.top.filter(t=>t&&t.choice!=null&&num(t.confidence)).map(t=>({choice:String(t.choice),confidence:t.confidence})):[];
 let p=null;
 if(top.length){const zero=top.find(t=>t.choice==='0');p=zero?1-zero.confidence:top.reduce((s,t)=>s+t.confidence,0);}
 else if(conf!=null)p=winner==='0'?1-conf:conf;
 return {p:p==null?null:clamp01(p),winner,confidence:conf,top:top.length?top:null,uncertain:winner==='uncertain'};
}

export function tierOf(v,{high=DEFAULT_HIGH,low=DEFAULT_LOW}={}){
 if(v.uncertain||v.errored||v.detector_disagree||v.p_people==null)return 'borderline';
 if(v.p_people>=high)return 'people';
 if(v.p_people<=low)return 'no_people';
 return 'borderline';
}

// Detector shadow agreement for one read: judge says people (winner != "0") vs detector count >= 1.
export function detectorDisagrees(winner,detectorCount){
 if(winner==null||winner==='uncertain'||!num(detectorCount))return false;
 return (winner!=='0')!==(detectorCount>=1);
}

// Effective "people present" label: explicit people_present, else derived from real_people_count. unsure/none -> not usable for the finder.
export function peopleLabel(label){
 if(!label)return null;
 if(PEOPLE_LABELS.includes(label.people_present))return label.people_present;
 if(label.real_people_count!=null&&label.real_people_count!=='')return String(label.real_people_count)==='0'?'no':'yes';
 return null;
}

function view({key,source,captured_at,answers,error,reason,detector,label,has_prev,prev_index,frame_index,clip_id,ai,presence_source=null}){
 const s=pPeople(answers),det=detector&&num(detector.count)?detector.count:null;
 const errored=Boolean(error),uncertain=s.uncertain||reason==='uncertain'||error?.code==='UNCERTAIN_PEOPLE_COUNT'||reason==='judge_error';
 return {key,source,captured_at,date:new Date(captured_at).toISOString().slice(0,10),p_people:s.p,winner:s.winner,confidence:s.confidence,top:s.top,
  presence_source,detector_location:detector?.location??null,detector_count:det,detector_disagree:detectorDisagrees(s.winner,det),uncertain,errored,reason:reason||null,has_prev:Boolean(has_prev),prev_index:prev_index??null,frame_index:frame_index??null,clip_id:clip_id??null,
  label:label||null,people_label:peopleLabel(label),labeled:Boolean(label),ai_labels:aiView(ai)};
}
export const judgeView=(entry,label,ai)=>view({ai,key:'j:'+entry.read_key,source:'judge',captured_at:entry.captured_at,answers:entry.answers,error:entry.error||entry.judges?.presence?.error,reason:entry.reason,detector:entry.detector,label,has_prev:entry.has_prev,presence_source:entry.presence_source});
export function captureViews(clip){
 const lines=clip.judge||[],resolve=clip.resolve,out=[];
 for(const l of lines){
  if(l.judge!=='presence'||l.frame_index==null)continue;
  const motion=lines.find(m=>m.judge==='motion'&&m.read_id===l.read_id),prev=motion?.frame_indexes?.[1]??null;
  const at=l.frame_ats?.[0]??l.at,lab=resolve?resolve(l.frame_index):null;
  out.push(view({key:`c:${clip.id}:${l.frame_index}`,source:'capture',captured_at:at,answers:l.answers,error:l.error,reason:null,detector:l.detector,label:lab&&Object.keys(lab).length?lab:null,has_prev:prev!=null,prev_index:prev,frame_index:l.frame_index,clip_id:clip.id,presence_source:l.presence_source,ai:clip.ai?.get(`c:${clip.id}:${l.frame_index}`)}));
 }
 return out;
}

export function parseKey(key){
 if(typeof key!=='string')return null;
 if(key.startsWith('j:')){const k=key.slice(2);return validKey(k)?{source:'judge',read_key:k}:null;}
 const m=key.match(/^c:([A-Za-z0-9_-]{1,64}):(\d{1,9})$/);
 return m&&validClipId(m[1])?{source:'capture',clip_id:m[1],frame_index:Number(m[2])}:null;
}

// Threshold finder: precision/recall/accuracy for "people present" at candidate cutoffs, from labeled yes/no reads with a p_people.
export const CANDIDATE_CUTOFFS=[0.3,0.35,0.4,0.45,0.5,0.55,0.6,0.65,0.7,0.75,0.8,0.85,0.9,0.95];
export function thresholdFinder(views,{minLabels=MIN_LABELS}={}){
 const rows=views.filter(v=>(v.people_label==='yes'||v.people_label==='no')&&v.p_people!=null);
 const n=rows.length,r=x=>Math.round(x*1000)/1000;
 const table=CANDIDATE_CUTOFFS.map(cut=>{
  let tp=0,fp=0,fn=0,tn=0;
  for(const v of rows){const pred=v.p_people>=cut-1e-9,actual=v.people_label==='yes';if(pred&&actual)tp++;else if(pred)fp++;else if(actual)fn++;else tn++;}
  return {cutoff:cut,tp,fp,fn,tn,precision:tp+fp?r(tp/(tp+fp)):null,recall:tp+fn?r(tp/(tp+fn)):null,accuracy:n?r((tp+tn)/n):null};
 });
 let best=null;
 for(const t of table){if(t.accuracy==null)continue;if(!best||t.accuracy>best.accuracy||(t.accuracy===best.accuracy&&(t.recall??-1)>(best.recall??-1)))best=t;}
 return {labeled:n,provisional:rows.filter(v=>v.provisional).length,min_labels:minLabels,needed:Math.max(0,minLabels-n),meaningful:n>=minLabels,current_cutoff:CUTOFFS.count,best:best?best.cutoff:null,table};
}

// Visits: consecutive reads from the same source with gaps <= gapMs. Annotates each view with visit_id and visit_size; returns the visits (ascending time).
export const VISIT_GAP_MS=5000;
export function groupVisits(views,gapMs=VISIT_GAP_MS){
 const sorted=[...views].sort((a,b)=>a.captured_at-b.captured_at),open={},visits=[];
 for(const v of sorted){
  let g=open[v.source];
  if(!g||v.captured_at-g[g.length-1].captured_at>gapMs){g=open[v.source]=[];visits.push(g);}
  g.push(v);
 }
 visits.forEach((g,i)=>{for(const v of g){v.visit_id=i;v.visit_size=g.length;}});
 return visits;
}
// One representative per visit among `candidates` (the read closest to the cutoff, ties to the newest). Adds visit_keys: unlabeled members of the visit, for "apply to visit".
export function onePerVisit(candidates,visits,distFn){
 const by=new Map();
 for(const v of candidates){const cur=by.get(v.visit_id);if(!cur||distFn(v)<distFn(cur)||(distFn(v)===distFn(cur)&&v.captured_at>cur.captured_at))by.set(v.visit_id,v);}
 return [...by.values()].map(v=>({...v,visit_keys:visits[v.visit_id].filter(m=>!m.labeled||m.key===v.key).map(m=>m.key)}));
}

const judgeCache=new WeakMap();
// All reads from both sources, deduped (a read present in the judge log and a clip counts once, as the judge-log read).
export async function collectReads({log,captures}){
 const out=[],seenAt=new Set();
 if(log?.enabled){
  let cache=judgeCache.get(log);if(!cache){cache=new Map();judgeCache.set(log,cache);}
  const labels=await log.labels(),ai=log.aiLabels?await log.aiLabels():new Map();
  for(const key of await log.keys()){
   let e=cache.get(key);
   if(!e){try{e=await log.entry(key);}catch{continue;}cache.set(key,e);}
   out.push(judgeView(e,labels.get(key)||null,ai.get('j:'+key)));seenAt.add(e.captured_at);
  }
 }
 if(captures?.enabled)for(const clip of await captures.reviewClips())for(const v of captureViews(clip)){if(seenAt.has(v.captured_at))continue;out.push(v);}
 return out;
}

function rng(seed){let s=(seed>>>0)||123456789;return()=>{s^=s<<13;s>>>=0;s^=s>>>17;s^=s<<5;s>>>=0;return s/4294967296;};}
const dist=v=>Math.abs((v.p_people??CUTOFFS.count)-CUTOFFS.count);
const sortBorderline=(a,b)=>dist(a)-dist(b)||b.captured_at-a.captured_at;

// opts: {tier,from,to,labeled:'yes'|'no'|'all' (default no),source,limit,offset,sample,seed}; th from thresholds().
export async function listReads(deps,opts={},th=thresholds()){
 let all=await collectReads(deps);
 const {from,to,source}=opts,dateRe=/^\d{4}-\d{2}-\d{2}$/;
 if(dateRe.test(from||''))all=all.filter(v=>v.date>=from);
 if(dateRe.test(to||''))all=all.filter(v=>v.date<=to);
 if(source==='judge'||source==='capture')all=all.filter(v=>v.source===source);
 for(const v of all)v.tier=tierOf(v,th);
 for(const v of all){v.ai_state=aiState(v);v.ai_disagree=aiDisagrees(v);v.ai_consensus=aiConsensus(v.ai_labels);v.human_vs_ai=humanVsAi(v);v.false_positive_causes=causesOf(v.ai_labels);}
 const visitList=groupVisits(all);
 for(const v of all)v.visit_keys=visitList[v.visit_id].filter(m=>!m.labeled).map(m=>m.key);
 const counts=Object.fromEntries(TIERS.map(t=>{const set=all.filter(v=>v.tier===t),labeled=set.filter(v=>v.labeled).length;return [t,{total:set.length,labeled,unlabeled:set.length-labeled}];}));
 const ai_summary=Object.fromEntries(TIERS.map(t=>[t,aiSummary(all.filter(v=>v.tier===t))]));
 // provisional=1: where no human yes/no label exists, an AI consensus yes/no stands in (marked provisional).
 const finder=thresholdFinder(opts.provisional==='1'||opts.provisional===true?all.map(v=>!(v.people_label==='yes'||v.people_label==='no')&&(v.ai_consensus==='yes'||v.ai_consensus==='no')?{...v,people_label:v.ai_consensus,provisional:true}:v):all);
 const tier=TIERS.includes(opts.tier)?opts.tier:'borderline';
 let items=all.filter(v=>v.tier===tier);
 const lab=opts.labeled==='yes'?'yes':opts.labeled==='all'?'all':'no';
 if(lab==='no')items=items.filter(v=>!v.labeled);else if(lab==='yes')items=items.filter(v=>v.labeled);
 if(['agree','disagree','none'].includes(opts.ai))items=items.filter(v=>v.ai_state===opts.ai);
 if(['agree','disagree'].includes(opts.human_vs_ai))items=items.filter(v=>v.human_vs_ai===opts.human_vs_ai);
 if(opts.false_positive_cause)items=items.filter(v=>opts.false_positive_cause==='any'?v.false_positive_causes.length>0:v.false_positive_causes.includes(opts.false_positive_cause));
 if(opts.visits==='1'||opts.visits===true)items=onePerVisit(items,visitList,dist);
 const total=items.length;
 if(tier==='borderline')items.sort(sortBorderline);else items.sort((a,b)=>b.captured_at-a.captured_at);
 if(opts.sort==='ai_disagree')items=[...items.filter(v=>v.ai_disagree),...items.filter(v=>!v.ai_disagree)];
 const sample=Math.min(200,Math.max(0,Number(opts.sample)||0));
 if(sample){const r=rng(opts.seed!=null?Number(opts.seed):Date.now()),pool=[...items];for(let i=pool.length-1;i>0;i--){const j=Math.floor(r()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]];}items=pool.slice(0,sample);}
 const limit=Math.min(2000,Math.max(1,Number(opts.limit)||20)),offset=sample?0:Math.max(0,Number(opts.offset)||0);
 return {thresholds:th,tier,labeled:lab,total,counts,ai_summary,finder,items:items.slice(offset,offset+limit),sample:sample||null};
}

const LABEL_KEYS=['people_present','real_people_count','closest_person_location','person_1_location','person_2_location','person_3_location','person_1_motion','person_2_motion','person_3_motion','arriving_count','present_count','leaving_count','costumes','notes','labeler'];
export async function saveLabel({log,captures},body){
 const k=parseKey(body?.key);
 if(!k)throw Object.assign(new Error('Invalid read.'),{status:400});
 if(body?.clear===true){
  if(k.source==='judge'){if(!log?.enabled)throw Object.assign(new Error('Judge log is disabled.'),{status:409});return log.addLabel({read_key:k.read_key,cleared:true});}
  if(!captures?.enabled)throw Object.assign(new Error('Capture store is disabled.'),{status:409});
  return captures.addLabel(k.clip_id,{frame_index:k.frame_index,cleared:true});
 }
 const fields=Object.fromEntries(LABEL_KEYS.filter(f=>body[f]!==undefined).map(f=>[f,body[f]]));
 if(k.source==='judge'){
  if(!log?.enabled)throw Object.assign(new Error('Judge log is disabled.'),{status:409});
  const prior=(await log.labels()).get(k.read_key),merged={};
  if(prior)for(const f of LABEL_KEYS)if(prior[f]!=null)merged[f]=prior[f];
  return log.addLabel({...merged,...Object.fromEntries(Object.entries(fields).filter(([,v])=>v!=null)),read_key:k.read_key});
 }
 if(!captures?.enabled)throw Object.assign(new Error('Capture store is disabled.'),{status:409});
 return captures.addLabel(k.clip_id,{...fields,frame_index:k.frame_index});
}
export async function readImage({log,captures},key,prev){
 const k=parseKey(key);if(!k)return null;
 if(k.source==='judge')return log?.enabled?log.image(k.read_key,{prev:Boolean(prev)}):null;
 if(!captures?.enabled)return null;
 if(prev){if(!/^\d{1,9}$/.test(String(prev)))return null;return captures.frame(k.clip_id,prev);}
 return captures.frame(k.clip_id,k.frame_index);
}

// Bulk AI label import. Body text: JSON array or NDJSON, max 2000. All-or-nothing: every record is validated (and its read must exist) before anything is written.
export async function saveAiLabels({log,captures},text,{now=Date.now}={}){
 const recs=parseAiBody(text).map(r=>sanitizeAiLabel(r,{parseKey,now}));
 const judge=[],caps=new Map();
 for(const r of recs){
  const k=parseKey(r.key);
  if(k.source==='judge'){
   if(!log?.enabled)throw Object.assign(new Error('Judge log is disabled.'),{status:409});
   if(!(await log.hasEntry(k.read_key)))throw Object.assign(new Error('Read not found: '+r.key),{status:404});
   judge.push(r);
  }else{
   if(!captures?.enabled)throw Object.assign(new Error('Capture store is disabled.'),{status:409});
   if(!(await captures.findClip(k.clip_id)))throw Object.assign(new Error('Clip not found: '+r.key),{status:404});
   if(!caps.has(k.clip_id))caps.set(k.clip_id,[]);caps.get(k.clip_id).push(r);
  }
 }
 if(judge.length)await log.addAiLabels(judge);
 for(const [id,list] of caps)await captures.addAiLabels(id,list);
 return {saved:recs.length,judge:judge.length,capture:recs.length-judge.length};
}
