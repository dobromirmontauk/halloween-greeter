#!/usr/bin/env node
// Replay the local person detector over capture-store clips (and optionally judge-log reads), offline and free (no OpenAI calls).
// PRIVATE data: results sit next to the clips (gitignored). Nothing here is ever committed.
//
//   node scripts/detector-replay.mjs --clips all [--every N] [--max-frames 300] [--width 960|native|<px>] [--judge-log]
//        [--zones file.json] [--static-min 10] [--min-score 0.4] [--model detector/models/yolox_tiny.onnx] [--size 416]
//        [--label name] [--dir data/captures] [--yes]
//   then:  node scripts/judge-replay.mjs --compare live detector-<run_id>      (presence agreement/accuracy against the live Judge)
//
// Output per clip: <clip>/replays/detector-<run_id>/{run.json,results.jsonl,report.md}. results.jsonl uses the same record shape as
// judge-replay (judge:'presence', answers:[real_people_count]) so --compare reads it unchanged; the detector's own boxes are in `detector`.
// Judge-log reads go to <judge-log>/detector-replays/<run_id>/.
//
// CAVEAT: the capture store saves only frames where the live Presence read was >= 1 or uncertain, so a replay measures false negatives
// and false positives WITHIN those frames. It cannot measure how often the detector fires on a truly empty yard.
import {mkdir,writeFile,appendFile,readFile,chmod} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {jpegSize} from '../src/presence/camera-stream.mjs';
import {createCaptureStore,labelResolver} from '../src/presence/capture-store.mjs';
import {createJudgeLog,logConfig} from '../src/presence/judge-log.mjs';
import {createSidecarClient} from '../src/lib/sidecar.mjs';
import {analyze,createStaticSuppressor,readZonesFile,DEFAULT_ZONES_FILE,countLabel,LOCATION_TO_JUDGE} from '../src/presence/person-detector.mjs';
import {resizeJpeg,bucketCount} from './judge-replay.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const readLines=async f=>{let t='';try{t=await readFile(f,'utf8');}catch{return [];}return t.split('\n').filter(l=>l.trim()).map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(Boolean);};
const priv=async d=>{await mkdir(d,{recursive:true,mode:0o700});await chmod(d,0o700).catch(()=>{});};

