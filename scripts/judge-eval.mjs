#!/usr/bin/env node
// Score logged Judge reads against ground-truth labels; optionally re-run labeled images through the CURRENT judges (Presence, Motion where a previous frame was logged, Costume).
// Usage: node scripts/judge-eval.mjs [--dir data/judge-log] [--rerun [--yes]] [--limit N]
import {readFile,writeFile,mkdir,chmod} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createJudgeLog,compareEntry,CUTOFFS,LABEL_FIELDS} from '../src/presence/judge-log.mjs';
import {presenceRequest,motionRequest,costumeRequest} from '../src/presence/decisions.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');

export function parseArgs(argv){
 const o={dir:resolve(root,'data','judge-log'),rerun:false,yes:false,limit:Infinity};
 for(let i=0;i<argv.length;i++){const a=argv[i];
  if(a==='--dir')o.dir=resolve(argv[++i]);else if(a==='--rerun')o.rerun=true;else if(a==='--yes')o.yes=true;else if(a==='--limit')o.limit=Math.max(1,Number(argv[++i])||1);
  else throw new Error('Unknown argument: '+a);}
 return o;
}

// items: [{entry,label}] where entry.answers is the answer set being scored.
export function score(items){
 const fields={},wrong=[];
 const bump=(f,c)=>{const s=fields[f]??={n:0,correct:0,above:{n:0,correct:0},below:{n:0,correct:0},confusion:{}};s.n++;if(c.agree)s.correct++;
  const side=c.accepted?s.above:s.below;side.n++;if(c.agree)side.correct++;
  const row=s.confusion[c.label]??={};row[c.judge??'missing']=(row[c.judge??'missing']||0)+1;};
 for(const{entry,label}of items){
  const cmp=compareEntry(entry,label);let bad=false;
  for(const f of LABEL_FIELDS)if(cmp[f]){bump(f,cmp[f]);if(!cmp[f].agree)bad=true;}
  if(cmp.costumes){const s=fields.costumes??={n:0,correct:0};s.n++;if(cmp.costumes.agree)s.correct++;else bad=true;}
  if(bad)wrong.push({read_key:entry.read_key,compare:cmp});
 }
 return {n:items.length,fields,wrong};
}
const pct=(c,n)=>n?(100*c/n).toFixed(1)+'% ('+c+'/'+n+')':'n/a';
export function formatReport(title,s,dir,compareWith=null){
 const L=[`# ${title}`,'',`Labeled reads scored: ${s.n}`,'','## Accuracy per question',''];
 for(const[f,v]of Object.entries(s.fields)){
  const other=compareWith?.fields[f];
  L.push(`- ${f}: ${pct(v.correct,v.n)}${other?`  (previous run: ${pct(other.correct,other.n)})`:''}`);
 }
 L.push('','## Confidence calibration (accuracy at/above vs below cutoff)','');
 for(const[f,v]of Object.entries(s.fields))if(v.above)L.push(`- ${f} (cutoff ${CUTOFFS[f]}): above ${pct(v.above.correct,v.above.n)}, below ${pct(v.below.correct,v.below.n)}`);
 L.push('','## Confusion matrices (rows = label, columns = Judge)','');
 for(const[f,v]of Object.entries(s.fields))if(v.confusion){
  L.push(`### ${f}`,'');const cols=[...new Set(Object.values(v.confusion).flatMap(r=>Object.keys(r)))].sort();
  L.push('| label \\ judge | '+cols.join(' | ')+' |','|'+'---|'.repeat(cols.length+1));
  for(const[lab,row]of Object.entries(v.confusion).sort())L.push(`| ${lab} | `+cols.map(c=>row[c]||0).join(' | ')+' |');
  L.push('');
 }
 L.push('## Wrong reads','');
 if(!s.wrong.length)L.push('None.');
 for(const w of s.wrong){
  const parts=Object.entries(w.compare).filter(([,c])=>!c.agree).map(([f,c])=>`${f}: judge ${Array.isArray(c.judge)?c.judge.join('/')||'none':c.judge} vs label ${Array.isArray(c.label)?c.label.join('/')||'none':c.label}`);
  L.push(`- ${join(dir,w.read_key)}.jpg  ${parts.join('; ')}`);
 }
 return L.join('\n')+'\n';
}

