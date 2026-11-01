// Pure view helpers for the operator page. No DOM access, so they can be tested in Node.
export const CUTOFFS={real_people_count:0.75,arriving_count:0.8,present_count:0.8,leaving_count:0.8,location:0.8,costume_1:0.85,costume_2:0.85,costume_3:0.85};
const JUDGE_ORDER=['presence','motion','costume'];

export const cutoffFor=name=>CUTOFFS[name]??(/costume/.test(name)?0.85:/location/.test(name)?CUTOFFS.location:0.8);
export const pct=c=>Number.isFinite(c)?Math.round(c*100):null;
export const fmtClock=sec=>Number.isFinite(sec)?`${Math.floor(sec/60)}:${String(Math.floor(sec%60)).padStart(2,'0')}`:'–:––';
export const fmtDuration=ms=>{const s=Math.max(0,Math.round(ms/1000));return s>=60?`${Math.floor(s/60)}m${String(s%60).padStart(2,'0')}s`:`${s}s`;};
export const fmtUsd=v=>Number.isFinite(v)?'$'+(v>=100?v.toFixed(0):v.toFixed(2)):'–';
export const fmtTime=ms=>Number.isFinite(ms)?new Date(ms).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'–';

// Per-person answers (e.g. person_1_motion, motion_2, p3_motion) are labelled "P1 motion".
export function answerLabel(name){
  const m=/^(?:person_?|p)(\d)_?(.*)$/i.exec(name)||/^(motion)_?(\d)$/i.exec(name)&&[0,RegExp.$2,RegExp.$1];
  if(name==='closest_person_location')return 'closest location';
  return m?`P${m[1]} ${(m[2]||'motion').replace(/_/g,' ')}`:name;
}
// Top choices as plain numbers: up to 3 {choice,pct,winner}. Falls back to the winner alone when no distribution is given.
export function topChoices(a){
  const winner=String(a?.choice??'–');
  const list=Array.isArray(a?.top)?a.top.filter(t=>t&&t.choice!=null).slice(0,3):[];
  if(!list.length)return [{choice:winner,pct:pct(a?.confidence),winner:true}];
  const w=list.findIndex(t=>String(t.choice)===winner),at=w<0?0:w;
  return list.map((t,i)=>({choice:String(t.choice),pct:pct(t.confidence),winner:i===at}));
}
const answerRow=a=>({name:String(a?.name??'?'),label:answerLabel(String(a?.name??'?')),choice:String(a?.choice??'–'),confidence:Number.isFinite(a?.confidence)?a.confidence:null,
  pct:pct(a?.confidence),top:topChoices(a),accepted:typeof a?.accepted==='boolean'?a.accepted:Number.isFinite(a?.confidence)&&a.confidence>=cutoffFor(a?.name)});

// Small label for what produced the presence count: detector (YOLO + zones), judge, or the Judge while the detector is down.
export function sourceLabel(lr){
  if(!lr||typeof lr!=='object')return null;
  if(lr.presence_fallback&&lr.presence_source!=='detector')return 'judge · detector down';
  return {detector:'detector',detector_tiebreak:'detector tiebreak',judge:'judge'}[lr.presence_source]||null;
}
// Accepts both shapes of last_read: {judges:{presence|motion|costume:{inference_ms,error,answers}}} or the flat {answers,inference_ms}.
export function normalizeRead(lr){
  if(!lr||typeof lr!=='object')return null;
  let groups;
  if(lr.judges&&typeof lr.judges==='object'){
    const names=Object.keys(lr.judges).sort((a,b)=>{const ia=JUDGE_ORDER.indexOf(a),ib=JUDGE_ORDER.indexOf(b);return (ia<0?99:ia)-(ib<0?99:ib);});
    groups=names.map(name=>{const j=lr.judges[name]||{};return {judge:name,inference_ms:j.inference_ms??null,error:j.error||null,rows:(j.answers||[]).map(answerRow)};});
  }else groups=[{judge:'judge',inference_ms:lr.inference_ms??null,error:null,rows:(lr.answers||[]).map(answerRow)}];
  return {read_id:lr.read_id??null,captured_at:lr.captured_at??null,decided_at:lr.decided_at??null,uncertain:!!lr.uncertain,multi:!!lr.judges,
    groups,persons:Array.isArray(lr.persons)?lr.persons:[],buckets:lr.buckets||null,source:sourceLabel(lr)};
}

