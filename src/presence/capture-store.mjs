// Replayable capture store: contiguous visits (a clip opens at the first presence >= 1 read, closes after 5 s of confident zero) with the live Judge reads for each saved frame.
// PRIVATE: real camera images that may include children. Lives in a gitignored directory (dirs 0700, files 0600). NEVER commit.
//
// <dir>/<YYYY-MM-DD>/<clip_id>/
//   clip.json        clip metadata
//   frames/000123_<epoch_ms>.jpg   exactly as the camera stream produced them (pre-model; native resolution when available). The index
//                    is a unique id in write order; the epoch_ms in the name is the authoritative capture time.
//   judge.jsonl      one line per live Judge read of a SAVED frame (frames are saved only while a Presence read is >= 1 or uncertain, at most one per CAPTURE_INTERVAL_MS)
//   events.jsonl     Judge events (NEW_PARTY ...)
//   labels.jsonl     ground truth, appended later, latest wins
//   replays/<run_id>/{run.json,results.jsonl}   written by scripts/judge-replay.mjs
import {mkdir,writeFile,appendFile,readFile,readdir,rm,stat,chmod,statfs} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {resolve,join} from 'node:path';
import * as judgeLog from './judge-log.mjs';
import {latestAiLabels} from './ai-labels.mjs';
import {jpegSize} from './camera-stream.mjs';

export const CLIP_ID_RE=/^[A-Za-z0-9_-]{1,64}$/;
const DATE_RE=/^\d{4}-\d{2}-\d{2}$/;
export const validClipId=id=>typeof id==='string'&&CLIP_ID_RE.test(id);
export const COUNT_VALUES=['0','1','2','3','4','5','6','7','8','9','10','11_plus'];
export const BUCKET_VALUES=['0','1','2','3','4','5','6_plus'];
export const LABEL_FIELDS=['real_people_count','closest_person_location','person_1_location','person_2_location','person_3_location','arriving_count','present_count','leaving_count'];
const pad=(n,w=6)=>String(n).padStart(w,'0');
const bad=(message,status=400)=>Object.assign(new Error(message),{status});
const readLines=async file=>{let text='';try{text=await readFile(file,'utf8');}catch{return [];}const out=[];for(const l of text.split('\n')){if(!l.trim())continue;try{out.push(JSON.parse(l));}catch{}}return out;};
const readJson=async file=>{try{return JSON.parse(await readFile(file,'utf8'));}catch{return null;}};

export function sanitizeClipLabel(body,{now=Date.now,frameCount=Infinity}={}){
  const pick=(v,allowed)=>{if(v==null||v==='')return null;if(!allowed.includes(String(v)))throw bad('Invalid value.');return String(v);};
  const idx=v=>{if(v==null||v==='')return null;const n=Number(v);if(!Number.isInteger(n)||n<0||n>frameCount+1e6)throw bad('Invalid frame index.');return n;};
  let costumes=null;
  if(body?.costumes!=null){if(!Array.isArray(body.costumes))throw bad('Invalid costumes.');costumes=body.costumes.slice(0,3).map(c=>String(c).slice(0,40).replace(/[^a-z0-9_ -]/gi,'')).filter(Boolean);}
  const frame_index=idx(body?.frame_index),from_index=idx(body?.from_index),to_index=idx(body?.to_index);
  if(frame_index!=null&&(from_index!=null||to_index!=null))throw bad('Use frame_index or a from/to range, not both.');
  if((from_index==null)!==(to_index==null)||(from_index!=null&&from_index>to_index))throw bad('Invalid frame range.');
  return {labeled_at:new Date(now()).toISOString(),labeler:String(body?.labeler||'').slice(0,40)||null,
    scope:frame_index!=null?'frame':from_index!=null?'range':'clip',frame_index,from_index,to_index,
    people_present:pick(body?.people_present,['yes','no','unsure']),real_people_count:pick(body?.real_people_count,COUNT_VALUES),arriving_count:pick(body?.arriving_count,BUCKET_VALUES),present_count:pick(body?.present_count,BUCKET_VALUES),leaving_count:pick(body?.leaving_count,BUCKET_VALUES),
    costumes,notes:body?.notes==null?null:String(body.notes).slice(0,500),...(body?.cleared===true?{cleared:true}:{})};
}
// Latest label wins per field; clip-wide labels apply everywhere, range/frame labels only on their frames. Returns (frameIndex)=>{field:value}.
export function labelResolver(lines){
  return idx=>{
    const out={};
    for(const l of lines){
      const applies=l.scope==='clip'||(l.scope==='frame'&&l.frame_index===idx)||(l.scope==='range'&&idx>=l.from_index&&idx<=l.to_index);
      if(!applies)continue;
      if(l.cleared){delete out.people_present;delete out.real_people_count;continue;}
      for(const f of [...LABEL_FIELDS,'people_present','costumes'])if(l[f]!=null)out[f]=l[f];
    }
    return out;
  };
}

