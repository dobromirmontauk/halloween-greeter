// Replay runs live INSIDE the clip they replay: data/visits/<id>/runs/<runId>/{run.json,assistant.wav}. They are counted by the recorder's size accounting (VISIT_MAX_GB), pruned and deleted with the clip.
import {mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,chmodSync,renameSync,rmSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';

export const RUN_ID_RE=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const validRunId=id=>typeof id==='string'&&RUN_ID_RE.test(id);
const pad=(n,w=2)=>String(n).padStart(w,'0');
export const newRunId=(backend='run',ms=Date.now())=>{const d=new Date(ms);return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(backend).replace(/[^a-z0-9]/gi,'').slice(0,12)||'run'}-${randomBytes(2).toString('hex')}`;};
export const runsDir=clipDir=>join(clipDir,'runs');
export const runDir=(clipDir,runId)=>join(runsDir(clipDir),runId);
const secure=(p,mode)=>{try{chmodSync(p,mode);}catch{}};
export function ensureRunDir(clipDir,runId){
  const rd=runsDir(clipDir),d=runDir(clipDir,runId);
  mkdirSync(d,{recursive:true,mode:0o700});secure(rd,0o700);secure(d,0o700);return d;
}
export function writeRunJson(dir,run){
  const tmp=join(dir,'run.json.tmp'),file=join(dir,'run.json');
  writeFileSync(tmp,JSON.stringify(run),{mode:0o600});secure(tmp,0o600);renameSync(tmp,file);
}
export function readRun(clipDir,runId){
  if(!validRunId(runId))return null;
  try{return JSON.parse(readFileSync(join(runDir(clipDir,runId),'run.json'),'utf8'));}catch{return null;}
}
export const runAudioPath=(clipDir,runId)=>{if(!validRunId(runId))return null;const p=join(runDir(clipDir,runId),'assistant.wav');return existsSync(p)?p:null;};
// Summaries, newest first.
export function listRuns(clipDir){
  let names=[];try{names=readdirSync(runsDir(clipDir),{withFileTypes:true}).filter(e=>e.isDirectory()&&validRunId(e.name)).map(e=>e.name);}catch{return [];}
  return names.sort().reverse().map(id=>{
    const r=readRun(clipDir,id);if(!r)return null;
    return {id,backend:r.backend,model:r.model,judges:r.judges,started_at:r.started_at,state:r.state||'done',duration_ms:r.duration_ms,metrics:r.metrics||null,cost_usd:r.cost_usd??null,aborted:r.aborted||null,errors:(r.errors||[]).length,audio:Boolean(runAudioPath(clipDir,id))};
  }).filter(Boolean);
}
export function removeRun(clipDir,runId){if(!validRunId(runId))return false;const d=runDir(clipDir,runId);if(!existsSync(d))return false;rmSync(d,{recursive:true,force:true});return true;}
export const scorecardDir=(env={},root)=>env.REPLAY_DIR?resolve(env.REPLAY_DIR,'scorecards'):resolve(root,'data','replay','scorecards');
export function writeScorecard(dir,card,ts=new Date()){
  mkdirSync(dir,{recursive:true,mode:0o700});secure(dir,0o700);
  const name=ts.toISOString().replace(/[:.]/g,'-')+'.json',file=join(dir,name);
  writeFileSync(file,JSON.stringify(card,null,1),{mode:0o600});secure(file,0o600);return {name,file};
}
export function listScorecards(dir){
  let names=[];try{names=readdirSync(dir).filter(n=>/^[\w.-]+\.json$/.test(n));}catch{return [];}
  return names.sort().reverse().slice(0,100).map(name=>{try{const c=JSON.parse(readFileSync(join(dir,name),'utf8'));return {name,generated_at:c.generated_at,backend:c.backend,runs:c.runs?.length||0,total_cost_usd:c.total_cost_usd,stopped_reason:c.stopped_reason||null,aggregate:c.aggregate};}catch{return null;}}).filter(Boolean);
}
export const readScorecard=(dir,name)=>{if(!/^[\w.-]+\.json$/.test(name))return null;try{return JSON.parse(readFileSync(join(dir,name),'utf8'));}catch{return null;}};
export const dirBytes=p=>{let t=0;try{for(const e of readdirSync(p,{withFileTypes:true})){const q=join(p,e.name);t+=e.isDirectory()?dirBytes(q):statSync(q).size;}}catch{}return t;};
