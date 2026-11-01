// Visit clips: one MP4 + visit.json sidecar per "visit" (anyone on the sidewalk, path or porch, followed until nobody has been seen for VISIT_POST_MS).
// Purpose: measure how well the debounced group state (EMPTY/SIDEWALK/PATH, presence-tracker.mjs) matches reality. Frames are 960 px preview JPEGs (~6 fps).
// PRIVATE (children on camera): lives in gitignored data/visits/<YYYYMMDD-HHMMSS>-<id>/ (dirs 0700, files 0600). NEVER commit.
//
// Rules: a frame is written only inside a real visit: VISIT_PREROLL_MS before the first person, until VISIT_POST_MS after the last one (the pre-roll and the post-roll are
// the only person-free frames). Frames spool to disk during the visit (never unbounded RAM); the MP4 is encoded after the visit, one at a time, under nice 10, and the spool is deleted
// after a successful encode. After the video ends the sidecar timeline keeps following the live tracker for up to VISIT_TAIL_MS so the exit to EMPTY is measurable (no frames written then).
//
// Env: VISITS=on|off (default on; recording is also off in app mode OFF) VISIT_PREROLL_MS=3000 VISIT_POST_MS=3000 VISIT_MAX_MS=180000 VISIT_TAIL_MS=6000 VISIT_MAX_CLIPS=100 VISIT_MAX_GB=2 VISIT_MIN_FREE_GB=3
//      VISIT_FPS=6 VISIT_CRF=28 VISIT_DIR=<dir> (default data/visits)
import {mkdirSync,writeFileSync,readFileSync,readdirSync,statSync,rmSync,existsSync,renameSync,chmodSync,statfsSync,createReadStream} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {summaryOf} from '../../public/visit-time.js';
import {replayMeta} from './visit-replay.mjs';
import {toWav,parseWav,pcmLevels,MIC_RATE,ASSISTANT_RATE} from './visit-audio.mjs';
import {handleRunRoute} from '../replay/replay-routes.mjs';
import {sendFileRange} from '../server/http-range.mjs';

import {ROOT} from '../lib/paths.mjs';
const root=ROOT;
export const VISIT_ID_RE=/^\d{8}-\d{6}-[a-f0-9]{6}$/;
export const validVisitId=id=>typeof id==='string'&&VISIT_ID_RE.test(id);
export const STATE_ORDER=['EMPTY','SIDEWALK','PATH'];
const fail=(status,message)=>Object.assign(new Error(message),{status});
const num=(v,d,min=0)=>v!==undefined&&v!==null&&v!==''&&Number.isFinite(Number(v))?Math.max(min,Number(v)):d;
const round=(x,n=4)=>Math.round(x*10**n)/10**n;
const pad=(n,w=2)=>String(n).padStart(w,'0');
export const visitStamp=ms=>{const d=new Date(ms);return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;};
export const maxState=timeline=>timeline.reduce((m,e)=>STATE_ORDER.indexOf(e.state)>STATE_ORDER.indexOf(m)?e.state:m,'EMPTY');
const jsonFile=(file,value)=>{const tmp=file+'.'+process.pid+'.tmp';writeFileSync(tmp,JSON.stringify(value),{mode:0o600});chmodSync(tmp,0o600);renameSync(tmp,file);};
const readJson=file=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch{return null;}};

