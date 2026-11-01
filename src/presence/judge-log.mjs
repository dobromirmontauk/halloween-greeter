// Private Judge read log: images + raw answers for ground-truth labeling. NEVER commit this directory (real camera images).
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile,readdir,rm,appendFile,chmod} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {topChoices} from './decisions.mjs';
import {latestAiLabels} from './ai-labels.mjs';

export const CUTOFFS={real_people_count:0.75,person_1_motion:0.8,person_2_motion:0.8,person_3_motion:0.8,person_1_location:0.8,person_2_location:0.8,person_3_location:0.8,closest_person_location:0.8,arriving_count:0.8,present_count:0.8,leaving_count:0.8,costume_1:0.85,costume_2:0.85,costume_3:0.85};
// Legacy single-judge fields (arriving/present/leaving counts) stay labelable so old entries remain comparable.
export const PERSON_FIELDS=['person_1_motion','person_2_motion','person_3_motion'];
export const LOCATION_FIELDS=['person_1_location','person_2_location','person_3_location'];
export const LOCATION_VALUES=['sidewalk','path','porch','not_visible','uncertain'];
export const CLOSEST_LOCATION_VALUES=['sidewalk','path','porch','none','uncertain'];
export const MOTION_VALUES=['arriving','present','leaving','not_visible','uncertain'];
export const LABEL_FIELDS=['real_people_count','closest_person_location',...PERSON_FIELDS,...LOCATION_FIELDS,'arriving_count','present_count','leaving_count'];
export const COUNT_VALUES=['0','1','2','3','4_5','6_plus','4','5','6','7','8','9','10','11_plus'];
// Presence reports 0,1,2,3,4_5,6_plus; legacy entries and labels use exact numbers. Compare in buckets.
export const countBucket=v=>{if(v==null)return null;const t=String(v);if(t==='4_5'||t==='6_plus'||t==='uncertain')return t;if(t==='11_plus')return '6_plus';const n=Number(t);if(!Number.isInteger(n)||n<0)return t;return n<=3?t:n<=5?'4_5':'6_plus';};
export const BUCKET_VALUES=['0','1','2','3','4','5','6_plus'];
const NEUTRAL=new Set(['uncertain','not_visible','none']);
const KEY_RE=/^\d{4}-\d{2}-\d{2}\/[A-Za-z0-9_.-]+$/;
export const validKey=key=>typeof key==='string'&&KEY_RE.test(key)&&!key.includes('..');

export const promptHash=request=>{
 const text=(request?.input||[]).flatMap(i=>i.content||[]).filter(c=>c.type==='input_text').map(c=>c.text).join('\n');
 return createHash('sha256').update(JSON.stringify({text,questions:request?.questions||[]})).digest('hex');
};
const countOf=answers=>(answers||[]).find(x=>x.name==='real_people_count')?.choice;
// Why a read must be logged, or null (confident empty; sampled separately).
export function shouldLog({answers,error}){
 const c=countOf(answers);
 if(error?.code==='UNCERTAIN_PEOPLE_COUNT')return 'uncertain';
 if(c==='uncertain'||c===undefined)return error?'uncertain':null;
 return c!=='0'?'people':null;
}
const safeTs=ms=>new Date(ms).toISOString().replace(/:/g,'-');

// Per-field comparison of a logged entry against a label (null label field = not labeled, skipped).
export function compareEntry(entry,label){
 const ans=name=>(entry.answers||[]).find(a=>a.name===name);
 const out={};
 for(const f of LABEL_FIELDS){
  if(!label||label[f]==null)continue;
  const a=ans(f);
  if(f!=='real_people_count'&&!a)continue; // legacy entries lack per-person answers; new entries lack the old bucket counts
  const norm=f==='real_people_count'?countBucket:x=>x;
  out[f]={judge:a?.choice??null,label:String(label[f]),agree:norm(a?.choice)===norm(String(label[f])),confidence:a?.confidence??null,accepted:Number.isFinite(a?.confidence)&&a.confidence>=CUTOFFS[f]};
 }
 if(Array.isArray(label?.costumes)){
  const judge=[1,2,3].map(i=>ans('costume_'+i)).filter(a=>a&&!NEUTRAL.has(a.choice)).map(a=>a.choice);
  const want=label.costumes.filter(c=>!NEUTRAL.has(c));
  out.costumes={judge,label:want,agree:[...new Set(judge)].sort().join()===[...new Set(want)].sort().join()};
 }
 return out;
}
export const disagrees=cmp=>Object.values(cmp).some(c=>!c.agree);

