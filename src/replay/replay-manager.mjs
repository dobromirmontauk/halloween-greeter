// Starts replay runs from the UI. ONE run at a time, in a niced child process (scripts/replay/run.mjs) so the YOLO sidecar and CPU load never share the live server's event loop.
// Refused while the yard is not EMPTY or a visit/conversation is running (canStart returns the reason). Needs the same explicit confirm as the CLI for real backends.
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {requireConfirm,validateSettings,BACKENDS,JUDGE_MODES,DETECTOR_MODES} from './replay-guard.mjs';
import {newRunId} from './replay-store.mjs';
import {validVisitIdLocal} from './replay-ids.mjs';

import {ROOT} from '../lib/paths.mjs';
const root=ROOT;
const fail=(status,message,code)=>Object.assign(new Error(message),{status,code});

export function createReplayManager({visitsDir,env=process.env,canStart=()=>null,spawnImpl=spawn,script=join(root,'scripts','replay','run.mjs'),nodePath=process.execPath,defaultMaxCostUsd=0.5,onChange=()=>{}}={}){
  let cur={state:'idle'},child=null;
  const status=()=>({...cur});
  const busy=()=>cur.state==='running';
  function start(body={}){
    if(!visitsDir)throw fail(503,'Visit clips are not enabled.');
    const clip=String(body.clip||'');
    if(!validVisitIdLocal(clip)||!existsSync(join(visitsDir,clip,'visit.json')))throw fail(404,'Visit not found.');
    const backend=String(body.backend||''),judges=String(body.judges||(backend==='fake'?'fake':'recorded')),detector=String(body.detector||'real');
    if(!BACKENDS.includes(backend))throw fail(400,'backend must be gemini, openai or fake.');
    if(!JUDGE_MODES.includes(judges))throw fail(400,'judges must be real, fake or recorded.');
    if(!DETECTOR_MODES.includes(detector))throw fail(400,'detector must be real or recorded.');
    const confirm=body.confirm===true;
    requireConfirm({backend,judges,confirm});
    const set=validateSettings(body.set||{});
    if(busy())throw fail(409,'A replay is already running.');
    const why=canStart();if(why)throw fail(409,why);
    const costRaw=body.max_cost_usd==null?defaultMaxCostUsd:Number(body.max_cost_usd);
    if(!Number.isFinite(costRaw)||costRaw<0)throw fail(400,'max_cost_usd must be a number.');
    const maxCost=backend==='fake'&&judges!=='real'?0:costRaw;
    const runId=newRunId(backend);
    const args=['-n','10',nodePath,script,'--clip',clip,'--backend',backend,'--judges',judges,'--detector',detector,'--run-id',runId,'--visits-dir',visitsDir,'--json',...(confirm?['--send-recorded-media']:[]),...(maxCost>0?['--max-cost',String(maxCost)]:[]),...Object.entries(set).flatMap(([k,v])=>['--set',`${k}=${v}`])];
    cur={state:'running',clip,run_id:runId,backend,judges,detector,started_at:new Date().toISOString(),progress:null,error:null};
    const proc=spawnImpl('nice',args,{env:{...env},stdio:['ignore','pipe','pipe']});child=proc;
    let buf='',errBuf='';
    proc.stdout?.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);try{const m=JSON.parse(line);if(m.progress)cur={...cur,progress:m.progress};else if(m.done)cur={...cur,summary:m.done};}catch{}}onChange();});
    proc.stderr?.on('data',d=>{errBuf=(errBuf+d).slice(-600);});
    proc.on('error',e=>{if(child===proc){child=null;cur={...cur,state:'error',error:'Could not start the replay: '+String(e.message||e).slice(0,100)};onChange();}});
    proc.on('close',code=>{if(child!==proc)return;child=null;cur=code===0?{...cur,state:'done',progress:cur.progress&&{...cur.progress,t_ms:cur.progress.of_ms}}:{...cur,state:cur.state==='cancelled'?'cancelled':'error',error:cur.state==='cancelled'?null:(errBuf.trim().split('\n').pop()||'Replay failed (exit '+code+').').slice(0,200)};onChange();});
    onChange();
    return status();
  }
  // Kills only our own child.
  function cancel(){if(child&&busy()){cur={...cur,state:'cancelled'};try{child.kill('SIGTERM');}catch{}}return status();}
  return {start,cancel,status,busy,busyWith:id=>busy()&&cur.clip===id};
}