export function visitConfig(env=process.env,rootDir=root){
  return {
    enabled:env.VISITS!=='off',
    dir:env.VISIT_DIR?resolve(env.VISIT_DIR):(env.NODE_TEST_CONTEXT?null:resolve(rootDir,'data','visits')),
    preRollMs:num(env.VISIT_PREROLL_MS,3000),postMs:num(env.VISIT_POST_MS,3000),maxMs:Math.max(1000,num(env.VISIT_MAX_MS,180000)),tailMs:num(env.VISIT_TAIL_MS,6000),
    maxClips:Math.max(1,Math.floor(num(env.VISIT_MAX_CLIPS,100))),maxBytes:Math.max(0.001,num(env.VISIT_MAX_GB,2))*1024**3,minFreeBytes:num(env.VISIT_MIN_FREE_GB,3)*1024**3,
    fps:Math.min(15,Math.max(1,num(env.VISIT_FPS,6))),crf:num(env.VISIT_CRF,28),audio:env.VISIT_AUDIO!=='off'
  };
}
// Env values that shape the tracker/detector, recorded in every sidecar so a clip says which tuning produced its timeline.
export const TUNING_KEYS=['DETECTOR_PRESENCE_SCORE','DETECTOR_MIN_SCORE','DETECTOR_FPS','DETECTOR_STALE_MS','DETECTOR_STATIC_MIN','GROUP_ENTER_MS_SIDEWALK','GROUP_ENTER_MS_PATH','GROUP_EXIT_MS','GROUP_PATH_EXIT_MS','TRACK_HOLD_MS','ZONE_MARGIN','COUNT_WINDOW_MS','MOTION_MIN_DELTA','MOTION_JUDGE','PRESENCE_RESOLVER','PREVIEW_FPS','JUDGE_WIDTH','VISIT_PREROLL_MS','VISIT_POST_MS','VISIT_MAX_MS','VISIT_TAIL_MS','VISIT_FPS','VISIT_CRF','VISIT_AUDIO'];
export const tuningSnapshot=(env,tracker=null)=>({env:Object.fromEntries(TUNING_KEYS.filter(k=>env[k]!==undefined&&env[k]!=='').map(k=>[k,env[k]])),tracker});

// Normalized boxes for one detector result: persons, ignored (static-prop masks), suppressed (static), weak (below the presence cutoff). b=[x1,y1,x2,y2].
export function boxesOf(r){
  const out=[];
  const add=(list,extra)=>{for(const p of list||[])out.push({b:(p.bbox||[]).map(v=>round(v)),s:round(p.score??0,3),zone:p.zone??null,...(p.track!=null?{track:p.track,v:p.v??null,dir:p.dir||'present'}:{}),...extra});};
  add(r.persons,{});add(r.ignored,{ignored:true});add(r.suppressed,{suppressed:true});add(r.weak,{weak:true});for(const p of r.band||[])out.push({b:(p.bbox||[]).map(v=>round(v)),s:round(p.score??0,3),zone:p.zone??null,weak:true,src:'band',...(p.suppressed?{suppressed:true}:{})}); // band-pass boxes (native crop): sidewalk warm-up only, never counted
  return out;
}

// Default encoder: ffmpeg concat of the spooled JPEGs with their real durations -> constant fps H.264. Resolves {ms,user_s,sys_s} (ffmpeg's own -benchmark CPU time).
export function ffmpegEncode({dir,frames,fps=6,crf=28,audio=[],ffmpegPath='ffmpeg',spawnImpl=spawn,niceLevel=10,timeoutMs=600000}){
  return new Promise((resolveP,reject)=>{
    const lines=[];
    frames.forEach((f,i)=>{const next=frames[i+1];const dur=next?Math.max(0.001,(next.t-f.t)/1000):1/fps;lines.push(`file 'frames/${f.name}'`,`duration ${dur.toFixed(3)}`);});
    if(frames.length)lines.push(`file 'frames/${frames.at(-1).name}'`); // concat quirk: the last duration needs a trailing file entry
    const list=join(dir,'frames.txt');writeFileSync(list,lines.join('\n')+'\n',{mode:0o600});
    const args=['-n',String(niceLevel),ffmpegPath,'-hide_banner','-nostats','-loglevel','info','-benchmark','-y','-f','concat','-safe','0','-i',list,...audio.flatMap(a=>['-i',join(dir,a.file)]),'-map','0:v',...audio.flatMap((a,i)=>['-map',`${i+1}:a`]),'-vf',`fps=${fps},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`,'-c:v','libx264','-preset','veryfast','-crf',String(crf),...(audio.length?['-c:a','aac','-b:a','32k','-ac','1',...audio.flatMap((a,i)=>[`-metadata:s:a:${i}`,`title=${a.title}`,`-metadata:s:a:${i}`,`handler_name=${a.title}`])]:[]),'-f','mp4','-movflags','+faststart',join(dir,'video.tmp.mp4')];
    const started=Date.now();let stderr='';
    const child=spawnImpl('nice',args,{stdio:['ignore','ignore','pipe']});
    const timer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}},timeoutMs);timer.unref?.();
    child.stderr.on('data',b=>{stderr=(stderr+b).slice(-4000);});
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{
      clearTimeout(timer);
      try{rmSync(list,{force:true});}catch{}
      if(code!==0){try{rmSync(join(dir,'video.tmp.mp4'),{force:true});}catch{}return reject(new Error('ffmpeg exit '+code));}
      renameSync(join(dir,'video.tmp.mp4'),join(dir,'video.mp4'));chmodSync(join(dir,'video.mp4'),0o600);
      const m=stderr.match(/utime=([\d.]+)s stime=([\d.]+)s rtime=([\d.]+)s/);
      resolveP({ms:Date.now()-started,user_s:m?Number(m[1]):null,sys_s:m?Number(m[2]):null});
    });
  });
}