export function parseArgs(argv){
 const o={dir:resolve(process.env.CAPTURE_DIR||join(root,'data','captures')),clips:'all',every:1,maxFrames:300,width:960,judgeLog:false,judgeLogDir:resolve(process.env.JUDGE_LOG_DIR||join(root,'data','judge-log')),zones:null,staticMin:10,minScore:null,model:null,size:null,label:null,yes:false,ffmpegPath:process.env.FFMPEG_PATH||'ffmpeg',python:process.env.DETECTOR_PYTHON||join(root,'detector','.venv','bin','python')};
 for(let i=0;i<argv.length;i++){
  const a=argv[i],next=()=>{if(i+1>=argv.length)throw new Error('Missing value for '+a);return argv[++i];};
  if(a==='--dir')o.dir=resolve(next());else if(a==='--clips')o.clips=next();
  else if(a==='--every')o.every=Math.max(1,Math.floor(Number(next())||1));
  else if(a==='--max-frames')o.maxFrames=Math.max(1,Math.floor(Number(next())||1));
  else if(a==='--width'){const v=next();if(v==='native')o.width='native';else{const n=Number(v);if(!Number.isInteger(n)||n<160||n>7680)throw new Error('--width must be 960, native or a pixel width');o.width=n;}}
  else if(a==='--judge-log')o.judgeLog=true;else if(a==='--judge-log-dir')o.judgeLogDir=resolve(next());
  else if(a==='--zones')o.zones=resolve(next());else if(a==='--static-min')o.staticMin=Math.max(0,Number(next())||0);
  else if(a==='--min-score')o.minScore=Number(next());else if(a==='--model')o.model=resolve(next());else if(a==='--size')o.size=Number(next());
  else if(a==='--label')o.label=next().replace(/[^A-Za-z0-9_-]/g,'').slice(0,30)||null;
  else if(a==='--yes')o.yes=true;else throw new Error('Unknown argument: '+a);
 }
 return o;
}
const globRe=g=>new RegExp('^'+g.split('*').map(s=>s.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$');
const pickClips=(clips,spec)=>{if(!spec||spec==='all')return clips;const res=spec.split(',').map(s=>globRe(s.trim()));return clips.filter(c=>res.some(r=>r.test(c.clip_id)||r.test(c.date+'/'+c.clip_id)));};

// ---------- metrics (pure) ----------
const pct=(c,n)=>n?`${(100*c/n).toFixed(1)}% (${c}/${n})`:'n/a';
export function newStats(){return {frames:0,live:{n:0,exact:0,presence_agree:0,detector_only:0,judge_only:0},label:{n:0,det_exact:0,det_presence_ok:0,fn:0,fp:0,live_n:0,live_exact:0},
 props:{frames_with_ignored:0,frames_with_suppressed:0,ignored:0,suppressed:0,residual_fp_frames:0},location:{n:0,agree:0,confusion:{}},ms:[]};}
const toNum=v=>v==null?null:v==='11_plus'?11:v==='6_plus'?6:v==='4_5'?4.5:Number.isFinite(Number(v))?Number(v):null;
// rec: {result (analyze output), live:{count,location}|null, label:{real_people_count}|null}
export function addFrame(st,{result,live=null,label=null}){
 st.frames++;st.ms.push(result.ms??0);
 const d=result.count;
 if(result.ignored.length){st.props.frames_with_ignored++;st.props.ignored+=result.ignored.length;}
 if(result.suppressed.length){st.props.frames_with_suppressed++;st.props.suppressed+=result.suppressed.length;}
 if(live&&Number.isFinite(live.count)){const L=st.live;L.n++;if(String(countLabel(live.count))===String(countLabel(d)))L.exact++;if((live.count>=1)===(d>=1))L.presence_agree++;else if(d>=1)L.detector_only++;else L.judge_only++;}
 const lab=label?.real_people_count!=null?bucketCount(label.real_people_count):null;
 if(lab!=null&&lab!=='uncertain'){
  const t=toNum(lab),B=st.label;B.n++;if(String(lab)===String(countLabel(d)))B.det_exact++;
  if((t>=1)===(d>=1))B.det_presence_ok++;else if(t>=1)B.fn++;else{B.fp++;st.props.residual_fp_frames++;}
  if(live&&Number.isFinite(live.count)){B.live_n++;if(String(countLabel(live.count))===String(lab))B.live_exact++;}
 }
 const liveLoc=live?.location==='approaching'?'path':live?.location; // old logs say approaching
 if(liveLoc&&['sidewalk','path','porch'].includes(liveLoc)&&d>=1){
  const dz=LOCATION_TO_JUDGE[result.location]||'uncertain',key=`${liveLoc} -> ${dz}`,L=st.location;L.n++;if(dz===liveLoc)L.agree++;L.confusion[key]=(L.confusion[key]||0)+1;
 }
}
export function mergeStats(into,from){
 into.frames+=from.frames;into.ms.push(...from.ms);
 for(const g of ['live','label','props'])for(const [k,v] of Object.entries(from[g]))into[g][k]+=v;
 into.location.n+=from.location.n;into.location.agree+=from.location.agree;
 for(const [k,v] of Object.entries(from.location.confusion))into.location.confusion[k]=(into.location.confusion[k]||0)+v;
}
export function formatReport(title,st,{meta={}}={}){
 const ms=[...st.ms].sort((a,b)=>a-b),avg=ms.length?ms.reduce((a,b)=>a+b,0)/ms.length:null,p95=ms.length?ms[Math.min(ms.length-1,Math.floor(ms.length*0.95))]:null;
 const L=[`# ${title}`,'',`Detector: ${meta.model||'?'} @${meta.size||'?'} min_score ${meta.min_score??'?'}, static suppression ${meta.static_min??'?'} min, zones ${meta.zones_source||'?'}.`,'',
  '> Capture-store clips hold only frames where the live Presence read was >= 1 or uncertain. This report measures false negatives and false positives WITHIN those frames, not on a truly empty yard.','',
  `Frames: ${st.frames}. Latency: avg ${avg==null?'n/a':avg.toFixed(1)} ms, p95 ${p95==null?'n/a':p95.toFixed(1)} ms (sidecar inference, this machine).`,'',
  '## Detector vs live Presence judge','',`- exact count bucket: ${pct(st.live.exact,st.live.n)}`,`- same present/absent: ${pct(st.live.presence_agree,st.live.n)}`,`- detector sees people, judge says none: ${st.live.detector_only}`,`- judge sees people, detector says none: ${st.live.judge_only}`,'',
  '## Against labels','',`- detector exact count: ${pct(st.label.det_exact,st.label.n)}`,`- detector present/absent correct: ${pct(st.label.det_presence_ok,st.label.n)} (false negatives ${st.label.fn}, false positives ${st.label.fp})`,
  `- live judge exact count on the same labeled frames: ${pct(st.label.live_exact,st.label.live_n)}`,'',
  '## Props','',`- detections removed by ignore masks: ${st.props.ignored} in ${st.props.frames_with_ignored} frames`,`- detections suppressed as static: ${st.props.suppressed} in ${st.props.frames_with_suppressed} frames`,
  `- residual false positives (labeled empty, detector still counts someone): ${st.props.residual_fp_frames} frames`,'',
  '## Location (zone vs live Motion judge visitor_location; path = on the property)','',`- agreement: ${pct(st.location.agree,st.location.n)}`];
 for(const [k,v] of Object.entries(st.location.confusion).sort())L.push(`  - ${k}: ${v}`);
 return L.join('\n')+'\n';
}

// ---------- running ----------
export function makeSidecar(opts,spawnImpl){
 const env={...process.env,...(opts.model?{DETECTOR_MODEL:opts.model}:{}),...(opts.size?{DETECTOR_SIZE:String(opts.size)}:{}),...(opts.minScore!=null?{DETECTOR_MIN_SCORE:String(opts.minScore)}:{})};
 return createSidecarClient({command:opts.python,args:['-I',join(root,'detector','detect.py')],env,spawnImpl,timeoutMs:30000});
}
async function waitReady(sc,ms=30000){const end=Date.now()+ms;while(sc.status().state!=='ready'){if(sc.status().state==='disabled')throw new Error('Detector sidecar failed: '+(sc.status().error||'unknown')+' (run detector/fetch-models.sh and create detector/.venv)');if(Date.now()>end)throw new Error('Detector sidecar did not become ready');await new Promise(r=>setTimeout(r,50));}}
const bucketAnswer=count=>({name:'real_people_count',choice:countLabel(count),confidence:1});

export async function main(argv,{log=console.log,sidecar:injected=null,spawnImpl}={}){
 const opts=parseArgs(argv);
 const zonesDoc=(opts.zones?readZonesFile(opts.zones):null)||(existsDefault());
 const zones=zonesDoc.zones,zonesSource=opts.zones?opts.zones:'detector-zones.json or defaults';
 const store=createCaptureStore({dir:opts.dir,enabled:()=>false});
 const clips=pickClips((await store.list({limit:100000})).clips,opts.clips);
 const items=[];
 for(const c of clips){const found=await store.findClip(c.clip_id),frames=await store.frameFiles(found.path);items.push({kind:'clip',clip:c,path:found.path,frames:frames.filter((_,i)=>i%opts.every===0)});}
 let judgeEntries=[];
 const jl=opts.judgeLog?createJudgeLog({...logConfig({},root),dir:opts.judgeLogDir,enabled:true}):null;
 if(jl){for(let off=0;;off+=50){const {items:page}=await jl.list({offset:off,limit:50});if(!page.length)break;judgeEntries.push(...page);if(judgeEntries.length>=opts.maxFrames)break;}}
 // frame cap across everything, so a run can never snowball (decode + resize + inference per frame)
 let budget=opts.maxFrames;for(const it of items){it.frames=it.frames.slice(0,Math.max(0,budget));budget-=it.frames.length;}
 judgeEntries=judgeEntries.slice(0,Math.max(0,budget));
 const total=items.reduce((n,i)=>n+i.frames.length,0)+judgeEntries.length;
 log(`Plan: ${items.length} clip(s)${jl?` + ${judgeEntries.length} judge-log read(s)`:''}, ${total} frame(s) (cap ${opts.maxFrames}), every ${opts.every}, width ${opts.width}. No network, no cost.`);
 if(!opts.yes){log('Re-run with --yes to proceed. Nothing was run.');return {frames:total,gated:true};}
 const sc=injected||makeSidecar(opts,spawnImpl);sc.start?.();
 const startedAt=new Date().toISOString(),runId=startedAt.slice(0,19).replace(/[-:T]/g,'').replace(/^(\d{8})(\d{6})$/,'$1-$2')+(opts.label?'-'+opts.label:'');
 const dirName='detector-'+runId,meta={model:opts.model?opts.model.split('/').pop():'detector default',size:opts.size||'default',min_score:opts.minScore??'default',static_min:opts.staticMin,zones_source:zonesSource};
 const grand=newStats();const out={run_id:dirName,clips:[],frames:0,gated:false};
 try{
  await waitReady(sc);
  const detect=async bytes=>{
   const img=await resizeJpeg(bytes,opts.width,{ffmpegPath:opts.ffmpegPath});
   return {raw:await sc.call('detect',{jpeg:img.toString('base64')}),sent:jpegSize(img)};
  };
  for(const it of items){
   if(!it.frames.length)continue;
   const dir=join(it.path,'replays',dirName);await priv(join(it.path,'replays'));await mkdir(dir,{mode:0o700});await chmod(dir,0o700).catch(()=>{});
   const resultsFile=join(dir,'results.jsonl');await writeFile(resultsFile,'',{mode:0o600});
   const resolver=labelResolver(await readLines(join(it.path,'labels.jsonl'))),live=await readLines(join(it.path,'judge.jsonl'));
   const suppressor=createStaticSuppressor({staticMs:opts.staticMin*60000});
   const st=newStats();
   for(const f of it.frames){ // time order, so the static-suppression clock sees real capture times
    const bytes=await store.frame(it.clip.clip_id,f.index);if(!bytes)continue;
    const {raw}=await detect(bytes);
    const result=analyze(raw,{zones,suppressor,at:f.at});
    const lp=live.find(x=>x.judge==='presence'&&x.frame_ats?.[0]===f.at),lm=live.find(x=>x.judge==='motion'&&x.frame_ats?.[0]===f.at);
    const liveInfo=lp&&Number.isFinite(lp.parsed?.visitor_count)?{count:lp.parsed.visitor_count,location:lm?.parsed?.visitor_location??null}:null;
    addFrame(st,{result,live:liveInfo,label:resolver(f.index)});
    await appendFile(resultsFile,JSON.stringify({at:f.at,frame_index:f.index,judge:'presence',answers:[bucketAnswer(result.count)],detector:{count:result.count,raw_count:result.raw_count,location:result.location,ms:result.ms,persons:result.persons,suppressed:result.suppressed,ignored:result.ignored},error:null})+'\n',{mode:0o600});
   }
   await writeFile(join(dir,'run.json'),JSON.stringify({run_id:dirName,clip_id:it.clip.clip_id,judges:['presence'],source:'detector',...meta,width:opts.width,every:opts.every,started_at:startedAt,finished_at:new Date().toISOString(),frames:st.frames},null,1)+'\n',{mode:0o600});
   await writeFile(join(dir,'report.md'),formatReport('Detector replay: '+it.clip.clip_id,st,{meta}),{mode:0o600});
   mergeStats(grand,st);out.clips.push(it.clip.clip_id);out.frames+=st.frames;
   log(`${it.clip.clip_id}: ${st.frames} frame(s) -> replays/${dirName}`);
  }
  if(judgeEntries.length){
   const dir=join(opts.judgeLogDir,'detector-replays',runId);await priv(join(opts.judgeLogDir,'detector-replays'));await mkdir(dir,{mode:0o700});
   const resultsFile=join(dir,'results.jsonl');await writeFile(resultsFile,'',{mode:0o600});const st=newStats(),suppressor=createStaticSuppressor({staticMs:opts.staticMin*60000});
   for(const e of [...judgeEntries].sort((a,b)=>a.captured_at-b.captured_at)){
    const bytes=await jl.image(e.read_key);if(!bytes)continue;const full=await jl.get(e.read_key);
    const {raw}=await detect(bytes);const result=analyze(raw,{zones,suppressor,at:e.captured_at});
    const liveCount=full?.parsed?.visitor_count;
    addFrame(st,{result,live:Number.isFinite(liveCount)?{count:liveCount,location:full.parsed.visitor_location}:null,label:full?.label||null});
    await appendFile(resultsFile,JSON.stringify({at:e.captured_at,read_key:e.read_key,judge:'presence',answers:[bucketAnswer(result.count)],detector:{count:result.count,location:result.location,ms:result.ms,persons:result.persons,suppressed:result.suppressed,ignored:result.ignored},error:null})+'\n',{mode:0o600});
   }
   await writeFile(join(dir,'report.md'),formatReport('Detector replay: judge-log reads',st,{meta}),{mode:0o600});
   mergeStats(grand,st);out.frames+=st.frames;log(`judge-log: ${st.frames} read(s) -> ${dir}`);
  }
 }finally{sc.stop?.();}
 const report=formatReport(`Detector replay ${dirName}`,grand,{meta});log(report);
 await priv(opts.dir);await writeFile(join(opts.dir,`${dirName}.md`),report,{mode:0o600});
 return {...out,stats:grand};
}
function existsDefault(){return readZonesFile(join(root,'data','detector-zones.json'))||readZonesFile(DEFAULT_ZONES_FILE)||{zones:[]};}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 main(process.argv.slice(2)).then(r=>{if(r?.gated)process.exitCode=2;}).catch(e=>{console.error(e.message);process.exit(1);});
}
