// Bulk replay: sequential runs over many clips with a hard cost cap, and a scorecard (printed and saved to data/replay/scorecards/<ts>.json).
import {readdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {runReplay} from './replay-run.mjs';
import {requireConfirm,validateSettings} from './replay-guard.mjs';
import {aggregate} from './replay-score.mjs';
import {writeScorecard} from './replay-store.mjs';
import {VISIT_ID_RE} from '../visits/visit-recorder.mjs';

// clips: 'all' | number (n latest) | 'id1,id2' | array. Only clips with a video, newest first.
export function pickClips(visitsDir,spec='all'){
  let ids=[];try{ids=readdirSync(visitsDir).filter(n=>VISIT_ID_RE.test(n)&&existsSync(join(visitsDir,n,'video.mp4'))).sort().reverse();}catch{}
  if(Array.isArray(spec))return spec.filter(id=>ids.includes(id));
  const s=String(spec).trim();
  if(s===''||s==='all')return ids;
  if(/^\d+$/.test(s))return ids.slice(0,Math.max(0,Number(s)));
  return s.split(',').map(x=>x.trim()).filter(id=>ids.includes(id));
}

export async function runBulk({visitsDir,clips='all',backend,judges,detector,set={},confirm=false,maxCostUsd,env=process.env,scorecardDir=null,runImpl=runReplay,log=()=>{},now=()=>new Date(),tailMs}={}){
  if(!(Number.isFinite(maxCostUsd)&&maxCostUsd>=0)&&!(backend==='fake'&&maxCostUsd==null))throw Object.assign(new Error('--max-cost <usd> is required (a hard cap on the whole bulk run).'),{status:400});
  const j=judges||(backend==='fake'?'fake':'recorded');
  requireConfirm({backend,judges:j,confirm});validateSettings(set);
  const ids=pickClips(visitsDir,clips);
  const runs=[];let spent=0,stopped=null;
  for(const [i,clip] of ids.entries()){
    if(maxCostUsd!=null&&spent>=maxCostUsd){stopped='max_cost';log(`cost cap reached ($${spent.toFixed(4)} of $${maxCostUsd}); ${ids.length-i} clips not run`);break;}
    log(`[${i+1}/${ids.length}] ${clip}`);
    let run;
    try{run=await runImpl({visitsDir,clipId:clip,backend,judges:j,detector,set,confirm,maxCostUsd:maxCostUsd==null?null:Math.max(0,maxCostUsd-spent),env,tailMs});}
    catch(e){runs.push({clip,run:null,error:String(e.message||e).slice(0,200),metrics:null});log('  failed: '+String(e.message||e));continue;}
    spent+=run.cost_usd||0;
    runs.push({clip,run:run.id,state:run.state,aborted:run.aborted,errors:run.errors?.length||0,metrics:run.metrics,original:run.original_metrics});
    if(run.aborted==='max_cost'){stopped='max_cost';break;}
  }
  const ok=runs.filter(r=>r.metrics);
  const card={version:1,generated_at:now().toISOString(),backend,judges:j,detector:detector||'real',settings:set,commit:null,max_cost_usd:maxCostUsd??null,total_cost_usd:Math.round(spent*1e6)/1e6,
    clips_requested:ids.length,stopped_reason:stopped,runs,aggregate:aggregate(ok.map(r=>r.metrics)),original_aggregate:aggregate(ok.filter(r=>r.original).map(r=>r.original))};
  let saved=null;if(scorecardDir)saved=writeScorecard(scorecardDir,card,now());
  return {card,saved};
}

const f=(x,u='')=>x==null?'-':x+u;
export function formatScorecard(card){
  const a=card.aggregate,lines=[];
  lines.push(`Scorecard  backend=${card.backend}  judges=${card.judges}  runs=${a.runs}/${card.clips_requested}  cost=$${card.total_cost_usd}${card.stopped_reason?'  STOPPED: '+card.stopped_reason:''}`);
  lines.push('clip                          path->welcome  path->audio  empty(n/s)  barge  recon  turns  cost      costume  goodbye');
  for(const r of card.runs){
    const m=r.metrics;
    if(!m){lines.push(`${r.clip}  ERROR ${r.error||''}`);continue;}
    lines.push(`${r.clip.padEnd(29)} ${String(f(m.path_to_welcome_ms,' ms')).padEnd(14)} ${String(f(m.path_to_first_audio_ms,' ms')).padEnd(12)} ${String(m.spoke_while_empty.count+'/'+m.spoke_while_empty.seconds).padEnd(11)} ${String(m.interruptions).padEnd(6)} ${String(m.reconnects).padEnd(6)} ${String(m.turns).padEnd(6)} ${String('$'+f(m.cost_usd)).padEnd(9)} ${String(m.costume.hit==null?'-':m.costume.hit?'yes':'no').padEnd(8)} ${m.goodbye?'yes':'no'}`);
  }
  lines.push(`mean path->welcome ${f(a.path_to_welcome_ms.mean,' ms')} (median ${f(a.path_to_welcome_ms.median)}), first audio ${f(a.path_to_first_audio_ms.mean,' ms')}; spoke while EMPTY in ${a.spoke_while_empty.runs_with} runs (${a.spoke_while_empty.seconds} s); barge-ins ${a.interruptions}; reconnects ${a.reconnects}; costume ${a.costume_mention.hits}/${a.costume_mention.of}; goodbye ${a.goodbye.yes}/${a.goodbye.of}`);
  return lines.join('\n');
}
