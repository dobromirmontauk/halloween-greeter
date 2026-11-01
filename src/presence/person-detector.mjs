// Always-on local person detector (YOLOX via the detector/ Python sidecar) with fixed-camera zones.
// Local only: frames go to a child process on this box, never to the network. Uses the sidecar client in src/lib/sidecar.mjs.
//
// DETECTOR=off              disable entirely (default: on in every app mode except OFF; no Python => it disables itself)
// PRESENCE_RESOLVER=primary (default) the detector + zones are the source of truth for presence (count, group state, location); the Presence judge does not run.
//                           If the detector is not ready or stale (no frame for DETECTOR_STALE_MS, default 3000) the old Judge presence path takes over and says so in /api/detector/status.
// DETECTOR_MODE=shadow      same as PRESENCE_RESOLVER=tiebreak: detect + log + compare with the Presence judge; the detector only settles uncertain Judge reads
// DETECTOR_PRESENCE_SCORE   (default 0.5) score cutoff for presence decisions; boxes between DETECTOR_MIN_SCORE (sidecar, default 0.25) and this stay in `weak`; those >= 0.2 are also `low` (the tracker's bridge stage: keeps a confirmed track alive, never starts one, never counts)
// SIDEWALK_PRESENCE_SCORE (default 0.35; 'off' disables): a box in [this, DETECTOR_PRESENCE_SCORE) whose foot is in the sidewalk zone counts toward SIDEWALK state only (pre-warm, visit recording). Never PATH, never the welcome, never counts on PATH.
// DETECTOR_STRATEGY=preview|preview+band (default preview+band). `preview` is the 960x540 preview -> YOLOX-tiny 416 pass every frame (DETECTOR_FPS); it alone decides PATH, porch, the welcome and counts.
//   `preview+band` adds an independent, UNGATED pass at BAND_FPS (default 1; 0 disables) on the NATIVE frame: the top DETECTOR_BAND (0.40) of the frame at full width, letterboxed to DETECTOR_BAND_SIZE (1280x320), run by a second
//   sidecar process (BAND_THREADS 2, `nice -n 10`, BAND_NICE=off to skip nice). It starts only while the preview pass is idle and one at a time, never queued. Its boxes (>= SIDEWALK_PRESENCE_SCORE, foot in the sidewalk zone)
//   only feed the tracker's `side` list (SIDEWALK state, pre-warm, visit recording); a band box with its foot on path/porch is ignored. They are shown in the overlay/visit sidecar as src:"band".
// DETECTOR_FPS (default 4): processing rate. The gap is measured from the previous START; a frame that arrives early is held as the pending latest and processed the moment the gap has elapsed (idle, newest frame wins).
// DETECTOR_MODE=off         same as DETECTOR=off
//
// Zones live in data/detector-zones.json (falls back to detector/zones.default.json): normalized polygons with kind
// sidewalk | path | porch (location) or ignore (static props). A person's location is the zone containing the bottom-centre of their box.
import {readFileSync,existsSync,statSync,mkdirSync,writeFileSync,renameSync,chmodSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSidecarClient} from '../lib/sidecar.mjs';
import {createPresenceTracker,trackerOptions} from './presence-tracker.mjs';