export function createCaptureStore({dir,intervalMs=2000,closeAfterMs=5000,maxClipMs=300000,maxBytes=5*1024**3,
  maxPending=300,minFreeBytes=3*1024**3,freeCheckMs=10000,freeBytes=null,now=Date.now,enabled=()=>true,meta=async()=>({}),mode=()=>null,commit=null,tickMs=1000}={}){
  const root=dir?resolve(dir):null,on=!!root,interval=Math.max(0,Number(intervalMs)||0);
  let clip=null,curRead=null;
  let lowDisk=false,lastFreeCheck=-Infinity,freeNow=null;
  const readFree=freeBytes||(async()=>{let p=root;for(let i=0;i<6;i++){try{const f=await statfs(p);return Number(f.bavail)*Number(f.bsize);}catch{p=resolve(p,'..');}}return null;});
  let nativeSeenWall=-Infinity,recent=[],nativeSize=null;const nativeActive=()=>now()-nativeSeenWall<3000;
  let chain=Promise.resolve(),pending=0,dropped=0,error=null,bytes=0,clipsTotal=0,readyP=null,writesSincePrune=0;
  const queue=fn=>{chain=chain.then(fn).catch(e=>{error='Capture write failed: '+(e.code||e.message||'error');});return chain;};
  const ensureDir=async d=>{await mkdir(d,{recursive:true,mode:0o700});await chmod(d,0o700).catch(()=>{});};
  const sizeOf=async p=>{let total=0;try{for(const e of await readdir(p,{withFileTypes:true})){const q=join(p,e.name);total+=e.isDirectory()?await sizeOf(q):(await stat(q)).size;}}catch{}return total;};
  const clipPaths=async()=>{ // oldest first
    const out=[];let days=[];try{days=(await readdir(root)).filter(d=>DATE_RE.test(d)).sort();}catch{return out;}
    for(const d of days){try{for(const c of (await readdir(join(root,d))).filter(validClipId).sort())out.push({date:d,id:c,path:join(root,d,c)});}catch{}}
    return out;
  };
  const ready=()=>readyP??=(async()=>{if(!on)return;await ensureDir(root);bytes=await sizeOf(root);clipsTotal=(await clipPaths()).length;})();
  async function prune(){
    if(!on||bytes<=maxBytes)return 0;
    let removed=0;const all=await clipPaths();
    for(const c of all){
      if(bytes<=maxBytes*0.9)break;
      if(clip&&clip.id===c.id)continue;
      const size=await sizeOf(c.path);await rm(c.path,{recursive:true,force:true});bytes=Math.max(0,bytes-size);removed++;clipsTotal=Math.max(0,clipsTotal-1);
      try{if(!(await readdir(join(root,c.date))).length)await rm(join(root,c.date),{recursive:true});}catch{}
    }
    return removed;
  }
  const write=(path,data,{append=false}={})=>queue(async()=>{await ready();if(typeof data==='function')data=data();await (append?appendFile:writeFile)(path,data,{mode:0o600});bytes+=data.length;
    if(++writesSincePrune>=100||bytes>maxBytes){writesSincePrune=0;await prune();}});

  const clipJson=(c,extra={})=>({clip_id:c.id,started_at:new Date(c.started_at).toISOString(),ended_at:c.ended_at?new Date(c.ended_at).toISOString():null,sampling:'presence_only',capture_interval_ms:interval,frame_count:c.count,
    camera:c.camera,resolution:c.res||null,deployment_commit:commit,mode:c.mode,trigger:c.trigger,close_reason:c.close_reason||null,...extra});
  const writeClipJson=c=>write(join(c.path,'clip.json'),()=>JSON.stringify(clipJson(c),null,1)+'\n');

  function addFrame(f){
    if(clip.frames.has(f.at))return clip.frames.get(f.at);
    if(pending>=maxPending){dropped++;error='Capture falling behind: dropping frames.';return null;}
    const idx=clip.next++;clip.frames.set(f.at,idx);clip.count++;pending++;
    if(!clip.res){const sz=jpegSize(f.bytes);if(sz)clip.res={width:sz.width,height:sz.height,native:f.width!=null};}
    const bytesCopy=f.bytes;
    write(join(clip.path,'frames',pad(idx)+'_'+f.at+'.jpg'),bytesCopy).finally(()=>{pending--;});
    if(clip.count%20===0)writeClipJson(clip);
    return idx;
  }
  function open(trigger,{zeroSince=null}={}){
    const t=now(),iso=new Date(t).toISOString(),date=iso.slice(0,10);
    const id=iso.slice(0,19).replace(/[-:T]/g,'').replace(/^(\d{8})(\d{6})$/,'$1-$2')+'-'+randomBytes(2).toString('hex');
    const c={id,date,path:join(root,date,id),started_at:t,ended_at:null,trigger,mode:mode(),frames:new Map(),next:0,count:0,zeroSince,reads:0,events:0,camera:{rotate:null,ptz:null},close_reason:null};
    clip=c;clipsTotal++;
    queue(async()=>{await ready();await ensureDir(join(root,date));await ensureDir(c.path);await ensureDir(join(c.path,'frames'));
      try{c.camera=await meta();}catch{}await writeFile(join(c.path,'clip.json'),JSON.stringify(clipJson(c),null,1)+'\n',{mode:0o600});});
    return c;
  }
  function close(reason){
    if(!clip)return;
    const c=clip;clip=null;c.ended_at=now();c.close_reason=reason;
    writeClipJson(c);
  }
  // Free-space guard: stop recording (and say so) when the capture volume is nearly full; resume with 20% headroom.
  function checkFree(){
    if(!on||minFreeBytes<=0||now()-lastFreeCheck<freeCheckMs)return;
    lastFreeCheck=now();
    queue(async()=>{
      const free=await readFree();if(free==null)return;freeNow=free;
      if(!lowDisk&&free<minFreeBytes){lowDisk=true;error='Capture stopped: free disk space is below '+(minFreeBytes/1024**3).toFixed(1)+' GB.';if(clip)close('low_disk');}
      else if(lowDisk&&free>=minFreeBytes*1.2){lowDisk=false;error=null;}
    });
  }
  function tick(){
    if(!on)return;
    checkFree();
    if(clip&&!enabled()){close('mode');return;}
    const t=now();
    if(clip){
      if(clip.zeroSince!=null&&t-clip.zeroSince>=closeAfterMs)close('absent');
      else if(t-clip.started_at>=maxClipMs){const z=clip.zeroSince;close('max_length');open('rollover',{zeroSince:z});}
    }
  }
  // Scaled preview-stream frames carry no capture decision any more (frames are saved only when a Presence read saw someone);
  // this just keeps clip timers running.
  function onFrame(f){
    if(!on||!f?.bytes||!Number.isFinite(f.at))return;
    tick();
  }
  // Native-resolution frames {bytes,at,width,height}. Recent ones are kept briefly so a Judge read (made on the scaled frame)
  // can be tied to its full-resolution twin by capture time.
  function onNativeFrame(f){
    if(!on||!f?.bytes||!Number.isFinite(f.at))return;
    nativeSeenWall=now();if(f.width)nativeSize={width:f.width,height:f.height};
    if(enabled()&&!lowDisk){recent.push(f);const cut=f.at-8000;while(recent.length>40||(recent.length&&recent[0].at<cut))recent.shift();}
    tick();
  }
  const twin=img=>{if(!nativeActive()||!img?.at)return img;let best=null,d=201;for(const f of recent){const x=Math.abs(f.at-img.at);if(x<d){d=x;best=f;}}return best||img;};
  // r: {images:[{bytes,at}] (current first, then e.g. previous for motion), presence:'present'|'uncertain'|'zero'|null, read_id, judge, request?, prompt_sha256, model, answers, parsed, inference_ms, usage, error}
  function noteRead(r){
    if(!on||!enabled()||lowDisk)return;
    const p=r.presence,img=r.images?.[0],t=now();
    let saveNow=false;
    if(p==='present'||p==='uncertain'){
      if(!clip)open('presence');
      clip.zeroSince=null;
      // Presence-only sampling: save at most one frame per interval, and only while people (or maybe people) are in view.
      saveNow=Boolean(img?.bytes)&&(clip.lastSavedAt==null||(img.at-clip.lastSavedAt)>=interval);
      curRead={read_id:r.read_id,saved:saveNow};
    }else if(p==='zero'){if(clip)clip.zeroSince??=t;curRead={read_id:r.read_id,saved:false};}
    else if(!(curRead&&curRead.read_id===r.read_id))return; // motion/costume lines follow the decision made for their read's presence line
    if(!clip)return;
    if(p==='present'||p==='uncertain'){if(saveNow){const f=twin(img);clip.lastSavedAt=img.at;const idx=addFrame(f);curRead.idx=idx;curRead.at=f.at;}}
    if(!curRead.saved||curRead.idx==null)return; // no frame stored for this read: nothing to replay, so no line
    // The first image is the saved frame; any other image (motion's previous frame) is only linked if it happens to be a saved frame too.
    const idxs=(r.images||[]).map((im,i)=>i===0?curRead.idx:(im?.at!=null?(clip.frames.get(twin(im).at)??null):null));
    clip.reads++;
    const line={at:t,read_id:r.read_id??null,...(r.detector?{detector:r.detector}:{}),...(r.presence_source?{presence_source:r.presence_source,detector_count:r.detector_count??null}:{}),judge:r.judge||'combined',frame_index:idxs[0]??null,frame_indexes:idxs,frame_ats:(r.images||[]).map(i=>i.at),
      prompt_sha256:r.prompt_sha256??null,model:r.model??null,answers:r.answers||[],parsed:r.parsed??null,inference_ms:r.inference_ms??null,usage:r.usage??null,error:r.error??null};
    write(join(clip.path,'judge.jsonl'),JSON.stringify(line)+'\n',{append:true});
  }
  function noteEvent(event){
    if(!on||!enabled()||!clip)return;
    clip.events++;
    const idx=clip.frames.get(event.frame_at)??Math.max(0,clip.next-1);
    write(join(clip.path,'events.jsonl'),JSON.stringify({at:event.at??now(),type:event.type,phrase:event.phrase??null,frame_index:idx,id:event.id??null})+'\n',{append:true});
  }

  async function findClip(id){
    if(!on||!validClipId(id))return null;
    let days=[];try{days=(await readdir(root)).filter(d=>DATE_RE.test(d));}catch{return null;}
    for(const d of days){const p=join(root,d,id);try{if((await stat(p)).isDirectory())return {date:d,id,path:p};}catch{}}
    return null;
  }
  const frameFiles=async p=>{let names=[];try{names=await readdir(join(p,'frames'));}catch{}
    return names.map(n=>n.match(/^(\d{6})_(\d+)\.jpg$/)).filter(Boolean).map(m=>({index:Number(m[1]),at:Number(m[2]),name:m[0]})).sort((a,b)=>a.index-b.index);};
  async function summary(c){
    const json=await readJson(join(c.path,'clip.json'))||{clip_id:c.id};
    const frames=json.ended_at?json.frame_count:(await frameFiles(c.path)).length;
    const reads=(await readLines(join(c.path,'judge.jsonl'))).length,events=(await readLines(join(c.path,'events.jsonl'))).length,labels=(await readLines(join(c.path,'labels.jsonl'))).length;
    let replays=0;try{replays=(await readdir(join(c.path,'replays'))).length;}catch{}
    const live=clip&&clip.id===c.id;
    return {...json,date:c.date,frame_count:live?clip.count:frames,recording:!!live,duration_ms:json.started_at?(Date.parse(json.ended_at||new Date(now()).toISOString())-Date.parse(json.started_at)):null,judge_reads:reads,events,labels,labeled:labels>0,replays};
  }
  const status=()=>({enabled:on,active:on&&enabled(),recording:!!clip,mode:mode(),clip_id:clip?.id||null,clip_started_at:clip?new Date(clip.started_at).toISOString():null,clip_trigger:clip?.trigger||null,
    frames:clip?.count||0,sampling:'presence_only',interval_ms:interval,native:{active:on&&nativeActive(),width:nativeSize?.width??null,height:nativeSize?.height??null},pending_writes:pending,dropped_frames:dropped,low_disk:lowDisk,free_bytes:freeNow,min_free_bytes:minFreeBytes,clips:clipsTotal,disk_bytes:bytes,max_bytes:maxBytes,error});
  const timer=on?setInterval(tick,tickMs):null;timer?.unref?.();
  return {
    enabled:on,status,onFrame,onNativeFrame,noteRead,noteEvent,tick,prune:()=>chain.then(prune),flush:()=>chain,
    wants:()=>on&&enabled(),
    close(reason='shutdown'){clearInterval(timer);close(reason);return chain;},
    async list({limit=100,offset=0}={}){
      if(!on)return {total:0,clips:[]};await chain;const all=(await clipPaths()).reverse();
      const out=[];for(const c of all.slice(offset,offset+limit))out.push(await summary(c));
      return {total:all.length,clips:out};
    },
    async get(id){
      const c=await findClip(id);if(!c)return null;await chain;
      const frames=await frameFiles(c.path),replays=[];
      try{for(const r of (await readdir(join(c.path,'replays'))).filter(validClipId).sort()){const run=await readJson(join(c.path,'replays',r,'run.json'));if(run)replays.push({run_id:r,...run});}}catch{}
      return {...await summary(c),frames:frames.map(({index,at})=>({index,at})),judge:await readLines(join(c.path,'judge.jsonl')),events_list:await readLines(join(c.path,'events.jsonl')),labels_list:await readLines(join(c.path,'labels.jsonl')),replay_runs:replays};
    },
    async frame(id,index){
      const c=await findClip(id);if(!c||!/^\d{1,9}$/.test(String(index)))return null;await chain;
      const f=(await frameFiles(c.path)).find(x=>x.index===Number(index));if(!f)return null;
      try{return await readFile(join(c.path,'frames',f.name));}catch{return null;}
    },
    async addLabel(id,body){
      const c=await findClip(id);if(!c)throw bad('Clip not found.',404);
      await chain;const label=sanitizeClipLabel(body,{now,frameCount:(await frameFiles(c.path)).length});
      await queue(async()=>{await appendFile(join(c.path,'labels.jsonl'),JSON.stringify(label)+'\n',{mode:0o600});});
      return label;
    },
    async reviewClips(){
      if(!on)return [];await chain;const out=[];
      for(const c of (await clipPaths()).reverse()){const labels=await readLines(join(c.path,'labels.jsonl'));out.push({id:c.id,date:c.date,judge:await readLines(join(c.path,'judge.jsonl')),resolve:labelResolver(labels),ai:latestAiLabels(await readLines(join(c.path,'ai_labels.jsonl')))});}
      return out;
    },
    // AI labels live beside human labels but in their own file (ai_labels.jsonl, 0600).
    async addAiLabels(id,records){
      const c=await findClip(id);if(!c)throw bad('Clip not found.',404);
      if(!records.length)return 0;
      const file=join(c.path,'ai_labels.jsonl');
      await queue(async()=>{await appendFile(file,records.map(r=>JSON.stringify(r)).join('\n')+'\n',{mode:0o600});await chmod(file,0o600).catch(()=>{});});
      return records.length;
    },
    findClip,frameFiles,
    cutoffs:judgeLog.CUTOFFS||{},
  };
}
// Adapter for server.mjs decideImage: records each judge request/result of one read as its own judge.jsonl line.
// Presence goes first (it decides whether a clip opens); motion records both frames it saw (now + previous).
export function noteJudgeReads(store,{detector=null,presenceSource=null,detectorCount=null,read_id,image,prevImage,presence,presenceRes,presenceError,motionRes,motion,motionError,costumeRes,costume,costumeError,hash,describe}){
  if(!store?.enabled)return;
  try{
    const line=(name,res,parsed,err,images)=>({read_id,judge:name,images,prompt_sha256:res.request?hash(res.request):null,model:res.request?.model||null,
      answers:describe(res.result),parsed:parsed??null,inference_ms:res.inference_ms,usage:res.result?.usage||null,error:err?{code:err.code||'ERROR',message:String(err.message||'').slice(0,200)}:null});
    const n=presence?.visitor_count;
    const p=presenceSource==='detector_tiebreak'?(n>=1?'present':'zero'):presenceError?(presenceError.code==='UNCERTAIN_PEOPLE_COUNT'?'uncertain':null):n>=1?'present':n===0?'zero':null;
    store.noteRead({...line('presence',presenceRes,presence,presenceError,[image]),detector,presence_source:presenceSource,detector_count:detectorCount,presence:p});
    if(motionRes)store.noteRead({...line('motion',motionRes,motion,motionError,prevImage?[image,prevImage]:[image]),presence:null});
    if(costumeRes)store.noteRead({...line('costume',costumeRes,costume,costumeError,[image]),presence:null});
  }catch{}
}
// Native-resolution frames are large (about 0.5 to 1 MB each at 2560x1440, q:v 3), so the default cap is 6 GB with native capture on (the device has little free disk), 5 GB without.
export const captureConfig=(env,root)=>{const native=env.CAPTURE_NATIVE!=='false';return {dir:env.CAPTURE_DIR?resolve(env.CAPTURE_DIR):(env.NODE_TEST_CONTEXT?null:resolve(root,'data','captures')),
  intervalMs:env.CAPTURE_INTERVAL_MS===undefined||env.CAPTURE_INTERVAL_MS===''?2000:Math.max(0,Number(env.CAPTURE_INTERVAL_MS)||0),maxBytes:Math.max(0.001,Number(env.CAPTURE_MAX_GB)||(native?6:5))*1024**3,minFreeBytes:Math.max(0,env.CAPTURE_MIN_FREE_GB===undefined||env.CAPTURE_MIN_FREE_GB===''?3:Number(env.CAPTURE_MIN_FREE_GB)||0)*1024**3,native,nativeQuality:Math.max(1,Math.min(10,Number(env.CAPTURE_NATIVE_QUALITY)||3))};};
