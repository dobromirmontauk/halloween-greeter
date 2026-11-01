#!/usr/bin/env node
// Replay captured clips (capture-store.mjs) against the CURRENT or an alternative set of Judge/Luna prompts, then compare runs.
// PRIVATE data: results sit next to the clips (gitignored). Nothing here is ever committed.
//
//   node scripts/judge-replay.mjs --clips all [--judges presence,motion,costume,scene] [--prompt-file ./alt-prompts.mjs]
//        [--spacing-ms 1000] [--every N] [--limit N] [--width 960|1280|1920|native] [--detail auto|low|high|original] [--label name] [--dir data/captures] [--yes]
//   node scripts/judge-replay.mjs --compare <run_a|live> <run_b|live> [--clips all]
//
// --prompt-file: a module that may export presenceRequest, motionRequest, costumeRequest, sceneRequest (and parsePresence/
// parseMotion/parseCostume); anything it omits falls back to the real builders in decisions.mjs / server.mjs.
import {mkdir,writeFile,appendFile,readFile,chmod,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync,spawn} from 'node:child_process';
import {jpegSize} from '../src/presence/camera-stream.mjs';
import * as decisions from '../src/presence/decisions.mjs';
import {sceneRequest as currentSceneRequest,loadEnv} from '../server.mjs';
import {promptHash} from '../src/presence/judge-log.mjs';
import {createCaptureStore,labelResolver,validClipId} from '../src/presence/capture-store.mjs';
import {tokenCostUsd,usageTokens} from '../src/lib/costs.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const ALL_JUDGES=['presence','motion','costume','scene'];
const DEFAULT_JUDGES=['presence','motion','costume'];
// Planning assumptions only (image ~1,100 input tokens at detail auto + prompt; answers are short). Real usage is recorded per call.
export const ESTIMATE_TOKENS={presence:{input:1700,output:40},motion:{input:3000,output:120},costume:{input:1800,output:80},scene:{input:1700,output:300}};

export function parseArgs(argv){
  const o={dir:resolve(process.env.CAPTURE_DIR||join(root,'data','captures')),clips:'all',judges:DEFAULT_JUDGES,promptFile:null,spacingMs:2000,every:1,limit:Infinity,yes:false,compare:null,label:null,model:null,width:960,detail:null,ffmpegPath:process.env.FFMPEG_PATH||'ffmpeg'};
  for(let i=0;i<argv.length;i++){
    const a=argv[i],next=()=>{if(i+1>=argv.length)throw new Error('Missing value for '+a);return argv[++i];};
    if(a==='--dir')o.dir=resolve(next());
    else if(a==='--clips')o.clips=next();
    else if(a==='--judges'){o.judges=next().split(',').map(s=>s.trim()).filter(Boolean);for(const j of o.judges)if(!ALL_JUDGES.includes(j))throw new Error('Unknown judge: '+j);}
    else if(a==='--prompt-file')o.promptFile=resolve(next());
    else if(a==='--spacing-ms')o.spacingMs=Math.max(0,Number(next())||0);
    else if(a==='--every')o.every=Math.max(1,Math.floor(Number(next())||1));
    else if(a==='--limit')o.limit=Math.max(1,Math.floor(Number(next())||1));
    else if(a==='--label')o.label=next().replace(/[^A-Za-z0-9_-]/g,'').slice(0,30)||null;
    else if(a==='--model')o.model=next();
    else if(a==='--width'){const v=next();if(v==='native')o.width='native';else{const n=Number(v);if(!Number.isInteger(n)||n<160||n>7680)throw new Error('--width must be 960, 1280, 1920, native or a pixel width');o.width=n;}}
    else if(a==='--detail'){const v=next();if(!['auto','low','high','original'].includes(v))throw new Error('--detail must be auto, low, high or original');o.detail=v;}
    else if(a==='--yes')o.yes=true;
    else if(a==='--compare'){o.compare=[next(),next()];}
    else throw new Error('Unknown argument: '+a);
  }
  return o;
}