import {ROOT} from '../lib/paths.mjs';
const root=ROOT;
export const DEFAULT_ZONES_FILE=resolve(root,'detector','zones.default.json');
export const ZONE_KINDS=['sidewalk','path','porch','ignore'];
export const LOCATION_KINDS=['porch','path','sidewalk']; // priority order when polygons overlap
const NAME_RE=/^[\w .'()#-]{1,40}$/u;
const MAX_ZONES=32,MAX_POINTS=64,DEFAULT_MIN_IOU=0.5;
const fail=(status,message)=>Object.assign(new Error(message),{status});

// ---------- geometry ----------
export function pointInPolygon([x,y],pts){
 let inside=false;
 for(let i=0,j=pts.length-1;i<pts.length;j=i++){
  const [xi,yi]=pts[i],[xj,yj]=pts[j];
  if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)inside=!inside;
 }
 return inside;
}
export const polyBBox=pts=>[Math.min(...pts.map(p=>p[0])),Math.min(...pts.map(p=>p[1])),Math.max(...pts.map(p=>p[0])),Math.max(...pts.map(p=>p[1]))];
export function iou(a,b){
 const w=Math.min(a[2],b[2])-Math.max(a[0],b[0]),h=Math.min(a[3],b[3])-Math.max(a[1],b[1]);
 if(w<=0||h<=0)return 0;
 const inter=w*h,union=(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-inter;
 return union>0?inter/union:0;
}
// Greedy NMS over {bbox,score} lists (highest score first); used to merge preview-pass and band-pass sidewalk boxes.
export function mergeNms(boxes,iouMin=0.5){
 const kept=[];
 for(const b of [...boxes].sort((x,y)=>y.score-x.score))if(!kept.some(k=>iou(k.bbox,b.bbox)>=iouMin))kept.push(b);
 return kept;
}
export const footOf=bbox=>[(bbox[0]+bbox[2])/2,bbox[3]];

// ---------- zones ----------
// Validates and normalizes a zones document. Throws {status:400}. Accepts {zones:[{name,kind,points,min_iou?}]}.
export function validateZones(input){
 const list=Array.isArray(input)?input:input?.zones;
 if(!Array.isArray(list))throw fail(400,'Send {"zones":[...]}.');
 if(list.length>MAX_ZONES)throw fail(400,`At most ${MAX_ZONES} zones.`);
 const zones=list.map((z,i)=>{
  if(!z||typeof z!=='object')throw fail(400,`Zone ${i+1} is not an object.`);
  if(!ZONE_KINDS.includes(z.kind))throw fail(400,`Zone ${i+1}: kind must be ${ZONE_KINDS.join(', ')}.`);
  const name=typeof z.name==='string'?z.name.trim():z.kind;
  if(!NAME_RE.test(name))throw fail(400,`Zone ${i+1}: invalid name.`);
  if(!Array.isArray(z.points)||z.points.length<3||z.points.length>MAX_POINTS)throw fail(400,`Zone ${i+1}: 3 to ${MAX_POINTS} points required.`);
  const points=z.points.map(p=>{
   if(!Array.isArray(p)||p.length!==2||!p.every(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1))throw fail(400,`Zone ${i+1}: points are [x,y] numbers between 0 and 1.`);
   return [Math.round(p[0]*10000)/10000,Math.round(p[1]*10000)/10000];
  });
  const out={name,kind:z.kind,points};
  if(z.min_iou!=null){if(typeof z.min_iou!=='number'||!(z.min_iou>0&&z.min_iou<=1))throw fail(400,`Zone ${i+1}: min_iou must be in (0,1].`);out.min_iou=z.min_iou;}
  return out;
 });
 return {version:1,zones};
}
export function readZonesFile(file){try{return validateZones(JSON.parse(readFileSync(file,'utf8')));}catch{return null;}}

// ---------- classification ----------
// raw: [{bbox,score}] from the sidecar. Splits into ignored (static-prop masks), persons and (via the suppressor) suppressed props.
export function locate(bbox,zones){
 const foot=footOf(bbox);
 for(const kind of LOCATION_KINDS){const z=zones.find(zz=>zz.kind===kind&&pointInPolygon(foot,zz.points));if(z)return {zone:kind,zone_name:z.name};}
 return {zone:'other',zone_name:null};
}
export function ignoredBy(bbox,zones){
 for(const z of zones){
  if(z.kind!=='ignore')continue;
  if(iou(bbox,polyBBox(z.points))>=(z.min_iou??DEFAULT_MIN_IOU))return z;
 }
 return null;
}

// A detection whose box has not moved (IoU with the track's anchor >= iouMin) for staticMs is a prop. Tracks expire after goneMs unseen.
export function createStaticSuppressor({staticMs=600000,iouMin=0.8,goneMs=20000}={}){
 let tracks=[];
 return {
  update(boxes,t){
   tracks=tracks.filter(tr=>t-tr.lastSeen<=goneMs); // a track unseen for goneMs is forgotten before matching
   const taken=new Set(),out=[];
   boxes.forEach((box,i)=>{
    let best=-1,bi=0;
    tracks.forEach((tr,k)=>{if(taken.has(k))return;const v=iou(box,tr.anchor);if(v>=iouMin&&v>bi){bi=v;best=k;}});
    let tr;
    if(best>=0){tr=tracks[best];taken.add(best);tr.lastSeen=t;}
    else{tr={anchor:box,since:t,lastSeen:t};tracks.push(tr);taken.add(tracks.length-1);}
    out[i]={static_ms:t-tr.since,suppressed:staticMs>0&&t-tr.since>=staticMs};
   });
   return out;
  },
  reset(){tracks=[];},
  size:()=>tracks.length
 };
}

// Pure: sidecar output -> classified result. Shared by the live detector and scripts/detector-replay.mjs.
// sidewalkScore (SIDEWALK_PRESENCE_SCORE, < minScore): a weak box whose foot is in the sidewalk zone goes to `sidewalk` (never to persons/count/PATH). Static ones are masked by sideSuppressor like props.
export function analyze(raw,{zones=[],suppressor=null,sideSuppressor=null,at=Date.now(),minScore=0,lowScore=0.2,sidewalkScore=null}={}){
 const persons=[],suppressed=[],ignored=[],weak=[],low=[],sideCand=[]; // low: weak boxes in [lowScore,minScore) outside ignore zones; the tracker's second stage may use them to keep a track alive, they never count
 const candidates=[];
 for(const d of raw.persons||[]){
  if(!(d.score>=minScore)){weak.push({bbox:d.bbox,score:d.score});if(d.score>=lowScore&&!ignoredBy(d.bbox,zones))low.push({bbox:d.bbox,score:d.score});
   if(sidewalkScore!=null&&d.score>=sidewalkScore&&!ignoredBy(d.bbox,zones)&&locate(d.bbox,zones).zone==='sidewalk')sideCand.push({bbox:d.bbox,score:d.score,zone:'sidewalk',zone_name:locate(d.bbox,zones).zone_name});
   continue;} // below the presence cutoff: never counts
  const loc=locate(d.bbox,zones),ign=ignoredBy(d.bbox,zones);
  if(ign)ignored.push({bbox:d.bbox,score:d.score,ignore_zone:ign.name});
  else candidates.push({bbox:d.bbox,score:d.score,...loc});
 }
 const st=suppressor?suppressor.update(candidates.map(c=>c.bbox),at):candidates.map(()=>({suppressed:false,static_ms:0}));
 candidates.forEach((c,i)=>{if(st[i].suppressed)suppressed.push({...c,static_ms:st[i].static_ms});else persons.push({...c,static_ms:st[i].static_ms});});
 const sst=sideSuppressor?sideSuppressor.update(sideCand.map(c=>c.bbox),at):sideCand.map(()=>({suppressed:false}));
 const sidewalk=sideCand.filter((c,i)=>!sst[i].suppressed);
 const location=persons.length?LOCATION_KINDS.concat('other').find(k=>persons.some(p=>p.zone===k)):'none';
 return {at,ms:raw.ms??null,width:raw.width??null,height:raw.height??null,count:persons.length,raw_count:(raw.persons||[]).length,location,persons,suppressed,ignored,weak,low,sidewalk};
}
export const countLabel=n=>n>=6?'6_plus':n>=4?'4_5':String(n);
export const LOCATION_TO_JUDGE={porch:'porch',path:'path',sidewalk:'sidewalk',other:'uncertain'};
// PRESENCE_RESOLVER: primary (default: the detector + zones replace the Presence judge, which falls back only when the detector is down) | tiebreak (Judge, the detector settles uncertain/errored reads) | judge (Judge only).
// Back-compat: DETECTOR_MODE=primary means primary; DETECTOR_MODE=shadow (the old default) means tiebreak.
export const PRESENCE_RESOLVERS=['judge','tiebreak','primary'];
export function presenceResolver(env=process.env){
 if(PRESENCE_RESOLVERS.includes(env.PRESENCE_RESOLVER))return env.PRESENCE_RESOLVER;
 return env.DETECTOR_MODE==='shadow'?'tiebreak':'primary';
}
// A Presence-shaped read from a nearest() detector result (null when the detector had no fresh result). 'other' (street/driveway) is present but not PATH.
export function detectorPresence(near){
 if(!near||!Number.isFinite(near.count))return null;
 const n=near.count;
 return {visitor_count:n,count_label:countLabel(n),confidence:null,location:n===0?'none':(LOCATION_TO_JUDGE[near.location]||'uncertain'),location_confidence:null,source:'detector_tiebreak',detector_count:n};
}

// ---------- the live detector ----------
export function createPersonDetector({env=process.env,spawnImpl,now=Date.now,mode:appMode=()=>'ON',sidecar:injected=null,bandSidecar:injectedBand=null,zonesFile=undefined,sidecarTimeoutMs=5000,schedule=(fn,ms)=>{const h=setTimeout(fn,ms);h.unref?.();return h;},cancel=clearTimeout}={}){
 const resolver=presenceResolver(env);
 const modeSetting=env.DETECTOR_MODE==='off'?'off':resolver==='primary'?'primary':'shadow';
 const enabled=env.DETECTOR!=='off'&&modeSetting!=='off'&&(!!injected||!!spawnImpl||!env.NODE_TEST_CONTEXT);
 const presenceScore=env.DETECTOR_PRESENCE_SCORE!=null&&env.DETECTOR_PRESENCE_SCORE!==''&&Number.isFinite(Number(env.DETECTOR_PRESENCE_SCORE))?Number(env.DETECTOR_PRESENCE_SCORE):0.5;
 const sidewalkScore=(()=>{const v=env.SIDEWALK_PRESENCE_SCORE;if(v==='off')return null;const n=v!=null&&v!==''&&Number.isFinite(Number(v))?Number(v):0.35;return n<presenceScore?n:null;})();
 const staleMs=Math.max(500,Number(env.DETECTOR_STALE_MS)||3000);
 const fps=Math.min(15,Math.max(0.2,Number(env.DETECTOR_FPS)||4)),minGap=1000/fps;
 const staticMs=env.DETECTOR_STATIC_MIN!=null&&env.DETECTOR_STATIC_MIN!==''&&Number.isFinite(Number(env.DETECTOR_STATIC_MIN))?Math.max(0,Number(env.DETECTOR_STATIC_MIN))*60000:600000;
 const python=env.DETECTOR_PYTHON||resolve(root,'detector','.venv','bin','python');
 const file=zonesFile!==undefined?zonesFile:(env.DETECTOR_ZONES_FILE?resolve(env.DETECTOR_ZONES_FILE):(env.NODE_TEST_CONTEXT?null:resolve(root,'data','detector-zones.json')));
 const numEnv=(k,d)=>env[k]!=null&&env[k]!==''&&Number.isFinite(Number(env[k]))?Number(env[k]):d;
 const strategy=env.DETECTOR_STRATEGY==='preview'?'preview':'preview+band';
 const bandFps=Math.min(4,numEnv('BAND_FPS',1)),bandGap=bandFps>0?1000/bandFps:Infinity,bandHoldMs=Math.max(1500,2000/Math.max(bandFps,0.1));
 const bandEnabled=enabled&&strategy==='preview+band'&&bandFps>0&&sidewalkScore!=null&&(!!injectedBand||(!injected&&!env.NODE_TEST_CONTEXT&&!process.env.NODE_TEST_CONTEXT));
 const sidecar=injected||(enabled?createSidecarClient({command:python,args:['-I',resolve(root,'detector','detect.py')],env:{...env},spawnImpl,timeoutMs:sidecarTimeoutMs}):null);
 const bandCmd=process.platform==='win32'||env.BAND_NICE==='off'?[python,['-I',resolve(root,'detector','detect.py')]]:['nice',['-n','10',python,'-I',resolve(root,'detector','detect.py')]];
 const bandSidecar=injectedBand||(bandEnabled?createSidecarClient({command:bandCmd[0],args:bandCmd[1],env:{...env,DETECTOR_THREADS:String(numEnv('BAND_THREADS',2))},spawnImpl,timeoutMs:Math.max(sidecarTimeoutMs,10000)}):null);
 const tracker=createPresenceTracker(trackerOptions(env));
 const suppressor=createStaticSuppressor({staticMs,iouMin:Number(env.DETECTOR_STATIC_IOU)||0.8});
 const sideSuppressor=createStaticSuppressor({staticMs,iouMin:Number(env.DETECTOR_STATIC_IOU)||0.8});
 const bandSuppressor=createStaticSuppressor({staticMs,iouMin:Number(env.DETECTOR_STATIC_IOU)||0.8});
 let zones=null,zonesSource='default',zonesMtime=null,zonesCheckedAt=-Infinity,zonesError=null;
 const loadZones=()=>{
  const t=Date.now();if(zones&&t-zonesCheckedAt<5000)return zones;zonesCheckedAt=t;
  let mt=null;try{if(file&&existsSync(file))mt=statSync(file).mtimeMs;}catch{}
  if(zones&&mt===zonesMtime)return zones;
  zonesMtime=mt;zonesError=null;
  let doc=mt!=null?readZonesFile(file):null;
  if(mt!=null&&!doc)zonesError='Zone file is invalid; using defaults.';
  zonesSource=doc?'file':'default';
  zones=(doc||readZonesFile(DEFAULT_ZONES_FILE)||{zones:[]}).zones;return zones;
 };
 const ring=[];let latest=null,busy=false,lastStart=-Infinity,processed=0,dropped=0,failed=0,lastError=null,msSum=0,busyMs=0,startedAt=null;
 const agree={n:0,presence_agree:0,count_agree:0,detector_only:0,judge_only:0,judge_confident_n:0,judge_confident_detector_zero:0,last:null};
 const subs=new Set();
 const emit=r=>{for(const fn of subs){try{fn(r);}catch{}}};
 const state=()=>sidecar?.status().state||'disabled';
 const ready=()=>enabled&&sidecar&&state()==='ready';
 const wants=()=>enabled&&appMode()!=='OFF';

 let inflight=null,pending=null,timer=null;
 const clearTimer=()=>{if(timer!=null){cancel(timer);timer=null;}};
 // Take the most recent frame once idle and the gap (from the previous START) has elapsed; otherwise remember it and wake up exactly when the gap ends. Never queues more than one frame.
 function arm(){
  if(timer!=null||!pending||busy)return;
  const wait=Math.max(0,lastStart+minGap-now());
  timer=schedule(()=>{timer=null;const f=pending;pending=null;if(f)onFrame(f.frame,{fromTimer:true});},wait);
 }
 // force (primary mode on a camera without a live stream): wait for any in-flight detection, then run for exactly this frame.
 async function onFrame(frame,{force=false,fromTimer=false}={}){
  if(!wants()||!frame?.bytes)return null;
  if(!ready()){pending=null;clearTimer();return null;}
  if(force&&busy)await inflight;
  const t=now();
  if(busy||(!force&&t-lastStart<minGap)){
   if(pending)dropped++; // the older pending frame is superseded
   pending={frame};arm();return null;
  }
  if(pending&&!fromTimer){dropped++;}
  pending=null;clearTimer();
  busy=true;lastStart=t;
  let done;inflight=new Promise(r=>{done=r;});
  const began=Date.now();
  try{
   const raw=await sidecar.call('detect',{jpeg:Buffer.from(frame.bytes).toString('base64')});
   const result=analyze(raw,{zones:loadZones(),suppressor,sideSuppressor,at:frame.at||t,minScore:presenceScore,sidewalkScore});
   // Band pass (independent, UNGATED): its recent sidewalk boxes join the preview pass's weak sidewalk boxes (NMS). Never persons: they only reach the tracker's `side` list.
   const bandFresh=bandLast&&result.at-bandLast.at<=bandHoldMs&&result.at-bandLast.at>=-bandHoldMs?bandLast:null;
   if(bandFresh){result.sidewalk=mergeNms([...result.sidewalk,...bandFresh.side]);result.band=bandFresh.all.map(b=>({...b,age_ms:result.at-bandFresh.at}));}
   aTimes.push(began);while(aTimes.length>20)aTimes.shift();
   result.group=tracker.update(result.persons,result.at,loadZones(),result.low,result.sidewalk); // debounced state: what primary decisions use
   latest=result;ring.push(result);while(ring.length>40)ring.shift();
   processed++;msSum+=result.ms??0;
   emit(result);return result;
  }catch(e){failed++;lastError=String(e.message||e).slice(0,160);return null;}
  finally{busyMs+=Date.now()-began;busy=false;done();arm();armBand();}
 }
 // ---------- band pass ----------

 let bandBusy=false,bandPending=null,bandTimer=null,bandStart=-Infinity,bandProcessed=0,bandFailed=0,bandMsSum=0,bandBusyMs=0,bandLast=null,bandError=null,bandSkipped=0;const bandTimes=[],aTimes=[];
 const bandReady=()=>bandEnabled&&bandSidecar&&bandSidecar.status().state==='ready';
 const bandOn=()=>bandEnabled&&wants();
 // The newest native frame waits; the pass starts once the previous one ended, the gap (from the previous START) elapsed, AND the preview pass is idle (the preview pass has priority). One at a time, never queued.
 function armBand(){
  if(bandTimer!=null||!bandPending||bandBusy||!bandOn())return;
  const wait=busy?25:Math.max(0,bandStart+bandGap-now());
  bandTimer=schedule(()=>{bandTimer=null;if(busy||bandBusy){armBand();return;}const f=bandPending;bandPending=null;if(f)runBand(f);},wait);
 }
 function onNativeFrame(frame){
  if(!bandOn()||!frame?.bytes)return;
  if(bandPending)bandSkipped++; // superseded by a newer one
  bandPending=frame;armBand();
 }
 async function runBand(frame){
  if(!bandReady())return;
  bandBusy=true;bandStart=now();const began=Date.now();
  try{
   const raw=await bandSidecar.call('detect_band',{jpeg:Buffer.from(frame.bytes).toString('base64')});
   const zs=loadZones(),at=frame.at||now(),all=[],cand=[];
   for(const d of raw.persons||[]){
    const ign=ignoredBy(d.bbox,zs),loc=locate(d.bbox,zs);
    if(ign)continue;
    all.push({bbox:d.bbox,score:d.score,zone:loc.zone,src:'band'});
    if(d.score>=sidewalkScore&&loc.zone==='sidewalk')cand.push({bbox:d.bbox,score:d.score,zone:'sidewalk',zone_name:loc.zone_name,src:'band'}); // foot on path/porch/street: ignored for presence
   }
   const st=bandSuppressor.update(cand.map(c=>c.bbox),at);
   const parked=new Set(cand.filter((c,i)=>st[i].suppressed).map(c=>c.bbox));for(const a of all)if(parked.has(a.bbox))a.suppressed=true; // overlays hide static props (a parked car) by default
   bandLast={at,all,side:cand.filter((c,i)=>!st[i].suppressed),ms:raw.ms??null};
   bandProcessed++;bandMsSum+=raw.ms??0;bandTimes.push(Date.now());while(bandTimes.length>10)bandTimes.shift();bandError=null;
  }catch(e){bandFailed++;bandError=String(e.message||e).slice(0,160);}
  finally{bandBusyMs+=Date.now()-began;bandBusy=false;armBand();}
 }
 const rate=ts=>ts.length>1?Math.round((ts.length-1)/((ts.at(-1)-ts[0])/1000)*100)/100:null;
 // Compare with the Presence judge's read of a (slightly different) frame. Shadow bookkeeping only.
 function noteJudge(image,decision){
  try{
   if(!latest||!Number.isFinite(decision?.visitor_count))return;
   let best=null,bd=Infinity;for(const r of ring){const d=Math.abs(r.at-image.at);if(d<bd){bd=d;best=r;}}
   if(!best||bd>2500)return;
   if(decision.presence_source==='detector_tiebreak')return; // the detector settled this read: comparing it with itself says nothing
   const j=decision.visitor_count,d=best.count;
   // Shadow only: a confident Judge positive that the detector does not see. Never overrides; the replay decides later.
   if(decision.presence_source==='judge'&&j>=1){agree.judge_confident_n++;if(d===0)agree.judge_confident_detector_zero++;}
   agree.n++;if((j>=1)===(d>=1))agree.presence_agree++;else if(d>=1)agree.detector_only++;else agree.judge_only++;
   if(j===d)agree.count_agree++;
   agree.last={at:image.at,judge:j,detector:d,gap_ms:bd,decision_source:decision.detector_primary?'detector':'judge'};
  }catch{}
 }
 // Detector count near a frame, stored with each read so shadow disagreement can be computed later.
 function nearest(image){
  let best=null,bd=Infinity;for(const r of ring){const d=Math.abs(r.at-image.at);if(d<bd){bd=d;best=r;}}
  return best&&bd<=2500?{count:best.count,gap_ms:bd,location:best.location}:null;
 }
 // Fallback bookkeeping: active while primary mode cannot use the detector and the Judge presence path runs instead. Logged once per transition.
 const fb={active:false,reason:null,since:null,fallback_reads:0,transitions:0};
 function setFallback(reason){
  if(reason){
   fb.fallback_reads++;fb.reason=reason;
   if(!fb.active){fb.active=true;fb.since=now();fb.transitions++;if(enabled)console.warn(`[detector] unusable (${reason}); falling back to the Judge for presence`);}
  }else if(fb.active){fb.active=false;fb.reason=null;fb.since=null;fb.transitions++;if(enabled)console.warn('[detector] recovered; detector is the presence source again');}
 }
 // primary mode: a synthetic Presence read built from the freshest detector result near this frame, or null (=> the real judge runs, fallback).
 async function primaryRead(image){
  if(modeSetting!=='primary')return null;
  for(let i=0;i<60&&enabled&&state()==='starting';i++)await new Promise(r=>setTimeout(r,50)); // sidecar booting: wait (capped 3 s) instead of paying for a Judge read
  if(!ready()){setFallback(!enabled?'disabled':'not_ready:'+state());return null;}
  if(busy)await inflight;
  const fresh=()=>latest&&Math.abs((image.at??0)-latest.at)<=staleMs;
  if(!fresh())await onFrame(image,{force:true}); // no live stream feeding us (or it stalled): detect this very frame
  if(!fresh()){setFallback('stale');return null;}
  setFallback(null);
  const g=latest.group,n=g?g.count:latest.count,label=countLabel(n),loc=g?(g.location==='pending'?'other':g.location):latest.location; // 'pending' = seen but not yet debounced into a state: counted, location unknown
  return {count:n,location:loc,motion:g?.motion||null,crowd:g?{...g.crowd,...tracker.takeCrowd()}:null,leaveGroup:g?Boolean(g.leaveGroup):undefined,ms:latest.ms,near:{count:n,gap_ms:Math.abs((image.at??0)-latest.at),location:loc},presence:{visitor_count:n,count_label:label,confidence:1},
   result:{answers:[{type:'choice',name:'real_people_count',choice:label,confidence:1}],_query_id:'detector',usage:null,detector:true},
   request:{model:'person-detector',input:[{role:'user',content:[{type:'input_text',text:'local person detector (no model prompt)'}]}],questions:[]}};
 }
 function applyLocation(decision,read){
  if(!read||!(decision?.visitor_count>0))return decision;
  decision.visitor_location=LOCATION_TO_JUDGE[read.location]||'uncertain';decision.detector_primary=true;return decision;
 }
 function status(){
  const age=latest?now()-latest.at:null;
  const downNow=!ready()?(!enabled?'disabled':'not_ready:'+state()):(age==null||age>staleMs)?'stale':null;
  const presence_source=modeSetting!=='primary'?'judge':!wants()?'idle':downNow?'judge_fallback':'detector';
  return {enabled,mode:modeSetting,resolver,primary:modeSetting==='primary',presence_source,fallback:{...fb,now:modeSetting==='primary'&&wants()?downNow:null},presence_score:presenceScore,sidewalk_score:sidewalkScore,strategy,a_fps:rate(aTimes.map(x=>x)),band:{enabled:bandEnabled,state:bandSidecar?bandSidecar.status().state:'disabled',fps_target:bandEnabled?bandFps:0,fps:rate(bandTimes),processed:bandProcessed,failed:bandFailed,skipped:bandSkipped,avg_ms:bandProcessed?Math.round(bandMsSum/bandProcessed*10)/10:null,duty:startedAt?Math.round(bandBusyMs/Math.max(1,Date.now()-startedAt)*1000)/1000:null,error:bandError||bandSidecar?.status().error||null,latest_age_ms:bandLast?now()-bandLast.at:null,latest_boxes:bandLast?bandLast.all.length:null},stale_ms:staleMs,state:state(),error:sidecar?.status().error||lastError,running:wants()&&ready(),
   fps_target:fps,static_minutes:staticMs/60000,processed,dropped,failed,avg_ms:processed?Math.round(msSum/processed*10)/10:null,
   duty:startedAt?Math.round(busyMs/Math.max(1,Date.now()-startedAt)*1000)/1000:null,latest,latest_age_ms:age,
   agreement:{...agree,presence_rate:agree.n?Math.round(agree.presence_agree/agree.n*1000)/1000:null},
   zones:{source:zonesSource,error:zonesError,count:(zones||loadZones()).length}};
 }
 function getZones(){loadZones();return {source:zonesSource,error:zonesError,...{version:1,zones}};}
 function saveZones(body){
  const doc=validateZones(body);
  if(!file)throw fail(503,'Zone saving is not configured.');
  mkdirSync(dirname(file),{recursive:true,mode:0o700});
  const tmp=file+'.'+process.pid+'.tmp';writeFileSync(tmp,JSON.stringify(doc,null,1)+'\n',{mode:0o600});chmodSync(tmp,0o600);renameSync(tmp,file);
  zones=null;zonesCheckedAt=-Infinity;suppressor.reset();sideSuppressor.reset();bandSuppressor.reset();bandLast=null;tracker.reset();loadZones();
  return getZones();
 }
 return {enabled,mode:modeSetting,resolver,wants,onNativeFrame,bandWanted:()=>bandOn(),bandFps:()=>bandEnabled?bandFps:0,strategy,setLive:on=>tracker.setLive(on),fallbackReason:()=>fb.active?fb.reason:null,onFrame,noteJudge,nearest,primaryRead,applyLocation,status,getZones,saveZones,
  subscribe:fn=>{subs.add(fn);return ()=>subs.delete(fn);},clientCount:()=>subs.size,
  start(){if(sidecar&&enabled){startedAt=Date.now();sidecar.start();bandSidecar?.start?.();}},stop(){sidecar?.stop?.();bandSidecar?.stop?.();clearTimer();if(bandTimer!=null){cancel(bandTimer);bandTimer=null;}subs.clear();},latest:()=>latest,zonesFile:()=>file};
}

// ---------- HTTP routes (host/origin checks already ran in server.mjs) ----------
// Returns true when handled.
export async function handleDetectorRoute(detector,{req,res,path,send}){
 if(req.method==='GET'&&path==='/api/detector/status'){send(200,detector.status());return true;}
 if(req.method==='GET'&&path==='/api/detector/zones'){send(200,detector.getZones());return true;}
 if(req.method==='POST'&&path==='/api/detector/zones'){
  let data='';for await(const chunk of req){data+=chunk;if(data.length>65536)throw fail(400,'Request too large.');}
  let body;try{body=JSON.parse(data||'{}');}catch{throw fail(400,'Send JSON.');}
  send(200,detector.saveZones(body));return true;
 }
 if(req.method==='GET'&&path==='/api/detector/events'){
  if(detector.clientCount()>=8)throw fail(503,'Too many detector listeners.');
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',Connection:'keep-alive'});
  const write=r=>res.write('data: '+JSON.stringify(r)+'\n\n');
  const first=detector.latest();if(first)write(first);else res.write(': ready\n\n');
  const off=detector.subscribe(write),ping=setInterval(()=>{try{res.write(': ping\n\n');}catch{}},15000);ping.unref?.();
  req.on('close',()=>{off();clearInterval(ping);});
  return true;
 }
 return false;
}