const bad=message=>Object.assign(new Error(message),{status:400});
export function sanitizeLabel(body,{now=Date.now}={}){
 if(!validKey(body?.read_key))throw bad('Invalid read.');
 const pick=(v,allowed)=>{if(v==null||v==='')return null;if(!allowed.includes(String(v)))throw bad('Invalid value.');return String(v);};
 let costumes=null;
 if(body.costumes!=null){if(!Array.isArray(body.costumes))throw bad('Invalid costumes.');costumes=body.costumes.slice(0,3).map(c=>String(c).slice(0,40).replace(/[^a-z0-9_ -]/gi,'')).filter(Boolean);}
 return {read_key:body.read_key,labeled_at:new Date(now()).toISOString(),labeler:String(body.labeler||'').slice(0,40)||null,
  people_present:pick(body.people_present,['yes','no','unsure']),real_people_count:pick(body.real_people_count,COUNT_VALUES),...Object.fromEntries(PERSON_FIELDS.map(f=>[f,pick(body[f],MOTION_VALUES)])),...Object.fromEntries(LOCATION_FIELDS.map(f=>[f,pick(body[f],LOCATION_VALUES)])),closest_person_location:pick(body.closest_person_location,CLOSEST_LOCATION_VALUES),arriving_count:pick(body.arriving_count,BUCKET_VALUES),present_count:pick(body.present_count,BUCKET_VALUES),leaving_count:pick(body.leaving_count,BUCKET_VALUES),
  costumes,notes:body.notes==null?null:String(body.notes).slice(0,500),...(body.cleared===true?{cleared:true}:{})};
}