// ---- Main page: Detector (live) and Last Judge read ----
export const fmtAge=ms=>{if(!Number.isFinite(ms))return '–';const s=Math.max(0,Math.round(ms/1000));return s<5?'just now':s<60?`${s} s ago`:s<3600?`${Math.floor(s/60)} min ago`:`${Math.floor(s/3600)} h ago`;};
// Detector panel model from /api/detector/status. Never uses Judge vocabulary: a detector read is a count by zone plus a score.
export function detectorView(status){
  const lat=status&&typeof status==='object'?status.latest:null;
  if(!lat)return null;
  const zoneN=z=>(lat.persons||[]).filter(p=>p.zone===z).length;
  const top=Math.max(0,...(lat.persons||[]).map(p=>Number(p.score)||0));
  const src=status.presence_source;
  return {group:lat.group?.state||'EMPTY',zones:{sidewalk:zoneN('sidewalk'),path:zoneN('path'),porch:zoneN('porch'),ignored:(lat.ignored||[]).length},other:zoneN('other'),
    topScore:(lat.persons||[]).length?top:null,ms:Number.isFinite(lat.ms)?Math.round(lat.ms):null,capturedAt:lat.at??null,
    source:src==='detector'?'detector':src==='judge_fallback'?'judge · detector down':src==='idle'?'idle':src==='judge'?'judge':null};
}
// Last Judge read model from last_judge_read (a read where a gpt Judge actually ran). null => "No Judge reads yet".
// Only the Judges that ran are listed; the previous-frame tile exists only when that read had one.
export function judgeReadView(ljr,nowMs=Date.now()){
  const r=normalizeRead(ljr);
  if(!r)return null;
  const groups=r.groups.filter(g=>ljr.judges?ljr.judges[g.judge]?.ran!==false:true);
  return {read_id:r.read_id,captured_at:r.captured_at,age:fmtAge(nowMs-(r.decided_at??r.captured_at)),groups,persons:r.persons,
    frames:[...(ljr.has_prev?[{key:'prev',label:'prev'}]:[]),{key:'now',label:'now'}]};
}

const STEPS=[['GREETING','Greeting'],['COSTUMES','Costumes'],['GOODBYE','Goodbye']];
const phaseSteps=phase=>{const at=STEPS.findIndex(([k])=>k===phase);return at<0?null:STEPS.map(([k,label],i)=>({key:k,label,status:i<at?'done':i===at?'current':'todo'}));};