const globRe=g=>new RegExp('^'+g.split('*').map(s=>s.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$');
// spec: 'all', a comma list of clip ids / globs matched against clip_id or date/clip_id.
export function filterClips(clips,spec){
  if(!spec||spec==='all')return clips;
  const res=spec.split(',').map(s=>globRe(s.trim()));
  return clips.filter(c=>res.some(r=>r.test(c.clip_id)||r.test(c.date+'/'+c.clip_id)));
}

export async function loadBuilders(promptFile){
  const alt=promptFile?await import(pathToFileURL(promptFile).href):{};
  const pick=name=>alt[name]||decisions[name];
  return {presenceRequest:pick('presenceRequest'),motionRequest:pick('motionRequest'),costumeRequest:pick('costumeRequest'),
    parsePresence:pick('parsePresence'),parseMotion:pick('parseMotion'),parseCostume:pick('parseCostume'),sceneRequest:alt.sceneRequest||currentSceneRequest,
    promptFile:promptFile||null};
}
// Stable per-judge prompt hash from a probe request (so it does not depend on image bytes or frame gaps).
export function promptHashes(b,model){
  const img={bytes:Buffer.from([0xff,0xd8,0xff,0xd9]),at:2000},prev={...img,at:1000},ctx={party_active:false,previous_visitor_count:null};
  const text=req=>JSON.stringify((req.input||[]).flatMap(i=>i.content||[]).filter(c=>c.type==='input_text').map(c=>c.text));
  const sc=b.sceneRequest(img,1,model);
  return {presence:promptHash(b.presenceRequest(img,ctx)),motion:promptHash(b.motionRequest(prev,img,ctx)),costume:promptHash(b.costumeRequest(img,ctx)),
    scene:createHash('sha256').update(text(sc)+JSON.stringify(sc.text?.format?.schema||null)).digest('hex')};
}

// Pick positions (every Nth saved frame, up to --limit); motion partner snaps to the previous saved frame nearest (at - spacing).
export function planFrames(frames,{every=1,limit=Infinity,spacingMs=2000}={}){
  const sorted=[...frames].sort((a,b)=>a.at-b.at||a.index-b.index),out=[];
  for(let i=0;i<sorted.length&&out.length<limit;i+=every){
    const f=sorted[i];let prev=null,best=Infinity;
    // Snap to a SAVED frame: the earlier saved frame whose gap is closest to the requested spacing (saved frames are >= the capture interval apart).
    for(let j=i-1;j>=0;j--){const gap=f.at-sorted[j].at,d=Math.abs(gap-spacingMs);if(d<best){best=d;prev=sorted[j];}if(gap>spacingMs*2+2000)break;}
    const gap=prev?f.at-prev.at:0;
    out.push({frame:f,prev:prev&&gap>=spacingMs/2&&gap<=spacingMs*2+500?prev:null});
  }
  return out;
}
export function planCalls(plans,judges){
  const calls={presence:0,motion:0,costume:0,scene:0};
  for(const {positions} of plans)for(const p of positions){
    if(judges.includes('presence'))calls.presence++;
    if(judges.includes('motion')&&p.prev)calls.motion++;
    if(judges.includes('costume'))calls.costume++;
    if(judges.includes('scene'))calls.scene++;
  }
  return {...calls,total:calls.presence+calls.motion+calls.costume+calls.scene};
}
export function estimateCostUsd(calls,model='gpt-6-luna'){
  let usd=0;for(const j of ALL_JUDGES){const t=ESTIMATE_TOKENS[j],c=tokenCostUsd(model,{input:t.input*(calls[j]||0),output:t.output*(calls[j]||0)});if(c==null)return null;usd+=c;}
  return usd;
}

// Downscale a stored JPEG to `width` px with ffmpeg (never upscales; 'native' returns the stored bytes untouched).
export function resizeJpeg(bytes,width,{ffmpegPath='ffmpeg',spawnImpl=spawn}={}){
  const size=jpegSize(bytes);
  if(width==='native'||!size||size.width<=width)return Promise.resolve(bytes);
  return new Promise((resolveP,reject)=>{
    const child=spawnImpl(ffmpegPath,['-hide_banner','-loglevel','error','-nostdin','-f','image2pipe','-c:v','mjpeg','-i','pipe:0','-vf','scale='+width+':-2','-q:v','3','-f','image2pipe','-c:v','mjpeg','pipe:1'],{stdio:['pipe','pipe','ignore']});
    const chunks=[];child.stdout.on('data',c=>chunks.push(c));
    child.on('error',()=>reject(new Error('Cannot run ffmpeg to resize frames. Install ffmpeg or set FFMPEG_PATH.')));
    child.on('close',code=>{const out=Buffer.concat(chunks);if(code!==0||out.length<4)reject(new Error('ffmpeg resize failed'));else resolveP(out);});
    child.stdin.on('error',()=>{});child.stdin.end(bytes);
  });
}
// Set the input_image `detail` field on every image of a request (leaves the request untouched when detail is null).
export function applyDetail(req,detail){
  if(!detail)return req;
  return {...req,input:(req.input||[]).map(item=>({...item,content:(item.content||[]).map(c=>c.type==='input_image'?{...c,detail}:c)}))};
}
const gitCommit=()=>{try{return execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:2000}).trim();}catch{return null;}};
const slim=answers=>(answers||[]).filter(a=>a&&a.name).map(({name,choice,confidence})=>({name,choice:choice===undefined?null:String(choice),confidence:Number.isFinite(confidence)?confidence:null}));
const privDir=async d=>{await mkdir(d,{recursive:true,mode:0o700});await chmod(d,0o700).catch(()=>{});};
async function pool(items,n,fn){let i=0;const workers=Array.from({length:Math.min(n,items.length)},async()=>{while(i<items.length){const item=items[i++];await fn(item);}});await Promise.all(workers);}
const readLines=async f=>{let t='';try{t=await readFile(f,'utf8');}catch{return [];}return t.split('\n').filter(l=>l.trim()).map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(Boolean);};