export function createJudgeLog({dir,enabled=true,maxEntries=5000,sampleEmptyMs=60000,detectorEveryMs=2000,now=Date.now,model=null,commit=null}={}) {
 const root=dir?resolve(dir):null,on=enabled&&!!root;
 let chain=Promise.resolve(),error=null,logged=0,lastEmptySample=-Infinity,lastDetectorLog=-Infinity,last=null;
 const queue=fn=>{chain=chain.then(fn).catch(e=>{error='Judge log write failed: '+(e.code||e.message||'error');});return chain;};
 const ensure=async d=>{await mkdir(d,{recursive:true,mode:0o700});await chmod(d,0o700).catch(()=>{});};
 async function listKeys(){
  let days;try{days=(await readdir(root)).filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d)).sort();}catch{return [];}
  const keys=[];
  for(const d of days)for(const f of(await readdir(join(root,d))).filter(f=>f.endsWith('.json')).sort())keys.push(d+'/'+f.slice(0,-5));
  return keys; // oldest first
 }
 async function prune(){
  if(!on)return 0;
  const keys=await listKeys(),extra=keys.length-maxEntries;
  if(extra<=0)return 0;
  for(const k of keys.slice(0,extra)){await rm(join(root,k+'.json'),{force:true});await rm(join(root,k+'.jpg'),{force:true});await rm(join(root,k+'_prev.jpg'),{force:true});}
  return extra;
 }
 const labelsFile=()=>join(root,'labels.jsonl');
 async function labels(){
  const map=new Map();let text='';
  try{text=await readFile(labelsFile(),'utf8');}catch{return map;}
  for(const line of text.split('\n')){if(!line.trim())continue;try{const l=JSON.parse(line);if(validKey(l.read_key)){if(l.cleared)map.delete(l.read_key);else map.set(l.read_key,l);}}catch{}}
  return map;
 }
 const readEntry=async key=>JSON.parse(await readFile(join(root,key+'.json'),'utf8'));
 return {
  enabled:on,dir:root,
  // Fire-and-forget: never throws, never blocks the Judge loop.
  // New shape: `judges` = {presence|motion|costume: {request,result,inference_ms,error}} plus `prev_image` for Motion.
  // Legacy shape (single result/request) still works.
  record({image,prev_image=null,judges=null,detector=null,presence_source=null,detector_count=null,result,decision=null,error:readError=null,request=null,inference_ms=null,decided_at=now()}){
   try{
    if(!on||!image?.bytes)return;
    const slim=r=>(r?.answers||[]).map(a=>({name:a.name,choice:a.choice,confidence:a.confidence,top:topChoices(a)}));
    let judgeEntries=null,answers;
    if(judges){
     judgeEntries={};answers=[];
     for(const name of ['presence','motion','costume']){const j=judges[name];if(!j){judgeEntries[name]={ran:false};continue;}
      if(j.skipped){judgeEntries[name]={ran:false,skipped:j.skipped};continue;}
      const a=slim(j.result);answers.push(...a);
      judgeEntries[name]={ran:true,prompt_sha256:j.request?promptHash(j.request):null,inference_ms:j.inference_ms??null,answers:a,error:j.error?{code:j.error.code||'ERROR',message:String(j.error.message||'').slice(0,200)}:null};}
     result=judges.presence?.result;request=judges.presence?.request??request;inference_ms=judges.presence?.inference_ms??inference_ms;
    }else answers=slim(result);
    let why=shouldLog({answers,error:readError});
    if(!why&&judgeEntries&&Object.values(judgeEntries).some(j=>j.error))why='judge_error';
    if(presence_source==='detector'){ // detector-only presence read: logged only while people are present (never empty frames), at most every detectorEveryMs unless a paid judge also ran
     if(!why)return;
     const paid=Boolean(judgeEntries?.motion?.ran||judgeEntries?.costume?.ran);
     if(!paid&&decided_at-lastDetectorLog<detectorEveryMs)return;
     lastDetectorLog=decided_at;
    }
    if(!why){if(decided_at-lastEmptySample<sampleEmptyMs)return;lastEmptySample=decided_at;why='empty_sample';}
    const read_id=String(result?._query_id||randomUUID()).replace(/[^A-Za-z0-9_-]/g,'').slice(0,40),captured_at=image.at??decided_at,date=new Date(captured_at).toISOString().slice(0,10),key=date+'/'+safeTs(captured_at)+'_'+read_id;
    const entry={read_key:key,read_id,date,reason:why,captured_at,decided_at,inference_ms,model:request?.model||model,deployment_commit:commit,prompt_sha256:request?promptHash(request):null,...(judgeEntries?{version:2,judges:judgeEntries,has_prev:!!(prev_image?.bytes&&judgeEntries.motion?.ran),prev_captured_at:prev_image?.at??null}:{}),detector,presence_source,detector_count,answers,parsed:decision?{...decision,audit:undefined}:null,error:readError?{code:readError.code||'ERROR',message:String(readError.message||'').slice(0,200)}:null,events:[]};
    const base=join(root,key),bytes=Buffer.from(image.bytes),prevBytes=entry.has_prev?Buffer.from(prev_image.bytes):null;
    last={entry,base};
    queue(async()=>{
     await ensure(root);await ensure(join(root,date));
     await writeFile(base+'.jpg',bytes,{mode:0o600});
     if(prevBytes)await writeFile(base+'_prev.jpg',prevBytes,{mode:0o600});
     await writeFile(base+'.json',JSON.stringify(entry,null,1),{mode:0o600});
     logged++;await prune();
    });
   }catch(e){error='Judge log failed: '+(e.message||'error');}
  },
  // Attach an emitted Judge event to the most recently logged read.
  noteEvent(event){
   try{
    if(!on||!last)return;
    const target=last;target.entry.events.push({id:event.id,type:event.type,at:event.at,phrase:event.phrase});
    queue(()=>writeFile(target.base+'.json',JSON.stringify(target.entry,null,1),{mode:0o600}));
   }catch{}
  },
  flush:()=>chain,
  prune:()=>chain.then(prune),
  status:()=>({enabled:on,logged,max_entries:maxEntries,error}),
  async addLabel(body){
   if(!on)throw Object.assign(new Error('Judge log is disabled.'),{status:409});
   const label=sanitizeLabel(body,{now});
   try{await readEntry(label.read_key);}catch{throw Object.assign(new Error('Read not found.'),{status:404});}
   await queue(async()=>{await ensure(root);await appendFile(labelsFile(),JSON.stringify(label)+'\n',{mode:0o600});await chmod(labelsFile(),0o600).catch(()=>{});});
   return label;
  },
  labels,
  // AI labels (ai_labels.jsonl): never mixed with human labels. Latest per key per labeler wins.
  async aiLabels(){
   let text='';try{text=await readFile(join(root,'ai_labels.jsonl'),'utf8');}catch{return new Map();}
   const lines=[];for(const l of text.split('\n')){if(!l.trim())continue;try{lines.push(JSON.parse(l));}catch{}}
   return latestAiLabels(lines);
  },
  async addAiLabels(records){
   if(!on)throw Object.assign(new Error('Judge log is disabled.'),{status:409});
   if(!records.length)return 0;
   const file=join(root,'ai_labels.jsonl');
   await queue(async()=>{await ensure(root);await appendFile(file,records.map(r=>JSON.stringify(r)).join('\n')+'\n',{mode:0o600});await chmod(file,0o600).catch(()=>{});});
   return records.length;
  },
  async hasEntry(key){try{await readEntry(key);return true;}catch{return false;}},
  keys:listKeys,entry:readEntry,
  async get(key){if(!on||!validKey(key))return null;try{return {...await readEntry(key),label:(await labels()).get(key)||null};}catch{return null;}},
  async image(key,{prev=false}={}){if(!on||!validKey(key))return null;try{return await readFile(join(root,key+(prev?'_prev.jpg':'.jpg')));}catch{return null;}},
  async list({offset=0,limit=20,filter='all',date=null}={}){
   if(!on)return {total:0,items:[]};
   let keys=(await listKeys()).reverse();
   if(date)keys=keys.filter(k=>k.startsWith(date+'/'));
   const lab=await labels();
   const view=async k=>{const entry=await readEntry(k),label=lab.get(k)||null,compare=label?compareEntry(entry,label):null;return {...entry,label,compare,disagree:compare?disagrees(compare):false};};
   if(filter==='all'){const items=[];for(const k of keys.slice(offset,offset+limit)){try{items.push(await view(k));}catch{}}return {total:keys.length,items};}
   const out=[];
   for(const k of keys){try{const v=await view(k);
    if(filter==='unlabeled'&&v.label)continue;
    if(filter==='disagreements'&&!v.disagree)continue;
    if(filter==='uncertain'&&v.reason!=='uncertain')continue;
    out.push(v);}catch{}}
   return {total:out.length,items:out.slice(offset,offset+limit)};
  },
  async allLabeled(){const out=[];for(const[k,label]of await labels()){try{out.push({entry:await readEntry(k),label});}catch{}}return out;}
 };
}

export const logConfig=(env,root)=>({enabled:env.JUDGE_LOG!=='false',dir:env.JUDGE_LOG_DIR?resolve(env.JUDGE_LOG_DIR):resolve(root,'data','judge-log'),maxEntries:Math.max(1,Number(env.JUDGE_LOG_MAX_ENTRIES)||5000),detectorEveryMs:env.JUDGE_LOG_DETECTOR_MS===undefined||env.JUDGE_LOG_DETECTOR_MS===''?2000:Math.max(0,Number(env.JUDGE_LOG_DETECTOR_MS)||0)});