export function createVisitRecorder({dir,preRollMs=3000,postMs=3000,maxMs=180000,tailMs=6000,maxClips=100,maxBytes=2*1024**3,minFreeBytes=3*1024**3,fps=6,crf=28,presenceScore=0.5,freeCheckMs=10000,
  maxPending=400,audio=null,now=Date.now,enabled=()=>true,mode=()=>null,commit=null,env={},trackerOptions=()=>null,zones=()=>[],freeBytes=null,encodeImpl=null,ffmpegPath='ffmpeg',spawnImpl=spawn,tickMs=1000}={}){
  const on=!!dir,base=on?resolve(dir):null;
  const minGap=Math.max(1,1000/Math.min(15,fps)*0.8);
  let ring=[],recentDets=[],clip=null,lastFrameAt=-Infinity,lowDisk=false,lastFreeCheck=-Infinity,freeNow=null,error=null,inited=false;
  let encodeChain=Promise.resolve(),encoding=0,finalizing=new Set(),stats={clips:0,rejected_disk:0,dropped_frames:0,encode_failures:0};
  const writes=new Set();

  const dirs=()=>{ // oldest first
    if(!on)return [];
    try{return readdirSync(base,{withFileTypes:true}).filter(e=>e.isDirectory()&&validVisitId(e.name)).map(e=>e.name).sort();}catch{return [];}
  };
  const sizeOf=p=>{let t=0;try{for(const e of readdirSync(p,{withFileTypes:true})){const q=join(p,e.name);t+=e.isDirectory()?sizeOf(q):statSync(q).size;}}catch{}return t;};
  const busyIds=()=>new Set([...(clip?[clip.id]:[]),...finalizing]);
  function prune(){
    if(!on)return 0;
    let removed=0,all=dirs();
    const sizes=new Map(all.map(id=>[id,sizeOf(join(base,id))]));let total=[...sizes.values()].reduce((a,b)=>a+b,0);const busy=busyIds();
    for(const id of all){
      if(all.length-removed<=maxClips&&total<=maxBytes)break;
      if(busy.has(id))continue;
      try{rmSync(join(base,id),{recursive:true,force:true});}catch{continue;}
      total-=sizes.get(id)||0;removed++;
    }
    return removed;
  }
  function checkDisk(){
    if(!on)return;
    const t=now();if(t-lastFreeCheck<freeCheckMs&&freeNow!=null)return;lastFreeCheck=t;
    try{
      if(freeBytes)freeNow=freeBytes();
      else{let p=base;for(let i=0;i<6;i++){try{const f=statfsSync(p);freeNow=Number(f.bavail)*Number(f.bsize);break;}catch{p=resolve(p,'..');}}}
    }catch{freeNow=null;}
    // 20% headroom before resuming, as the capture store does.
    if(freeNow!=null){if(freeNow<minFreeBytes)lowDisk=true;else if(freeNow>=minFreeBytes*1.2||!lowDisk)lowDisk=false;}
  }
  const isOn=()=>on&&enabled()&&mode()!=='OFF';

  function recover(){
    if(inited||!on)return;inited=true;
    try{mkdirSync(base,{recursive:true,mode:0o700});chmodSync(base,0o700);}catch(e){error='Cannot create visit directory: '+(e.code||e.message);return;}
    for(const id of dirs()){
      const d=join(base,id),meta=readJson(join(d,'visit.json'));
      if(!meta){try{rmSync(d,{recursive:true,force:true});}catch{}continue;} // crashed mid-visit: spool without a sidecar is not recoverable
      if(!existsSync(join(d,'video.mp4'))&&existsSync(join(d,'frames')))queueEncode(id,meta);
    }
  }

  // ---------- visit lifecycle ----------
  function writeFrame(f){
    if(!clip||!clip.recording)return;
    if(writes.size>=maxPending){stats.dropped_frames++;return;}
    const i=clip.nextIdx++,name=pad(i,6)+'.jpg',t=f.at-clip.startAt;
    clip.frames.push({name,t});
    const c=clip;
    const p=writeFile(join(c.path,'frames',name),f.bytes,{mode:0o600}).catch(e=>{error='Visit frame write failed: '+(e.code||e.message);}).finally(()=>writes.delete(p));
    writes.add(p);c.writeList.push(p);
  }
  function startClip(det,{continued=false,frame=null}={}){
    if(!isOn())return;
    checkDisk();
    if(lowDisk){stats.rejected_disk++;return;}
    recover();
    const at=det?.at??frame.at;
    const first=continued?frame:ring.find(f=>f.at>=at-preRollMs);
    const startAt=first?Math.min(first.at,at):at,t0=now();
    const id=visitStamp(t0)+'-'+randomBytes(3).toString('hex'),path=join(base,id);
    try{mkdirSync(join(path,'frames'),{recursive:true,mode:0o700});chmodSync(path,0o700);chmodSync(join(path,'frames'),0o700);}catch(e){error='Cannot create visit directory: '+(e.code||e.message);return;}
    clip={id,path,startAt,startWall:t0,epochStart:t0-Math.max(0,t0-startAt),recording:true,lastPersonAt:det?at:frame.at,lastEventWall:t0,nextIdx:1,frames:[],writeList:[],dets:[],timeline:[],reads:[],speech:[],continued,
      initialState:continued?(lastState||'EMPTY'):'EMPTY',maxPersons:0,zonesAtStart:zones(),transcript:[],audio:audio?audio.begin(startAt):null};
    if(continued)clip.timeline.push({t:0,state:clip.initialState});
    // Pre-roll: frames already seen (never written unless a visit starts), plus detector results back to startAt so replay sees the same history the live tracker did.
    if(!continued){for(const f of ring)if(f.at>=startAt)writeFrame(f);for(const r of recentDets)if(r.at>=startAt)addDet(r);}
    else if(frame)writeFrame(frame);
    if(det&&!(clip.dets.length&&clip.dets.at(-1).at===det.at))addDet(det);
    stats.clips++;
  }
  let lastState=null;
  function addDet(r){
    const t=r.at-clip.startAt,b=boxesOf(r),q=r.persons?.length||0;
    clip.dets.push({at:r.at,t,boxes:b});
    clip.maxPersons=Math.max(clip.maxPersons,q);
    const st=r.group?.state??null;
    if(st&&(!clip.timeline.length||clip.timeline.at(-1).state!==st))clip.timeline.push({t,state:st,count:r.group?.count??null});
  }
  function stopRecording(){if(clip){clip.recording=false;clip.audio?.stop();}}
  function finalize(reason){
    const c=clip;if(!c)return;clip=null;
    c.recording=false;c.audio?.stop();finalizing.add(c.id);
    Promise.allSettled(c.writeList).then(()=>{
      try{
        const lastDet=c.dets.at(-1),lastFrame=c.frames.at(-1),videoMs=lastFrame?lastFrame.t+Math.round(1000/fps):0;
        const endMs=Math.max(videoMs,lastDet?lastDet.t:0);
        const meta={version:1,id:c.id,started_at:new Date(c.epochStart).toISOString(),start_ms:c.epochStart,ended_at:new Date(c.epochStart+endMs).toISOString(),end_ms:endMs,video_ms:videoMs,frame_count:c.frames.length,
          frame_times:c.frames.map(f=>f.t),end_reason:reason,continued:c.continued,initial_state:c.initialState,max_state:maxState(c.timeline),max_persons:c.maxPersons,timeline:c.timeline,detections:c.dets,
          judge_reads:c.reads,speech:c.speech,transcript:c.transcript,audio:null,zones:c.zonesAtStart,presence_score:presenceScore,tracker:trackerOptions(),tuning:tuningSnapshot(env,trackerOptions()).env,mode:mode(),commit,fps,preroll_ms:preRollMs,post_ms:postMs,video:null,spool:c.frames.map(f=>f.name)};
        if(!c.frames.length){rmSync(c.path,{recursive:true,force:true});return;}
        if(c.audio){ // two mono tracks, exactly as long as the video: mic.wav + assistant.wav (replay input), muxed into the MP4 by the encode
          const pcm=c.audio.render(videoMs);
          writeFileSync(join(c.path,'mic.wav'),toWav(pcm.mic,MIC_RATE),{mode:0o600});writeFileSync(join(c.path,'assistant.wav'),toWav(pcm.assistant,ASSISTANT_RATE),{mode:0o600});
          meta.audio={mic:{file:'mic.wav',rate:MIC_RATE,bytes:pcm.mic.length+44},assistant:{file:'assistant.wav',rate:ASSISTANT_RATE,bytes:pcm.assistant.length+44}};
        }
        jsonFile(join(c.path,'visit.json'),meta);
        queueEncode(c.id,meta);
      }catch(e){error='Visit finalize failed: '+(e.code||e.message);}
      finally{finalizing.delete(c.id);}
    });
  }
  function queueEncode(id,meta){
    encoding++;finalizing.add(id);
    encodeChain=encodeChain.then(async()=>{
      const d=join(base,id),frames=(meta.spool||[]).map((name,i)=>({name,t:meta.frame_times[i]}));
      try{
        const run=encodeImpl||(opts=>ffmpegEncode({...opts,ffmpegPath,spawnImpl}));
        const r=await run({dir:d,frames,fps:meta.fps||fps,crf,audio:meta.audio?[{file:'mic.wav',title:'mic'},{file:'assistant.wav',title:'assistant'}]:[]});
        if(!existsSync(join(d,'video.mp4')))writeFileSync(join(d,'video.mp4'),'',{mode:0o600}); // injected encoders may not write one
        const next={...meta,video:'video.mp4',encode:{timing:'real',ms:r?.ms??null,user_s:r?.user_s??null,sys_s:r?.sys_s??null,video_bytes:statSync(join(d,'video.mp4')).size,crf,preset:'veryfast'}};
        delete next.spool;jsonFile(join(d,'visit.json'),next);
        rmSync(join(d,'frames'),{recursive:true,force:true});
      }catch(e){stats.encode_failures++;error='Visit encode failed: '+String(e.message||e).slice(0,120);try{jsonFile(join(d,'visit.json'),{...meta,encode_error:String(e.message||e).slice(0,160)});}catch{}}
      finally{encoding--;finalizing.delete(id);try{prune();}catch{}}
    });
    return encodeChain;
  }

  // ---------- inputs ----------
  function onFrame(f){
    if(!on||!f?.bytes||!Number.isFinite(f.at))return;
    if(!isOn()){if(clip)finalize('disabled');ring=[];audio?.clear();return;}
    if(f.at-lastFrameAt<minGap)return;lastFrameAt=f.at;
    ring.push({bytes:f.bytes,at:f.at});const cut=f.at-preRollMs-1000;while(ring.length&&ring[0].at<cut)ring.shift();
    if(!clip)return;
    clip.lastEventWall=now();
    if(clip.recording){
      if(f.at-clip.lastPersonAt>postMs)stopRecording();
      else if(f.at-clip.startAt>=maxMs){const carried=lastState;finalize('max_length');lastState=carried;startClip(null,{continued:true,frame:f});}
      else writeFrame(f);
    }
  }
  function onDetect(r){
    if(!on||!r||!Number.isFinite(r.at))return;
    if(!isOn()){if(clip)finalize('disabled');recentDets=[];return;}
    const qualifying=(r.persons||[]).filter(p=>p.zone&&p.zone!=='other'&&p.score>=presenceScore).concat(r.sidewalk||[]); // r.sidewalk: weak boxes on the sidewalk (SIDEWALK_PRESENCE_SCORE) warm up recording only
    const rec={at:r.at,persons:r.persons||[],ignored:r.ignored||[],suppressed:r.suppressed||[],weak:r.weak||[],band:r.band||[],group:r.group?{state:r.group.state,count:r.group.count}:null};
    recentDets.push(rec);const cut=r.at-preRollMs-1000;while(recentDets.length&&recentDets[0].at<cut)recentDets.shift();
    const prevState=lastState;if(r.group?.state)lastState=r.group.state;
    if(!clip){if(qualifying.length)startClip(rec,{continued:false});return;}
    clip.lastEventWall=now();
    if(qualifying.length&&!clip.recording){ // a new person after the video ended (during the tail): close the old visit here, open a new one
      finalize('new_visit');lastState=r.group?.state??prevState;startClip(rec,{continued:true,frame:null});
      if(clip)clip.initialState=prevState||'EMPTY';
      return;
    }
    addDet(rec);
    if(qualifying.length){clip.lastPersonAt=r.at;return;}
    const quiet=r.at-clip.lastPersonAt;
    if(quiet>=postMs){
      if(clip.recording&&r.at-lastFrameAt>=0&&quiet>postMs)stopRecording();
      // Video is done after postMs; the sidecar follows the live tracker until it reports EMPTY (or tailMs more).
      if(!clip.recording&&(rec.group?.state==='EMPTY'||rec.group==null||quiet>=postMs+tailMs))finalize('post_roll');
    }
  }
  function noteRead(read){
    if(!clip||!read)return;
    if(clip.reads.length>=500)return;
    clip.reads.push({t:(read.at??now())-clip.startAt,...read,at:undefined});
  }
  // Speech timeline (linux-live onSpeech + arrival notes): {kind, at (ms epoch, same clock as detections), text?, source?, ...}. Stored as t = ms from the clip start in whichever clip is active.
  function noteSpeech(ev){
    if(!clip||!ev||!ev.kind)return;
    if(clip.speech.length>=300)return;
    const {kind,at,session_id,...rest}=ev;
    clip.speech.push({t:Math.max(0,round((Number.isFinite(at)?at:now())-clip.startAt,1)),kind,...rest});
  }
  // Full transcript fragments ({role,text,at}): assistant and visitor words, same clock as everything else (t = ms from the clip start). Merged into turns by the UI.
  function noteTranscript(f){
    if(!clip||!f||!['user','assistant'].includes(f.role))return;
    const text=String(f.text??f.delta??'');if(!text||clip.transcript.length>=3000)return;
    clip.transcript.push({t:Math.max(0,round((Number.isFinite(f.at)?f.at:now())-clip.startAt,1)),role:f.role,text:text.slice(0,2000)});
  }
  // Housekeeping for stalled inputs: no frames/detections for a while ends the visit. Exposed for tests; runs on an unref'd interval.
  function tick(){
    if(!on)return;
    if(clip&&now()-clip.lastEventWall>postMs+tailMs)finalize('stalled');
    else if(clip&&clip.recording&&now()-clip.lastEventWall>postMs)stopRecording();
  }
  const timer=on?setInterval(tick,tickMs):null;timer?.unref?.();

  // ---------- reads ----------
  const metaOf=id=>validVisitId(id)&&on?readJson(join(base,id,'visit.json')):null;
  function summary(id){
    const m=metaOf(id);if(!m)return null;
    const d=join(base,id);let size=0;try{size=sizeOf(d);}catch{}
    return {id,start:m.started_at,duration_ms:m.video_ms,end_ms:m.end_ms,max_state:m.max_state,frame_count:m.frame_count,size_bytes:size,video:existsSync(join(d,'video.mp4'))&&m.video!=null,audio:Boolean(m.audio),runs:countRuns(d),encoding:m.video==null&&!m.encode_error,continued:Boolean(m.continued),end_reason:m.end_reason,encode_ms:m.encode?.ms??null,...summaryOf(m)};
  }
  function list(){return dirs().reverse().map(summary).filter(Boolean);} // newest first
  const get=id=>metaOf(id);
  const audioPath=(id,track)=>{if(!validVisitId(id)||!on||!['mic','assistant'].includes(track))return null;const p=join(base,id,track+'.wav');return existsSync(p)?p:null;};
  const dirOf=id=>validVisitId(id)&&on&&existsSync(join(base,id))?join(base,id):null;
  const videoPath=id=>{if(!validVisitId(id)||!on)return null;const p=join(base,id,'video.mp4');return existsSync(p)&&statSync(p).size>0?p:null;};
  function remove(id){
    if(!validVisitId(id)||!on||busyIds().has(id))return false;
    const p=join(base,id);if(!existsSync(p))return false;rmSync(p,{recursive:true,force:true});return true;
  }
  // One JPEG from the encoded video at t ms, via ffmpeg to stdout (nothing written to disk).
  function frameAt(id,tMs){
    return new Promise((res,rej)=>{
      const p=videoPath(id);if(!p)return rej(fail(404,'Video is not available.'));
      const child=spawnImpl(ffmpegPath,['-hide_banner','-loglevel','error','-ss',(Math.max(0,tMs)/1000).toFixed(3),'-i',p,'-frames:v','1','-f','image2pipe','-vcodec','mjpeg','pipe:1'],{stdio:['ignore','pipe','ignore']});
      const chunks=[];let size=0;
      const timeout=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}},10000);timeout.unref?.();
      child.stdout.on('data',b=>{size+=b.length;if(size>8_000_000){try{child.kill('SIGKILL');}catch{}return;}chunks.push(b);});
      child.on('error',()=>{clearTimeout(timeout);rej(fail(503,'Cannot run ffmpeg.'));});
      child.on('close',()=>{clearTimeout(timeout);const out=Buffer.concat(chunks);if(out.length<4||out[0]!==0xff||out[1]!==0xd8)rej(fail(404,'No frame at that time.'));else res(out);});
    });
  }
  const status=()=>({enabled:on&&enabled(),audio:Boolean(audio)&&on,audio_status:audio?.status()||null,active:isOn(),recording:Boolean(clip),clip_id:clip?.id||null,clip_started_at:clip?new Date(clip.epochStart).toISOString():null,frames:clip?.frames.length||0,
    clips:on?dirs().length:0,max_clips:maxClips,max_bytes:maxBytes,encoding,low_disk:lowDisk,free_bytes:freeNow,error,...stats});
  const flush=async()=>{await Promise.allSettled([...writes]);await new Promise(r=>setImmediate(r));await Promise.allSettled([...writes]);await encodeChain;};
  const close=()=>{clearInterval(timer);};
  if(on)recover();
  return {audioPath,dirOf,audioEnabled:()=>Boolean(audio)&&on,onFrame,onDetect,noteRead,noteSpeech,noteTranscript,tick,list,get,summary,videoPath,remove,frameAt,status,flush,close,prune,checkDisk,finalizeNow:reason=>finalize(reason||'manual'),active:()=>clip,dir:base};
}