export async function main(argv,{env=process.env,fetchImpl=fetch,log=console.log,now=Date.now}={}){
  const opts=parseArgs(argv);
  const store=createCaptureStore({dir:opts.dir,enabled:()=>false});
  const clipsAll=filterClips((await store.list({limit:100000})).clips,opts.clips);
  if(opts.compare)return compareMain(opts,store,clipsAll,{log});
  if(!clipsAll.length){log('No clips found in '+opts.dir);return {clips:0,calls:0};}
  const builders=await loadBuilders(opts.promptFile);
  const plans=[];
  for(const c of clipsAll){const found=await store.findClip(c.clip_id);plans.push({clip:c,path:found.path,positions:planFrames(await store.frameFiles(found.path),opts)});}
  const calls=planCalls(plans,opts.judges),usd=estimateCostUsd(calls,opts.model||'gpt-6-luna');
  log(`Plan: ${clipsAll.length} clip(s), judges ${opts.judges.join(',')}, spacing ${opts.spacingMs} ms, every ${opts.every}, width ${opts.width}, detail ${opts.detail||'default'}.`);
  log(`Calls: ${calls.total} (presence ${calls.presence}, motion ${calls.motion}, costume ${calls.costume}, scene ${calls.scene}). Estimated cost: ${usd==null?'unknown':'$'+usd.toFixed(4)} (token assumptions in ESTIMATE_TOKENS; scene is an upper bound).`);
  if(!opts.yes){log('Re-run with --yes to proceed. Nothing was sent.');return {clips:clipsAll.length,calls:calls.total,estimated_usd:usd,gated:true};}
  if(!env.OPENAI_API_KEY)throw new Error('Set OPENAI_API_KEY (environment or .env) to replay.');
  const hashes=promptHashes(builders,opts.model),startedAt=new Date(now()).toISOString();
  const runId=startedAt.slice(0,19).replace(/[-:T]/g,'').replace(/^(\d{8})(\d{6})$/,'$1-$2')+'-'+(opts.label||createHash('sha256').update(JSON.stringify(hashes)).digest('hex').slice(0,8));
  const commit=gitCommit(),summary={runId,clips:[],calls:0,usd:0,errors:0};
  for(const plan of plans){
    const dir=join(plan.path,'replays',runId);await privDir(join(plan.path,'replays'));
    await mkdir(dir,{mode:0o700}); // exclusive: never overwrite an earlier run
    await chmod(dir,0o700).catch(()=>{});
    const resultsFile=join(dir,'results.jsonl');await writeFile(resultsFile,'',{mode:0o600});
    const frames=await store.frameFiles(plan.path);void frames;
    const resolver=labelResolver(await readLines(join(plan.path,'labels.jsonl')));
    const live=await readLines(join(plan.path,'judge.jsonl'));
    const liveCount=at=>{const l=live.find(x=>x.judge==='presence'&&x.frame_ats?.[0]===at);const n=l?.parsed?.visitor_count;return Number.isFinite(n)?n:null;};
    const stat={calls:0,input_tokens:0,output_tokens:0,usd:0,errors:0};
    const imgCache=new Map();let sourceRes=null,sentRes=null;
    const getImage=frame=>{
      if(!imgCache.has(frame.index))imgCache.set(frame.index,(async()=>{
        const raw=await store.frame(plan.clip.clip_id,frame.index);if(!raw)return null;
        const out=await resizeJpeg(raw,opts.width,{ffmpegPath:opts.ffmpegPath});
        sourceRes??=jpegSize(raw);sentRes??=jpegSize(out);return {bytes:out,at:frame.at};})());
      return imgCache.get(frame.index);
    };
    const call=async(judge,req,frame,prev,parse)=>{
      const started=Date.now();let rec={at:frame.at,frame_index:frame.index,judge,prev_frame_index:prev?.index??null,spacing_ms:prev?frame.at-prev.at:null};
      try{
        const res=await fetchImpl('https://api.openai.com/v1/'+(judge==='scene'?'responses':'decisions'),{method:'POST',headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(applyDetail(opts.model?{...req,model:opts.model}:req,opts.detail)),signal:AbortSignal.timeout(60000)});
        if(!res.ok)throw Object.assign(new Error('HTTP '+res.status),{code:'HTTP_'+res.status});
        const result=await res.json(),tok=usageTokens(result.usage||{}),usd=tokenCostUsd(req.model,tok)??0;
        stat.calls++;stat.input_tokens+=tok.input;stat.output_tokens+=tok.output;stat.usd+=usd;
        let parsed=null,perr=null;
        if(judge==='scene'){try{parsed=JSON.parse(result.output?.flatMap(i=>i.content||[]).filter(c=>c.type==='output_text').map(c=>c.text).join('')||result.output_text||'');}catch(e){perr=e;}}
        else if(parse){try{parsed=parse(result);}catch(e){perr=e;}}
        rec={...rec,answers:slim(result.answers),parsed,parse_error:perr?{code:perr.code||'ERROR',message:String(perr.message).slice(0,160)}:null,inference_ms:Date.now()-started,usage:result.usage||null,cost_usd:usd,error:null};
      }catch(e){stat.errors++;rec={...rec,answers:[],parsed:null,inference_ms:Date.now()-started,usage:null,cost_usd:0,error:{code:e.code||'ERROR',message:String(e.message).slice(0,160)}};}
      await appendFile(resultsFile,JSON.stringify(rec)+'\n',{mode:0o600});
      return rec;
    };
    await pool(plan.positions,3,async({frame,prev})=>{
      const image=await getImage(frame);if(!image)return;
      const ctx={party_active:false,previous_visitor_count:null};
      let count=null;
      if(opts.judges.includes('presence')){const r=await call('presence',builders.presenceRequest(image,ctx),frame,null,builders.parsePresence);count=r.parsed?.visitor_count??null;}
      if(count==null){const lab=resolver(frame.index).real_people_count;count=lab!=null?(lab==='11_plus'?11:Number(lab)):liveCount(frame.at);}
      const jobs=[];
      if(opts.judges.includes('motion')&&prev&&count!==0){const pimg=await getImage(prev);if(pimg)jobs.push(call('motion',builders.motionRequest(pimg,image,ctx),frame,prev,r=>builders.parseMotion(r,Math.max(1,count??1))));}
      if(opts.judges.includes('costume')&&count!==0)jobs.push(call('costume',builders.costumeRequest(image,ctx),frame,null,r=>builders.parseCostume(r,Math.max(1,count??1))));
      if(opts.judges.includes('scene')&&count>=1)jobs.push(call('scene',builders.sceneRequest(image,count,opts.model),frame,null,null));
      await Promise.all(jobs);
    });
    const runJson={run_id:runId,clip_id:plan.clip.clip_id,judges:opts.judges,prompt_sha256:Object.fromEntries(opts.judges.map(j=>[j,hashes[j]])),model:opts.model||'gpt-6-luna',spacing_ms:opts.spacingMs,every:opts.every,limit:Number.isFinite(opts.limit)?opts.limit:null,
      width:opts.width,detail:opts.detail,source_resolution:sourceRes,sent_resolution:sentRes,prompt_file:builders.promptFile,git_commit:commit,started_at:startedAt,finished_at:new Date(now()).toISOString(),frames_planned:plan.positions.length,
      cost:{usd:Number(stat.usd.toFixed(6)),calls:stat.calls,errors:stat.errors,input_tokens:stat.input_tokens,output_tokens:stat.output_tokens}};
    await writeFile(join(dir,'run.json'),JSON.stringify(runJson,null,1)+'\n',{mode:0o600});
    summary.clips.push(plan.clip.clip_id);summary.calls+=stat.calls;summary.usd+=stat.usd;summary.errors+=stat.errors;
    log(`${plan.clip.clip_id}: ${stat.calls} calls, $${stat.usd.toFixed(4)}, ${stat.errors} error(s) -> replays/${runId}`);
  }
  log(`Run ${runId}: ${summary.calls} calls, $${summary.usd.toFixed(4)} actual.`);
  return {...summary,run_id:runId,gated:false};
}

