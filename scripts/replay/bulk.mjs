#!/usr/bin/env node
// Replay many clips sequentially with a hard cost cap and print + save a scorecard (data/replay/scorecards/<ts>.json).
//   node scripts/replay/bulk.mjs --backend gemini --clips all|<n latest>|id1,id2 --max-cost <usd> [--judges real|fake|recorded] [--detector real|recorded] [--set K=V ...] [--send-recorded-media] [--visits-dir <dir>]
// Real backends send the recorded frames and voices to OpenAI/Google: --send-recorded-media is required. --max-cost is mandatory (fake backend: optional).
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadEnv} from '../../server.mjs';
import {runBulk,formatScorecard} from '../../src/replay/replay-bulk.mjs';
import {scorecardDir} from '../../src/replay/replay-store.mjs';
import {parseArgs} from './run.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..','..');
async function main(){
  loadEnv(resolve(root,'.env'));if(process.env.OPENAI_ENV_FILE)loadEnv(process.env.OPENAI_ENV_FILE);
  const a=parseArgs(process.argv.slice(2));
  if(!a.backend){console.error('usage: bulk.mjs --backend gemini|openai|fake --clips all|<n>|ids --max-cost <usd> [--send-recorded-media]');process.exit(2);}
  const {card,saved}=await runBulk({visitsDir:resolve(a['visits-dir']||process.env.VISIT_DIR||resolve(root,'data','visits')),clips:a.clips||'all',backend:a.backend,judges:a.judges,detector:a.detector||'real',set:a.set,confirm:Boolean(a['send-recorded-media']),
    maxCostUsd:a['max-cost']!=null?Number(a['max-cost']):undefined,env:process.env,scorecardDir:scorecardDir(process.env,root),log:m=>console.error(m),tailMs:a['tail-ms']?Number(a['tail-ms']):undefined});
  console.log(formatScorecard(card));
  if(saved)console.log('scorecard saved: '+saved.file);
}
main().catch(e=>{console.error(e.message||e);process.exit(e.code==='CONFIRM_REQUIRED'?3:1);});
