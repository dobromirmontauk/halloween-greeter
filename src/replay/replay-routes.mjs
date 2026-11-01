// GET routes for audio, levels, runs and scorecards. The recorder routes delegate here; the server mounts handleReplayRoute for /api/replay/*.
import {readFileSync} from 'node:fs';
import {parseWav,pcmLevels} from '../visits/visit-audio.mjs';
import {sendFileRange} from '../server/http-range.mjs';
import {listRuns,readRun,runAudioPath,validRunId,listScorecards,readScorecard} from './replay-store.mjs';

const fail=(status,message)=>Object.assign(new Error(message),{status});
const levelsOf=file=>{const w=parseWav(readFileSync(file));if(!w)throw fail(404,'Audio is not available.');return {bin_ms:100,rate:w.rate,levels:pcmLevels(w.pcm,w.rate,100)};};

export async function handleRunRoute(rec,{req,res,path,send,id,kind}){
  const dir=rec.dirOf(id);if(!dir||!rec.get(id))throw fail(404,'Visit not found.');
  const q=new URL(req.url,'http://localhost').searchParams;
  if(kind==='audio'){
    const m=path.match(/^\/api\/visits\/[^/]+\/audio\/(mic|assistant)$/),p=m&&rec.audioPath(id,m[1]);
    if(!p)throw fail(404,'No audio was recorded for this clip.');
    return sendFileRange(req,res,p,'audio/wav');
  }
  if(kind==='levels'){
    const track=q.get('track')||'mic',runId=q.get('run');
    const p=runId?(validRunId(runId)&&track==='assistant'?runAudioPath(dir,runId):null):rec.audioPath(id,track);
    if(!p)throw fail(404,'No audio for that track.');
    send(200,levelsOf(p));return true;
  }
  const m=path.match(/^\/api\/visits\/[^/]+\/runs(?:\/([^/]+)(?:\/(audio|levels))?)?$/);
  if(!m)return false;
  if(!m[1]){send(200,{runs:listRuns(dir)});return true;}
  if(!validRunId(m[1]))throw fail(404,'Run not found.');
  if(!m[2]){const r=readRun(dir,m[1]);if(!r)throw fail(404,'Run not found.');send(200,r);return true;}
  const p=runAudioPath(dir,m[1]);if(!p)throw fail(404,'No audio for this run.');
  if(m[2]==='levels'){send(200,levelsOf(p));return true;}
  return sendFileRange(req,res,p,'audio/wav');
}

export async function handleReplayRoute({req,res,path,send,scorecardDir,replay}){
  if(req.method==='GET'&&path==='/api/replay/status'){send(200,replay?replay.status():{state:'idle'});return true;}
  if(req.method==='GET'&&path==='/api/replay/scorecards'){send(200,{scorecards:listScorecards(scorecardDir)});return true;}
  const m=path.match(/^\/api\/replay\/scorecards\/([\w.-]+)$/);
  if(req.method==='GET'&&m){const c=readScorecard(scorecardDir,m[1]);if(!c)throw fail(404,'Scorecard not found.');send(200,c);return true;}
  return false;
}