// Which judges a rerun of one labeled entry needs. Presence always; Motion only when the logged previous frame exists
// (legacy entries have none: skipped, not guessed); Costume when the label has costumes.
export async function plan(items,dir){
 const out=[];
 for(const item of items){
  const hasPrev=await readFile(join(dir,item.entry.read_key+'_prev.jpg')).then(()=>true,()=>false);
  const costume=Array.isArray(item.label?.costumes);
  out.push({...item,hasPrev,costume,calls:1+(hasPrev?1:0)+(costume?1:0)});
 }
 return out;
}
export const estimateCalls=planned=>planned.reduce((n,p)=>n+p.calls,0);

export async function rerunItems(planned,{dir,fetchImpl=fetch,key}){
 const out=[],skipped=[];
 const call=async body=>{
  const res=await fetchImpl('https://api.openai.com/v1/decisions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
  if(!res.ok)throw new Error('HTTP '+res.status);
  return (await res.json()).answers||[];
 };
 for(const{entry,label,hasPrev,costume}of planned){
  try{
   const now={bytes:await readFile(join(dir,entry.read_key+'.jpg')),at:entry.captured_at};
   const jobs=[call(presenceRequest(now,{}))];
   if(hasPrev){const prev={bytes:await readFile(join(dir,entry.read_key+'_prev.jpg')),at:entry.prev_captured_at??(entry.captured_at-1000)};jobs.push(call(motionRequest(prev,now,{})));}
   else if(Object.keys(label||{}).some(k=>/^person_\d_motion$/.test(k)&&label[k]!=null))skipped.push({read_key:entry.read_key,why:'Motion skipped: no previous frame logged'});
   if(costume)jobs.push(call(costumeRequest(now,{})));
   const answers=(await Promise.all(jobs)).flat().map(({name,choice,confidence})=>({name,choice,confidence}));
   out.push({entry:{...entry,answers},label});
  }catch(e){console.error(`Rerun failed for ${entry.read_key}: ${e.message}`);}
 }
 return {items:out,skipped};
}

export async function main(argv,{env=process.env,fetchImpl=fetch,log=console.log}={}){
 const opts=parseArgs(argv);
 const store=createJudgeLog({dir:opts.dir});
 let items=(await store.allLabeled()).sort((a,b)=>a.entry.read_key<b.entry.read_key?1:-1).slice(0,opts.limit);
 if(!items.length){log('No labeled reads found in '+opts.dir);return {items:0};}
 const old=score(items);
 let report=formatReport('Judge eval: logged answers',old,opts.dir);
 let rerun=null;
 if(opts.rerun){
  const planned=await plan(items,opts.dir);
  log(`Rerun would make ${estimateCalls(planned)} paid Decisions calls (Presence per entry, Motion where a previous frame was logged, Costume where labeled).`);
  if(!opts.yes){log('Re-run with --yes to proceed. Nothing was sent.');return {items:items.length,gated:true,old};}
  if(!env.OPENAI_API_KEY)throw new Error('Set OPENAI_API_KEY to use --rerun.');
  const {items:fresh,skipped}=await rerunItems(planned,{dir:opts.dir,fetchImpl,key:env.OPENAI_API_KEY});
  rerun=score(fresh);rerun.skipped=skipped;
  report+='\n'+formatReport('Judge eval: CURRENT judges rerun (vs logged in parentheses)',rerun,opts.dir,old);
  if(rerun.skipped.length)report+=`\n${rerun.skipped.length} labeled per-person reads skipped (no previous frame, so Motion could not run):\n`+rerun.skipped.map(x=>`- ${x.read_key}`).join('\n')+'\n';
 }
 log(report);
 await mkdir(opts.dir,{recursive:true,mode:0o700});
 const file=join(opts.dir,`eval-${new Date().toISOString().replace(/:/g,'-')}.md`);
 await writeFile(file,report,{mode:0o600});await chmod(file,0o600).catch(()=>{});
 log('Report written to '+file);
 return {items:items.length,old,rerun,file};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 main(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exit(1);});
}
