// Pure helpers for the visit player (shared by public/visits.js, visit-recorder.mjs list summaries and tests). No DOM.
// One time mapping rules everything: video currentTime <-> capture wall time (ms from the clip start, the sidecar's `t`).
const clamp=(x,lo,hi)=>Math.min(hi,Math.max(lo,x));
export const isCounted=b=>!(b.ignored||b.suppressed||b.weak);

// New encodes use real per-frame durations (video time == wall time). Older clips were encoded at a constant fps, so video frame k
// is shown at k/fps but was captured at frame_times[k]; for those, map through frame_times.
export function makeClock(meta,durationSec){
  const ft=Array.isArray(meta.frame_times)?meta.frame_times:[],vms=meta.video_ms||0,dur=Number.isFinite(durationSec)?durationSec*1000:null;
  const fps=meta.fps||6,first=ft.length?ft[0]:0,span=ft.length?ft.at(-1)-first:0;
  // Real-time encodes start at the first saved frame (not wall 0) and last about span + one frame.
  // Constant-fps encodes last ft.length/fps. Pick whichever the actual duration matches better.
  const cfrMs=ft.length*1000/fps;
  const real=meta.encode?.timing==='real'||!ft.length||(dur==null?true:Math.abs(dur-span)<=Math.abs(dur-cfrMs));
  const last=Math.max(0,(dur??(real?span+1000/fps:vms)));
  if(real)return {real:true,offset:first,toWall:tv=>Math.max(0,tv)+first,toVideo:w=>clamp(w-first,0,last)};
  const lastK=ft.length-1;
  return {real:false,offset:0,
    toWall:tv=>ft[clamp(Math.floor(tv/1000*fps+1e-6),0,lastK)],
    toVideo:w=>{let lo=0,hi=lastK;while(lo<hi){const m=(lo+hi+1)>>1;if(ft[m]<=w)lo=m;else hi=m-1;}return clamp(lo/fps*1000+1,0,last);}};
}

// object-fit: contain rectangle of a vw x vh picture inside a bw x bh box.
export function contentRect(bw,bh,vw,vh){
  if(!(vw>0&&vh>0)||!(bw>0&&bh>0))return {x:0,y:0,w:bw||0,h:bh||0};
  const s=Math.min(bw/vw,bh/vh),w=vw*s,h=vh*s;return {x:(bw-w)/2,y:(bh-h)/2,w,h};
}