// ---------- compare ----------
const CUT=decisions.CUTOFFS||{count:0.75,motion:0.8,face:0.8,location:0.8,costume:0.85};
export const cutoffFor=name=>/^person_\d_motion$/.test(name)?CUT.motion:/^person_\d_face/.test(name)?CUT.face:/^person_\d_location$|^closest_person_location$/.test(name)?CUT.location:/^costume_\d$/.test(name)?CUT.costume:CUT.count;
export const bucketCount=v=>{if(v==null)return null;const s=String(v);if(s==='uncertain')return s;const n=s==='11_plus'?11:s==='4_5'?4.5:s==='6_plus'?6:Number(s);if(!Number.isFinite(n))return s;return n>=6?'6_plus':n>=4?'4_5':String(n);};
const above=a=>a?.confidence!=null&&a.confidence>=cutoffFor(a.name);

// Records -> Map(at -> Map(question -> answer)) plus derived label-comparable fields.
export function indexRecords(records){
  const byAt=new Map();
  for(const r of records){if(r.error||!r.answers)continue;const m=byAt.get(r.at)??new Map();for(const a of r.answers)m.set(a.name,a);byAt.set(r.at,m);}
  return byAt;
}
export function derivedFields(qs){
  const out={};const c=qs.get('real_people_count');if(c)out.real_people_count={value:bucketCount(c.choice),confidence:c.confidence,name:c.name};
  const slots=[1,2,3].map(n=>qs.get(`person_${n}_motion`));
  if(slots.some(Boolean)){for(const k of ['arriving','present','leaving'])out[k+'_count']={value:String(slots.filter(a=>a&&above(a)&&a.choice===k).length),confidence:null,name:null};}
  return out;
}
const labelField=(l,f)=>l[f]==null?null:f==='real_people_count'?bucketCount(l[f]):String(l[f]);
const band=c=>c==null?'n/a':c<0.5?'<0.50':c<0.75?'0.50-0.75':c<0.9?'0.75-0.90':'>=0.90';

