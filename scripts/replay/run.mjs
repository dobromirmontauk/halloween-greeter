#!/usr/bin/env node
// Replay one visit clip through the real pipeline with a chosen voice backend.
//   node scripts/replay/run.mjs --clip <id> --backend gemini|openai|fake [--judges real|fake|recorded] [--detector real|recorded]
//        [--set KEY=VAL ...] [--speaker] [--send-recorded-media] [--max-cost <usd>] [--visits-dir <dir>] [--run-id <id>] [--tail-ms 8000] [--json]
//        [--from http://device:3031 [--cleanup]]   pull the clip (meta, video, mic track) over read-only HTTP into a private tmp cache; works on macOS (Node 22 + ffmpeg)
//        [--detections recorded|live]   recorded = the clip's saved boxes (no YOLO sidecar or model needed); live = the real YOLO sidecar (default)
//        [--visitor silent|clip-mic|scripted]   who talks back: the clip's own mic track, a local-TTS kid (macOS say / Linux espeak-ng), or nobody. Default: clip-mic when the clip has a mic track, else scripted (fake backend: silent)
//        [--visitor-silent-after <n>]   scripted visitor goes quiet after n replies (0 = never speaks): exercises the silence joke
//        [--gemini-mode events|all-gemini]   passed to the Gemini backend as GEMINI_MODE
// --speaker plays the backend's voice on this machine (macOS: ffplay, else afplay; Linux: pw-play). The microphone is never opened: mic input is the clip's own mic track, or silence.
// Real backends (and --judges real) send the clip's frames and voices to OpenAI/Google: --send-recorded-media is required. The fake backend is free and needs no confirm.
// Output: data/visits/<id>/runs/<runId>/{run.json,assistant.wav}
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadEnv} from '../../server.mjs';
import {mkdirSync,cpSync} from 'node:fs';
import {runReplay} from '../../src/replay/replay-run.mjs';
import {fetchClip} from '../../src/replay/replay-remote.mjs';
import {fmtClock} from '../../public/visit-runs.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..','..');
export function parseArgs(argv){
  const o={set:{}},flags=new Set(['speaker','send-recorded-media','json','cleanup']);
  for(let i=0;i<argv.length;i++){
    const a=argv[i];if(!a.startsWith('--'))continue;const k=a.slice(2);
    if(flags.has(k)){o[k]=true;continue;}
    const v=argv[++i];
    if(k==='set'){const j=String(v).indexOf('=');if(j<1)throw new Error('--set needs KEY=VAL');o.set[v.slice(0,j)]=v.slice(j+1);}else o[k]=v;
  }
  return o;
}
async function main(){
  loadEnv(resolve(root,'.env'));if(process.env.OPENAI_ENV_FILE)loadEnv(process.env.OPENAI_ENV_FILE);
  const a=parseArgs(process.argv.slice(2));
  if(!a.clip||!a.backend){console.error('usage: run.mjs --clip <id> --backend gemini|openai|fake [--judges real|fake|recorded] [--detector real|recorded] [--set K=V] [--speaker] [--send-recorded-media] [--max-cost usd]');process.exit(2);}
  const out=a.json?o=>console.log(JSON.stringify(o)):()=>{};
  const localDir=resolve(a['visits-dir']||process.env.VISIT_DIR||resolve(root,'data','visits'));
  const detector=a.detections?(a.detections==='live'?'real':a.detections):(a.detector||'real');
  if(a['gemini-mode'])a.set.GEMINI_MODE=a['gemini-mode'];
  let remote=null,visitsDir=localDir;
  if(a.from){remote=await fetchClip({from:a.from,clipId:a.clip});visitsDir=remote.visitsDir;if(!a.json)console.error(`clip ${a.clip} fetched (${remote.has_mic?'with':'no'} mic track)`);}
  let run;
  try{
    run=await runReplay({visitsDir,clipId:a.clip,backend:a.backend,judges:a.judges||(a.backend==='fake'?'fake':'recorded'),detector,set:a.set,speaker:Boolean(a.speaker),
      confirm:Boolean(a['send-recorded-media']),maxCostUsd:a['max-cost']!=null?Number(a['max-cost']):null,visitor:a.visitor||null,visitorSilentAfter:a['visitor-silent-after']!=null?Number(a['visitor-silent-after']):null,runId:a['run-id']||null,tailMs:a['tail-ms']?Number(a['tail-ms']):undefined,
      onLine:l=>{if(!a.json)console.log(`[${fmtClock(l.t)}] ${l.role==='assistant'?'assistant':'visitor  '}: ${l.text.trim()}`);else out({line:l});},
      onProgress:p=>{if(a.json)out({progress:p});}});
    if(remote){ // keep the run (audio + run.json) locally even when the clip cache is removed
      const dest=resolve(root,'data','replay','runs',run.clip,run.id);mkdirSync(dest,{recursive:true,mode:0o700});cpSync(resolve(remote.clipDir,'runs',run.id),dest,{recursive:true});run.saved_to=dest;
    }
  }finally{if(remote&&a.cleanup)remote.remove();else if(remote&&!a.json)console.error('clip cache kept at '+remote.visitsDir+' (use --cleanup to delete)');}
  const m=run.metrics;
  if(a.json)out({done:{id:run.id,state:run.state,cost_usd:run.cost_usd,metrics:m}});
  else{
    console.log(`run ${run.id}  ${run.backend}/${run.model}  judges=${run.judges}  state=${run.state}${run.aborted?' ('+run.aborted+')':''}  cost=$${run.cost_usd??'?'}`);
    console.log(`path->welcome ${m.path_to_welcome_ms??'-'} ms, path->first audio ${m.path_to_first_audio_ms??'-'} ms, turns ${m.turns}, barge-ins ${m.interruptions}, reconnects ${m.reconnects}, spoke while EMPTY ${m.spoke_while_empty.count} (${m.spoke_while_empty.seconds} s), costume ${m.costume.hit==null?'n/a':m.costume.hit?'mentioned':'not mentioned'}, goodbye ${m.goodbye?'yes':'no'}`);
    console.log(`visitor ${run.visitor}: ${m.visitor_turns_simulated} simulated lines; nudges ${Object.entries(m.nudges||{}).filter(([,t])=>t!=null).map(([k,t])=>k+'@'+fmtClock(t)).join(' ')||'none'}; silence joke ${m.silence_joke_fired?'fired':'no'}`);
    if(run.errors.length)console.log('errors: '+run.errors.join(' | '));
    if(run.connect_error)console.error('Last Gemini close/connect reason: '+run.connect_error);
    console.log(`COST: $${run.cost_usd==null?'?':run.cost_usd.toFixed(4)}${a['max-cost']!=null?'  (cap $'+a['max-cost']+')':''}`);
    console.log(`saved: ${run.saved_to||resolve(visitsDir,run.clip,'runs',run.id)}`);
  }
  process.exit(run.state==='done'?0:1);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message||e);process.exit(e.code==='CONFIRM_REQUIRED'?3:1);});