// Detection nearest in time (<= maxGap ms away, preferring the latest one not after `wall`).
export function detAt(dets,wall,maxGap=700){
  let best=null;for(const d of dets||[]){if(d.t<=wall)best=d;else{if(!best&&d.t-wall<=maxGap/2)best=d;break;}}
  return best&&Math.abs(wall-best.t)<=maxGap?best:null;
}
export function stateAt(meta,wall){
  let cur={state:meta.initial_state||'EMPTY',count:null};
  for(const e of meta.timeline||[]){if(e.t<=wall)cur=e;else break;}
  return cur;
}
export function rawCount(d){return d?d.boxes.filter(b=>isCounted(b)&&b.zone&&b.zone!=='other').length:0;}
export function countAt(meta,wall){
  const s=stateAt(meta,wall);
  const deb=(meta.counts||[]).filter(c=>c.t<=wall).at(-1);
  if(deb)return deb.count;
  if(Number.isFinite(s.count))return s.count;
  return rawCount(detAt(meta.detections,wall,1500));
}
const clean=s=>String(s??'').replace(/_/g,' ').trim();
const NOT_A_COSTUME=/^(none|no[ _]costume|no[ _]evident[ _]costume|not[ _]visible|unknown|uncertain|other[ _]costume|null)$/i;
const fmtConf=c=>c==null?'':' '+c.toFixed(2);
const accepted=a=>a&&a.accepted&&a.choice!=null&&a.choice!==false;
// Accepted answers of one judge in a read: [{label,conf,name,raw}], never the "nobody there / can't tell" values. `pick(name)` limits to the answers of that kind.
function judgeAnswers(read,judge,pick){
  const j=read?.judges?.[judge];if(!j||!Array.isArray(j.answers))return [];
  return j.answers.filter(a=>accepted(a)&&pick(String(a.name||'')))
    .map(a=>({label:clean(a.choice),raw:String(a.choice),conf:Number.isFinite(a.confidence)?a.confidence:null,name:a.name,detail:a.detail}));
}
const isCostumeSlot=n=>/^costume/.test(n)||!/_/.test(n);
const isMotionSlot=n=>/motion$/.test(n)||!/_/.test(n);
// "other costume" counts only with a described detail; no_evident/not_visible/uncertain are never a costume.
function costumeOf(a){
  if(/^other[ _]costume$/i.test(a.raw)){const d=String(a.detail??'').trim();return d||null;}
  return NOT_A_COSTUME.test(a.raw)?null:a.label;
}
export function answersOf(read,judge){
  const out=[];
  for(const a of judgeAnswers(read,judge,judge==='costume'?isCostumeSlot:judge==='motion'?isMotionSlot:()=>true)){
    const label=judge==='costume'?costumeOf(a):(NOT_A_COSTUME.test(a.raw)?null:a.label);
    if(label)out.push({label,conf:a.conf,name:a.name});
  }
  return out;
}
export function costumeMarkers(meta){
  const out=[];for(const r of meta.judge_reads||[])for(const a of answersOf(r,'costume'))out.push({t:r.t,label:a.label+fmtConf(a.conf)});
  return out;
}
export function motionMarkers(meta){
  const out=[];for(const r of meta.judge_reads||[])for(const a of answersOf(r,'motion'))out.push({t:r.t,label:a.label+fmtConf(a.conf)});
  return out;
}
export function errorMarkers(meta){
  const out=[];for(const r of meta.judge_reads||[])for(const [k,j] of Object.entries(r.judges||{}))if(j?.error)out.push({t:r.t,label:k+' error'});
  return out;
}
// One value per read for the costume / motion rows: distinct informative labels joined, or "no costume seen" when that was the accepted answer. null = this read says nothing.
function readValue(r,judge){
  const ans=answersOf(r,judge);
  if(ans.length)return {label:[...new Set(ans.map(a=>a.label))].join(', '),conf:Math.max(...ans.map(a=>a.conf??0))};
  if(judge==='costume'&&judgeAnswers(r,'costume',isCostumeSlot).some(a=>/^no[ _]evident[ _]costume$|^no[ _]costume$/i.test(a.raw)))return {label:'no costume seen',conf:null};
  return null;
}
// Consecutive reads with the same value collapse into one segment [t, end). The last one lasts until `end` (default: one second past its last read).
export function readSegments(meta,judge,end=null){
  const out=[];
  for(const r of meta.judge_reads||[]){
    const v=readValue(r,judge);if(!v)continue;
    const last=out.at(-1);
    if(last&&last.label===v.label){last.reads++;last.lastRead=r.t;last.conf=Math.max(last.conf??0,v.conf??0)||null;}
    else out.push({t:r.t,label:v.label,conf:v.conf,reads:1,lastRead:r.t});
  }
  out.forEach((s,i)=>{s.end=out[i+1]?out[i+1].t:(end!=null?Math.max(end,s.lastRead+1):s.lastRead+1000);});
  return out;
}
export const costumeSegments=(meta,end=null)=>readSegments(meta,'costume',end);
export const motionSegments=(meta,end=null)=>readSegments(meta,'motion',end);
// Which segment/marker labels fit: item {t,end,label}, axis ms over widthPx pixels. Adds show=true when the label (measured) fits inside its own span, so text never overlaps.
export function fitLabels(items,axis,widthPx,measure=s=>String(s).length*6.6,pad=10){
  return items.map(it=>({...it,show:Boolean(it.label)&&(it.end-it.t)/axis*widthPx>=measure(it.label)+pad}));
}
// The capture time of the picture the <video> actually shows at `wall`: the last saved frame at or before it (frames arrive ~3/s; the picture is a step function, so boxes must be looked up at the
// frame's time, not the playhead's, or they run ahead of a walker by up to one frame interval). Without frame_times the playhead time is returned.
// The encoder resamples to `fps` (sample-and-hold), so a frame captured at t is on screen from the next tick at or after t (not from t itself): pass fps to model that.
export function snapToFrame(frameTimes,wall,fps=0){
  if(!Array.isArray(frameTimes)||!frameTimes.length||!(wall>=frameTimes[0]))return wall;
  const first=frameTimes[0],q=fps>0?t=>first+Math.ceil((t-first)*fps/1000-1e-6)*1000/fps:t=>t;
  let lo=0,hi=frameTimes.length-1;
  if(!(q(frameTimes[0])<=wall))return wall;
  while(lo<hi){const m=(lo+hi+1)>>1;if(q(frameTimes[m])<=wall+0.5)lo=m;else hi=m-1;}
  return frameTimes[lo];
}
// Boxes to draw at capture time `wall`: interpolated between the two bracketing detections (same track id, else best IoU), nothing when no detection is within maxGap ms.
const iouOf=(a,b)=>{const w=Math.min(a[2],b[2])-Math.max(a[0],b[0]),h=Math.min(a[3],b[3])-Math.max(a[1],b[1]);if(w<=0||h<=0)return 0;const i=w*h;return i/((a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-i);};
export function boxesAt(dets,wall,maxGap=300){
  let a=null,b=null;
  for(const d of dets||[]){if(d.t<=wall)a=d;else{b=d;break;}}
  const da=a?wall-a.t:Infinity,db=b?b.t-wall:Infinity;
  if(Math.min(da,db)>maxGap)return [];
  if(da>maxGap||db>maxGap||!a||!b)return (da<=db?a:b).boxes.map(x=>({...x}));
  const span=b.t-a.t,f=span>0?(wall-a.t)/span:0,near=f<0.5?a:b,used=new Set(),out=[];
  const pairs=[];a.boxes.forEach((x,i)=>b.boxes.forEach((y,j)=>{
    if(x.track!=null&&y.track!=null){if(x.track===y.track)pairs.push({i,j,s:10});}
    else if(x.track==null&&y.track==null){const v=iouOf(x.b,y.b);if(v>=0.2)pairs.push({i,j,s:v});}
  }));
  pairs.sort((p,q)=>q.s-p.s);const matchA=new Map(),matchB=new Set();
  for(const p of pairs){if(matchA.has(p.i)||matchB.has(p.j))continue;matchA.set(p.i,p.j);matchB.add(p.j);}
  a.boxes.forEach((x,i)=>{
    if(matchA.has(i)){const y=b.boxes[matchA.get(i)],base=f<0.5?x:y;out.push({...base,b:x.b.map((v,k)=>v+(y.b[k]-v)*f)});}
    else if(near===a)out.push({...x});
  });
  if(near===b)b.boxes.forEach((y,j)=>{if(!matchB.has(j))out.push({...y});});
  return out;
}
// Direction of the group per detection (from box.dir, when present): arriving if any counted box arrives, else leaving if any leaves, else present.
export function dirOf(d){
  const ds=(d?.boxes||[]).filter(b=>isCounted(b)&&b.dir).map(b=>b.dir);
  return !ds.length?null:ds.includes('arriving')?'arriving':ds.includes('leaving')?'leaving':'present';
}
// Segments of constant group direction; [] when the sidecar has no `dir` fields.
export function dirSegments(meta){
  const out=[];const dets=meta.detections||[];
  dets.forEach((d,i)=>{const k=dirOf(d);if(!k)return;const last=out.at(-1);if(last&&last.dir===k)last.end=dets[i+1]?dets[i+1].t:d.t;else out.push({t:d.t,end:dets[i+1]?dets[i+1].t:d.t,dir:k});});
  return out;
}
export function costumeAt(meta,wall){
  const r=[...(meta.judge_reads||[])].filter(x=>x.t<=wall).reverse().map(x=>readValue(x,'costume')).find(Boolean);
  return r?r.label+(r.conf?fmtConf(r.conf):''):null;
}
// Everything the keyboard and the event row jump between, sorted by time.
export function eventsOf(meta){
  const ev=[];
  (meta.timeline||[]).forEach((e,i)=>{if(i>0||e.t>0)ev.push({t:e.t,kind:'state',label:e.state});});
  for(const m of costumeMarkers(meta))ev.push({...m,kind:'costume'});
  for(const m of motionMarkers(meta))ev.push({...m,kind:'motion',label:'motion '+m.label});
  for(const m of errorMarkers(meta))ev.push({...m,kind:'error'});
  for(const s of dirSegments(meta))if(s.dir!=='present')ev.push({t:s.t,kind:'dir',label:s.dir});
  return ev.sort((a,b)=>a.t-b.t);
}
// Debounced count segments: from meta.counts (future field) or the timeline's count.
export function countSegments(meta){
  const src=(meta.counts&&meta.counts.length?meta.counts:(meta.timeline||[]).filter(e=>Number.isFinite(e.count)));
  const end=Math.max(meta.end_ms||0,meta.video_ms||0),out=[];
  src.forEach((c,i)=>out.push({t:c.t,end:src[i+1]?src[i+1].t:end,count:c.count}));
  return out;
}
// Speech row model from meta.speech ([{t,kind,text?,source?}], ms from the clip start; older clips have none -> empty model).
// assistant/user: [{t,end,text}] segments; markers: everything else (connect, prompts sent, first word, live end); firstWord: first audio out (else first transcript) with its source;
// afterPathMs: first word minus the first PATH state in the timeline (null when either is missing).
export const SPEECH_MARKS={live_start_requested:'connect',live_connected:'connected',live_activated:'reused',welcome_triggered:'trigger',welcome_sent:'welcome sent',costume_sent:'costume sent',goodbye_sent:'goodbye sent',handoff_sent:'handoff sent',farewell_sent:'farewell sent',newcomers_sent:'newcomers sent',departures_sent:'departures sent',mixed_sent:'mixed sent',first_audio_out:'first word',first_transcript:'first text',prewarm_start:'warm',prewarm_close:'warm closed',live_end:'live end'};
export function speechOf(meta){
  const ev=[...(meta.speech||[])].filter(e=>e&&Number.isFinite(e.t)).sort((a,b)=>a.t-b.t);
  const end=Math.max(1,meta.end_ms||0,meta.video_ms||0),assistant=[],user=[],markers=[],visitor=[];let a=null,u=null;
  for(const e of ev){
    if(e.kind==='assistant_turn_start'){if(a)assistant.push({...a,end:e.t});a={t:e.t,text:''};}
    else if(e.kind==='assistant_turn_end'){assistant.push({t:a?a.t:Math.max(0,e.t-1),end:Math.max(e.t,(a?a.t:0)+1),text:e.text||''});a=null;}
    else if(e.kind==='user_speech_start'){if(u)user.push({...u,end:e.t});u={t:e.t};}
    else if(e.kind==='user_speech_end'){user.push({t:u?u.t:Math.max(0,e.t-1),end:Math.max(e.t,(u?u.t:0)+1)});u=null;}
    else if(e.kind==='visitor_line')visitor.push({t:e.t,end:e.t+Math.max(900,e.dur_ms||0),text:e.text||''}); // simulated visitor (replays only)
    else if(e.kind==='inform_sent')markers.push({t:e.t,kind:'inform_sent',label:'inform: '+(e.text||e.inform||''),source:null,reason:null});
    else if(e.kind==='nudge_sent'){const n=String(e.n);markers.push({t:e.t,kind:'nudge_sent',n,label:n==='silence'?'silence joke':e.heckle===true?'heckle':'nudge '+n,short:n==='silence'?'zz':(n==='1'&&e.heckle===true?'h1':'n'+n),source:null,reason:null});}
    else markers.push({t:e.t,kind:e.kind,label:SPEECH_MARKS[e.kind]||String(e.kind).replace(/_/g,' '),source:e.source||null,reason:e.reason||null});
  }
  if(a)assistant.push({t:a.t,end:Math.max(a.t+1,end),text:''});
  if(u)user.push({t:u.t,end:Math.max(u.t+1,end)});
  const fw=markers.find(m=>m.kind==='first_audio_out')||markers.find(m=>m.kind==='first_transcript')||(assistant[0]?{t:assistant[0].t,source:'turn'}:null);
  const firstWord=fw?{t:fw.t,source:fw.source||'audio'}:null;
  const pathAt=(meta.timeline||[]).find(e=>e.state==='PATH')?.t??null;
  return {assistant,user,visitor,markers,firstWord,pathAt,afterPathMs:firstWord&&pathAt!=null?firstWord.t-pathAt:null,has:ev.length>0};
}
export function speechLabel(meta){
  const m=speechOf(meta);if(!m.has)return 'Speech';
  return m.afterPathMs==null?'Speech':`first word ${(m.afterPathMs/1000).toFixed(1)}s after PATH${m.firstWord.source&&m.firstWord.source!=='audio'?' ('+m.firstWord.source+')':''}`;
}
export function seriesOf(meta){return (meta.detections||[]).map(d=>({t:d.t,n:rawCount(d)}));}
export function summaryOf(meta){
  const labels=[...new Set(costumeMarkers(meta).map(m=>m.label.replace(/ [\d.]+$/,'')))];
  const peak=Math.max(Number(meta.max_persons)||0,...(meta.timeline||[]).map(e=>Number(e.count)||0),...seriesOf(meta).map(p=>p.n));
  return {peak_count:peak,costumes:labels.slice(0,6)};
}