// ---------- HTTP (host/origin checks already ran in server.mjs; POST/DELETE need the Origin check there) ----------
// Returns true when handled.
export async function handleVisitRoute(rec,{req,res,path,send}){
  if(req.method==='GET'&&path==='/api/visits'){send(200,{...rec.status(),visits:rec.list()});return true;}
  const m=path.match(/^\/api\/visits\/([^/]+)(?:\/(video|meta|frame|replay|levels)|\/(audio|runs)(?:\/.*)?)?$/);
  if(!m)return false;
  const id=m[1],kind=m[2]||m[3];
  if(!validVisitId(id))throw fail(404,'Visit not found.');
  if(kind==='audio'||kind==='levels'||kind==='runs'){
    if(req.method!=='GET')return false;
    return handleRunRoute(rec,{req,res,path,send,id,kind});
  }
  if(req.method==='DELETE'&&!kind){if(!rec.remove(id))throw fail(404,'Visit not found or still recording.');send(200,{deleted:id});return true;}
  if(req.method!=='GET')return false;
  if(kind==='meta'){const meta=rec.get(id);if(!meta)throw fail(404,'Visit not found.');const {spool,...rest}=meta;send(200,rest);return true;}
  if(kind==='replay'){const meta=rec.get(id);if(!meta)throw fail(404,'Visit not found.');send(200,replayMeta(meta));return true;}
  if(kind==='frame'){
    const t=Number(new URL(req.url,'http://localhost').searchParams.get('t'));
    if(!Number.isFinite(t)||t<0)throw fail(400,'t is milliseconds from the start of the clip.');
    send(200,await rec.frameAt(id,t),'image/jpeg');return true;
  }
  if(kind==='video'){
    const p=rec.videoPath(id);if(!p)throw fail(404,'Video is not available (still encoding?).');
    return sendFileRange(req,res,p,'video/mp4');
  }
  return false;
}
function countRuns(d){try{return readdirSync(join(d,'runs'),{withFileTypes:true}).filter(e=>e.isDirectory()).length;}catch{return 0;}}
export {pcmLevels,parseWav};