export function compareIndexes(A,B,{labelsAt=()=>({})}={}){
  const questions={},disagreements=[],acc={A:{},B:{}},calib={A:{},B:{}};
  for(const [at,qa] of A){
    const qb=B.get(at);if(!qb)continue;
    for(const [name,a] of qa){const b=qb.get(name);if(!b)continue;
      const q=questions[name]??={n:0,same:0,both_above:{n:0,same:0},other:{n:0,same:0}};
      const same=String(a.choice)===String(b.choice);q.n++;if(same)q.same++;
      const side=above(a)&&above(b)?q.both_above:q.other;side.n++;if(same)side.same++;
      if(!same)disagreements.push({at,question:name,a:a.choice,a_conf:a.confidence,b:b.choice,b_conf:b.confidence});}
  }
  for(const [tag,idx] of [['A',A],['B',B]])for(const [at,qs] of idx){
    const lab=labelsAt(at);if(!lab)continue;const d=derivedFields(qs);
    for(const f of ['real_people_count','arriving_count','present_count','leaving_count']){
      const want=labelField(lab,f);if(want==null||!d[f]||d[f].value==='uncertain')continue;
      const s=acc[tag][f]??={n:0,correct:0};s.n++;const ok=d[f].value===want;if(ok)s.correct++;
      if(f==='real_people_count'){const cut=cutoffFor('real_people_count'),cc=calib[tag];const side=(d[f].confidence??0)>=cut?'above':'below';
        const row=cc[side]??={n:0,correct:0};row.n++;if(ok)row.correct++;const bn=band(d[f].confidence),br=(cc.bands??={})[bn]??={n:0,correct:0};br.n++;if(ok)br.correct++;}
    }
  }
  disagreements.sort((x,y)=>x.at-y.at);
  return {questions,disagreements,accuracy:acc,calibration:calib};
}
const pct=(c,n)=>n?`${(100*c/n).toFixed(1)}% (${c}/${n})`:'n/a';
export function formatCompare(nameA,nameB,r,{title='Replay comparison',metaA=null,metaB=null}={}){
  const desc=m=>m?` (width ${m.width??'?'}, detail ${m.detail||'default'}, spacing ${m.spacing_ms??'?'} ms, prompts ${Object.values(m.prompt_sha256||{}).map(h=>String(h).slice(0,8)).join('/')})`:'';
  const L=[`# ${title}`,'',`A = ${nameA}${desc(metaA)}`,`B = ${nameB}${desc(metaB)}`,'','## Agreement per question (A vs B)','','| question | agree | both above cutoff | otherwise |','|---|---|---|---|'];
  for(const [q,v] of Object.entries(r.questions).sort())L.push(`| ${q} | ${pct(v.same,v.n)} | ${pct(v.both_above.same,v.both_above.n)} | ${pct(v.other.same,v.other.n)} |`);
  L.push('','## Accuracy against labels','');
  for(const tag of ['A','B']){L.push(`### ${tag==='A'?nameA:nameB}`,'');const f=Object.entries(r.accuracy[tag]);if(!f.length)L.push('No labeled frames.');for(const [k,v] of f)L.push(`- ${k}: ${pct(v.correct,v.n)}`);L.push('');}
  L.push('## Confidence calibration (real_people_count; cutoff '+CUT.count+')','');
  for(const tag of ['A','B']){const c=r.calibration[tag];L.push(`### ${tag==='A'?nameA:nameB}`,'');
    L.push(`- at/above cutoff: ${pct(c.above?.correct||0,c.above?.n||0)}; below: ${pct(c.below?.correct||0,c.below?.n||0)}`);
    for(const [b,v] of Object.entries(c.bands||{}).sort())L.push(`- confidence ${b}: ${pct(v.correct,v.n)}`);L.push('');}
  L.push('## Frames where A and B disagree','');
  if(!r.disagreements.length)L.push('None.');
  for(const d of r.disagreements)L.push(`- t=${d.at} ${d.question}: A ${d.a} (${d.a_conf??'?'}) vs B ${d.b} (${d.b_conf??'?'})`);
  return L.join('\n')+'\n';
}
async function loadRunRecords(clipPath,name){
  if(name==='live'){const out=[];for(const l of await readLines(join(clipPath,'judge.jsonl')))if(!l.error&&l.answers)out.push({at:l.frame_ats?.[0],judge:l.judge,answers:l.answers});return out.filter(r=>Number.isFinite(r.at));}
  if(!validClipId(name))throw new Error('Invalid run id: '+name);
  let dirs=[];try{dirs=await readdir(join(clipPath,'replays'));}catch{}
  const match=dirs.includes(name)?name:dirs.filter(d=>!d.endsWith('.md')&&(d.startsWith(name)||d.endsWith('-'+name))).sort().at(-1);
  if(!match)return null;
  return readLines(join(clipPath,'replays',match,'results.jsonl'));
}
async function loadRunMeta(clipPath,name){
  if(name==='live'||!validClipId(name))return null;
  let dirs=[];try{dirs=await readdir(join(clipPath,'replays'));}catch{}
  const match=dirs.includes(name)?name:dirs.filter(d=>!d.endsWith('.md')&&(d.startsWith(name)||d.endsWith('-'+name))).sort().at(-1);
  if(!match)return null;
  try{return JSON.parse(await readFile(join(clipPath,'replays',match,'run.json'),'utf8'));}catch{return null;}
}
async function compareMain(opts,store,clips,{log}){
  const [nameA,nameB]=opts.compare;const total={questions:{},disagreements:[],accuracy:{A:{},B:{}},calibration:{A:{},B:{}}};let used=0,metaA=null,metaB=null;
  const merge=(into,from)=>{for(const [q,v] of Object.entries(from.questions)){const t=into.questions[q]??={n:0,same:0,both_above:{n:0,same:0},other:{n:0,same:0}};t.n+=v.n;t.same+=v.same;for(const k of ['both_above','other']){t[k].n+=v[k].n;t[k].same+=v[k].same;}}
    into.disagreements.push(...from.disagreements.map(d=>({...d,clip:from.clip})));
    for(const tag of ['A','B']){for(const [f,v] of Object.entries(from.accuracy[tag])){const t=into.accuracy[tag][f]??={n:0,correct:0};t.n+=v.n;t.correct+=v.correct;}
      for(const k of ['above','below']){const v=from.calibration[tag][k];if(v){const t=into.calibration[tag][k]??={n:0,correct:0};t.n+=v.n;t.correct+=v.correct;}}
      for(const [b,v] of Object.entries(from.calibration[tag].bands||{})){const t=((into.calibration[tag].bands)??={})[b]??={n:0,correct:0};t.n+=v.n;t.correct+=v.correct;}}};
  for(const c of clips){
    const found=await store.findClip(c.clip_id);const ra=await loadRunRecords(found.path,nameA),rb=await loadRunRecords(found.path,nameB);
    if(!ra||!rb)continue;used++;const ma=await loadRunMeta(found.path,nameA),mb=await loadRunMeta(found.path,nameB);metaA??=ma;metaB??=mb;
    const frames=await store.frameFiles(found.path),atToIndex=new Map(frames.map(f=>[f.at,f.index]));
    const resolver=labelResolver(await readLines(join(found.path,'labels.jsonl')));
    const labelsAt=at=>{const i=atToIndex.get(at);return i==null?null:resolver(i);};
    const r=compareIndexes(indexRecords(ra),indexRecords(rb),{labelsAt});r.clip=c.clip_id;merge(total,r);
    const report=formatCompare(nameA,nameB,r,{title:'Replay comparison: '+c.clip_id,metaA:ma,metaB:mb});
    await privDir(join(found.path,'replays'));const f=join(found.path,'replays',`compare-${nameA}__${nameB}.md`);await writeFile(f,report,{mode:0o600});
  }
  if(!used){log('No clip has both runs ('+nameA+', '+nameB+').');return {clips:0};}
  const report=formatCompare(nameA,nameB,total,{title:`Replay comparison over ${used} clip(s)`,metaA,metaB});
  await privDir(opts.dir);const file=join(opts.dir,`compare-${nameA}__${nameB}.md`);await writeFile(file,report,{mode:0o600});
  log(report);log('Report written to '+file+' (and per clip under replays/).');
  return {clips:used,file,result:total};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  loadEnv(resolve(root,'.env'));if(process.env.OPENAI_ENV_FILE)loadEnv(process.env.OPENAI_ENV_FILE);
  main(process.argv.slice(2)).then(r=>{if(r?.gated)process.exitCode=2;}).catch(e=>{console.error(e.message);process.exit(1);});
}