// Banner view model from the server's /api/state (or null when polling failed).
export const MODES=['OFF','ON','DATA_CAPTURE'];
export const modeName=m=>m==='DATA_CAPTURE'?'Data capture':m==='ON'?'On':'Off';
// Capture status is read tolerantly: {recording, clip|clip_id|current_clip, frames, bytes|disk_bytes|disk_mb}.
export function captureView(cap){
  if(!cap||typeof cap!=='object')return {recording:false,text:'waiting'};
  const clip=cap.clip_id??cap.clip??cap.current_clip??null,id=typeof clip==='object'&&clip?(clip.id??clip.clip_id??null):clip;
  const frames=cap.frames??cap.frame_count??null,bytes=cap.bytes??cap.disk_bytes??(Number.isFinite(cap.disk_mb)?cap.disk_mb*1048576:null);
  const recording=cap.recording===true||(cap.recording==null&&id!=null);
  if(!recording)return {recording:false,text:'waiting'};
  const parts=[id!=null?`clip ${id}`:'recording'];
  if(Number.isFinite(frames))parts.push(`${frames} frames`);
  if(Number.isFinite(bytes))parts.push(`${(bytes/1048576).toFixed(bytes<10485760?1:0)} MB`);
  return {recording:true,text:parts.join(' · ')};
}
// Sidewalk / path group shown next to WATCHING and CAPTURING: {group:'SIDEWALK'|'PATH'|null,groupLabel}.
export const GROUP_LABELS={SIDEWALK:'PEOPLE ON SIDEWALK',PATH:'PEOPLE ON PATH'};
export const groupOf=state=>{const g=state?.group_state;return GROUP_LABELS[g]?{group:g,groupLabel:state.group_label||GROUP_LABELS[g]}:{group:null,groupLabel:null}};
const withGroup=(view,state)=>{const g=['WATCHING','CAPTURING'].includes(view.key)?groupOf(state):{group:null,groupLabel:null};return {...view,...g,full:g.group?`${view.label} · ${g.groupLabel}`:view.label};};
// Key the hysteresis compares: the app state plus the group, so group transitions are held and listed like any other change.
export const displayKey=view=>view.key+(view.group?'|'+view.group:'');
export function stateView(state,opts){return withGroup(stateViewBase(state,opts),state);}
function stateViewBase(state,{unreachable=false,mode=null,capture=null}={}){
  if(unreachable||!state)return {key:'UNREACHABLE',tone:'unreachable',label:'UNREACHABLE',detail:null,talkNow:false,steps:null,clock:null};
  if((mode==='DATA_CAPTURE'||state.app_state==='CAPTURING')&&state.app_state!=='ERROR'){
    const c=captureView(capture??state.capture);
    return {key:'CAPTURING',tone:'capturing',label:'CAPTURING',detail:c.text,recording:c.recording,talkNow:false,steps:null,clock:null};
  }
  const k=state.app_state,steps=phaseSteps(state.live_phase),phase=steps?.find(s=>s.status==='current')?.label;
  const clock=Number.isFinite(state.elapsed_seconds)?`${fmtClock(state.elapsed_seconds)} / ${fmtClock(state.limit_seconds)}`:null;
  const v={key:k,tone:k.toLowerCase(),detail:null,talkNow:false,steps,clock};
  switch(k){
    case 'OFF':return {...v,label:'OFF'};
    case 'WATCHING':return {...v,label:'WATCHING'};
    case 'PARTY_DETECTED':return {...v,label:'PARTY DETECTED'};
    case 'LIVE_STARTING':return {...v,label:'LIVE STARTING'};
    case 'LIVE_ACTIVE':return {...v,label:phase?`LIVE · ${phase.toUpperCase()}`:'LIVE',detail:'talk now',talkNow:true};
    case 'MUTED':return {...v,label:phase?`MUTED · ${phase.toUpperCase()}`:'MUTED'};
    case 'CLOSING':return {...v,label:'CLOSING',detail:Number.isFinite(state.absence_seconds_left)?`${state.absence_seconds_left}s of 30`:null};
    case 'DEBUG_SPEAKING':return {...v,label:'DEBUG SPEAKING',detail:state.phrase||null};
    case 'ERROR':return {...v,label:'ERROR',detail:state.message||null};
    default:return {...v,label:String(k)};
  }
}

export const modeLabel=state=>state?.mode==='debug'?'Debug speech':'Live';
export const triggerLabel=state=>state?.last_event?`${state.last_event.type} ${fmtTime(state.last_event.at)}`:'none';

export function sessionHeader(s,{time=fmtTime}={}){
  const live=s.mode==='debug'?'debug':`Live ${fmtClock(s.live_seconds)}`;
  const cost=Number.isFinite(s.cost_usd)?s.cost_usd:Number.isFinite(s.cost?.total_usd)?s.cost.total_usd:null;
  return {parts:[time(s.started_at),fmtDuration(s.duration_ms),`${s.peak_people} ppl`,live,...(cost!=null?[fmtUsd(cost)]:[])],open:!!s.open};
}

// Compact cost strip from /api/costs; null hides the strip.
export function costStrip(c){
  if(!c||typeof c!=='object')return null;
  const today=c.today||c.since_start;if(!today)return null;
  const cat=n=>today.by_category?.[n]?.usd;
  const flags=[];
  if((c.pricing||[]).some(p=>p.verified===false))flags.push('unverified');
  if(today.estimated||c.estimated)flags.push('estimated');
  const parts=[['Today',fmtUsd(today.total_usd)],['Judge',fmtUsd(cat('judge'))],['Luna',fmtUsd(cat('scene'))],['Live',fmtUsd(cat('live'))],['now',Number.isFinite(c.rate_usd_per_hour_last_10min)?fmtUsd(c.rate_usd_per_hour_last_10min)+'/hr':'–']];
  return {parts,flags};
}

// Rows for the expanded cost table: one per category, since-start vs today.
export function costRows(c){
  const out=[];
  for(const name of ['judge','scene','live']){
    const row=scope=>{const x=c?.[scope]?.by_category?.[name];return x?{usd:x.usd,calls:x.calls,tokens:(x.input_tokens||0)+(x.output_tokens||0),seconds:x.seconds,sessions:x.sessions}:null;};
    const t=row('today'),s=row('since_start');
    if(t||s)out.push({name:name==='scene'?'Luna scene':name,today:t,since_start:s});
  }
  return out;
}

// ---- Banner stability: one snapshot, poll-failure tolerance, display hysteresis ----
export const HOLD_MS=1500;           // a non-critical change must persist this long before the banner shows it
export const UNREACHABLE_AFTER=4;    // consecutive failed /api/state polls (~2 s) before UNREACHABLE
export const HISTORY_MAX=5;
const HELD_KEYS=['WATCHING','PARTY_DETECTED','CLOSING'];
// WATCHING / PARTY_DETECTED / CLOSING and CAPTURING-while-waiting are held; everything else (LIVE_*, ERROR, OFF, ...) shows at once.
export const isHeldView=view=>!!view&&(HELD_KEYS.includes(view.key)||(view.key==='CAPTURING'&&!view.recording));

// Folds one /api/state poll result into {state,fails}. A failed poll keeps the last good state.
export const reducePoll=(model,r)=>r?.ok&&r.data?{state:r.data,fails:0}:{state:model?.state??null,fails:(model?.fails??0)+1};
export const isUnreachable=model=>(model?.fails??0)>=UNREACHABLE_AFTER;

// One consistent snapshot: app mode and capture come from the same /api/state response. The slower /api/mode poll is only a fallback for older servers.
export const makeSnapshot=(state,fallback={})=>state?{state,appMode:state.app_mode??fallback.mode??null,capture:state.capture??fallback.capture??null}:null;

// Hysteresis. `cur` = {key,hold,appMode,snap,view}. Returns {shown,pending,history,changed}; never mutates `d`.
export function stepDisplay(d,cur,now,force=false){
  const commit=()=>({shown:cur,pending:null,changed:true,history:[{at:now,label:cur.view.full??cur.view.label,key:cur.key},...(d?.history||[])].slice(0,HISTORY_MAX)});
  if(!d)return commit();
  const shown=d.shown;
  const modeChanged=cur.appMode!=null&&shown.appMode!=null&&cur.appMode!==shown.appMode; // null = not known yet, not a change
  if(cur.key===shown.key&&!modeChanged)return {shown:{...cur,appMode:cur.appMode??shown.appMode},pending:null,history:d.history,changed:false};
  const groupOnly=!!cur.view&&!!shown.view&&cur.view.key===shown.view.key; // same app state, different sidewalk/path group: still held
  if(force||(!cur.hold&&!groupOnly)||modeChanged||shown.key==='UNREACHABLE')return commit();
  const pending=d.pending?.key===cur.key?d.pending:{key:cur.key,since:now};
  if(now-pending.since>=HOLD_MS)return commit();
  return {shown,pending,history:d.history,changed:false};
}
export const recentItems=history=>(history||[]).slice(0,HISTORY_MAX).map(x=>({time:fmtTime(x.at),label:x.label}));

// Per-person line from the decision's persons: "P1 arriving 91% · path 88% · face yes". Missing parts are skipped.
export function personLine(p,i=0){
  const part=(v,c)=>v==null||v===''?null:`${v}${pct(c)==null?'':' '+pct(c)+'%'}`;
  const face=p?.face_or_mask_visible;
  return [`P${p?.n??i+1} ${part(p?.motion??'–',p?.motion_confidence)}`,part(p?.location,p?.location_confidence),face?`face ${face}`:null].filter(Boolean).join(' · ');
}
// Sidewalk scream indicator on the main page (status from /api/state `scream`, src/presence/scream.mjs).
export function screamLabel(s,now=Date.now()){
 if(!s)return '–';
 if(!s.on)return 'Off';
 if(s.error)return '⚠ '+s.error;
 const head=s.playing?'Screaming!':!s.enabled?'Idle (mode not ON)':s.armed?'Armed':'Waiting for empty yard';
 const clips=Number.isFinite(s.clips)?` · ${s.clips} clip${s.clips===1?'':'s'}`:'';
 const last=s.screams>0?` · ${s.screams} so far, last ${fmtAge(now-s.last_at)}`:'';
 return head+clips+last;
}
