// Replay engine: one recorded visit clip through the REAL pipeline (an in-process createServer) at real speed.
//   clip MP4 frames -> file camera -> preview -> person-detector (real YOLO sidecar, or the clip's saved boxes with detector:'recorded') -> tracker -> judge-events -> party-flow/arrival/improv -> voice backend
//   clip mic.wav -> the backend's mic input (fake pw-record)      backend audio out -> captured to the run (assistant.wav); --speaker also plays it
// Backends: gemini | openai | fake (scripted, free). Judges: real | fake | recorded. Nothing here touches the live camera, speaker or microphone.
// PRIVACY/COST: a real backend (or real judges) sends the clip's frames and voices to OpenAI/Google; `confirm` (CLI --send-recorded-media, UI checkbox) is required.
import {readFileSync,existsSync,mkdtempSync,writeFileSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from '../../server.mjs';
import {parseWav,toWav,createPcmTrack,renderSegments,resamplePcm,ASSISTANT_RATE} from '../visits/visit-audio.mjs';
import {createFileCamera,createReplayAudio,extractFrames} from './replay-media.mjs';
import {createFakeLive,createJudgeFetch,recordedDetectorSpawn,acceptedCostumes,truthCostumes} from './replay-fake.mjs';
import {scoreRun} from './replay-score.mjs';
import {ensureRunDir,writeRunJson,newRunId} from './replay-store.mjs';
import {createSpeaker} from './replay-speaker.mjs';
import {GEMINI_DEFAULT_MODEL} from '../voice/gemini-live.mjs';
import {VISITOR_MODES,createVisitor,createTts,ttsAvailable,mulberry32,seedOf,scalePcm,mixPcm} from './replay-visitor.mjs';

import {ROOT} from '../lib/paths.mjs';
const root=ROOT;
import {BACKENDS,JUDGE_MODES,DETECTOR_MODES,requireConfirm,validateSettings} from './replay-guard.mjs';
export {BACKENDS,JUDGE_MODES,DETECTOR_MODES,requireConfirm,validateSettings};
const fail=(status,message,code)=>Object.assign(new Error(message),{status,code});
const git=()=>{try{return execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:2000}).trim();}catch{return null;}};
const modelOf=(backend,env)=>backend==='gemini'?(env.GEMINI_LIVE_MODEL||GEMINI_DEFAULT_MODEL):backend==='openai'?'gpt-live-1':'fake-voice';

const merge=frags=>{ // transcript fragments -> turns {t,end,role,text}
  const out=[];
  for(const f of frags){const last=out.at(-1);if(last&&last.role===f.role&&f.t-last.end<=2500){last.text+=f.text;last.end=f.t;}else out.push({t:f.t,end:f.t,role:f.role,text:f.text});}
  return out;
};

export async function runReplay({visitsDir,clipId,backend,judges='fake',detector='real',set={},speaker=false,confirm=false,maxCostUsd=null,env=process.env,runId=null,onProgress=()=>{},tailMs=8000,signal=null,
  extractImpl=extractFrames,speakerImpl=null,visitor=null,visitorSilentAfter=null,ttsImpl=null,visitorSpeakerImpl=null,platform=process.platform,onLine=null,ffmpegPath=env.FFMPEG_PATH||'ffmpeg',createServerImpl=createServer,now=Date.now}={}){
  if(!BACKENDS.includes(backend))throw fail(400,'backend must be gemini, openai or fake.');
  if(!JUDGE_MODES.includes(judges))throw fail(400,'judges must be real, fake or recorded.');
  if(!DETECTOR_MODES.includes(detector))throw fail(400,'detector must be real or recorded.');
  requireConfirm({backend,judges,confirm});
  const overrides=validateSettings(set);
  if(backend==='gemini'&&!env.GEMINI_API_KEY)throw fail(400,'GEMINI_API_KEY is not set.');
  if((backend==='openai'||judges==='real')&&!env.OPENAI_API_KEY)throw fail(400,'OPENAI_API_KEY is not set.');
  if(visitor&&!VISITOR_MODES.includes(visitor))throw fail(400,'visitor must be silent, clip-mic or scripted.');
  const clipDir=join(visitsDir,clipId);
  let meta;try{meta=JSON.parse(readFileSync(join(clipDir,'visit.json'),'utf8'));}catch{throw fail(404,'Visit not found.');}
  const video=join(clipDir,'video.mp4');
  if(!existsSync(video))throw fail(409,'The clip video is not available (still encoding?).');
  const fps=meta.fps||6;
  const frames=await extractImpl(video,{ffmpegPath,fps});
  let mic=null;try{if(existsSync(join(clipDir,'mic.wav')))mic=parseWav(readFileSync(join(clipDir,'mic.wav')));}catch{}
  // Simulated visitor: clip-mic (the clip's own mic track) | scripted (local TTS kid) | silent. Default: clip-mic when the clip has a mic track, else scripted (the fake backend ignores the mic: silent).
  let vmode=visitor||(backend==='fake'?'silent':mic?'clip-mic':'scripted');const warnings=[];
  if(vmode==='clip-mic'&&!mic){vmode='scripted';if(visitor)warnings.push('This clip has no mic track: using the scripted visitor.');}
  if(vmode==='scripted'&&!ttsImpl){const av=ttsAvailable({platform});if(!av.ok){if(visitor)throw fail(400,av.message);vmode='silent';warnings.push(av.message+' Running with a silent visitor.');}}
  const id=runId||newRunId(backend),dir=ensureRunDir(clipDir,id);
  const startedAt=now();
  const run={version:1,id,clip:clipId,state:'running',backend,model:modelOf(backend,env),judges,detector,settings:overrides,commit:git(),started_at:new Date(startedAt).toISOString(),one_sided:!mic&&vmode!=='scripted',visitor:vmode,speech:[],transcript:[],state_timeline:[],errors:[],cost_usd:null,reconnects:0};
  writeRunJson(dir,run);

  const tmp=mkdtempSync(join(tmpdir(),'greeter-replay-'));
  let t0=null;const tNow=()=>t0==null?0:Date.now()-t0;
  let lineBuf=null,lineTimer=null;const flushLine=()=>{clearTimeout(lineTimer);if(lineBuf){try{onLine?.(lineBuf);}catch{}lineBuf=null;}};
  const speech=[],frag=[],timeline=[{t:0,state:'EMPTY'}],errors=[];let firstPathT=null,lastState='EMPTY';
  const track=createPcmTrack({rate:ASSISTANT_RATE,mode:'playback',now:tNow});
  const speakerSink=speaker?(speakerImpl||createSpeaker)():null;
  const audioTap={out:b=>{track.push(b,tNow());try{speakerSink?.write(b);}catch{}},flush:()=>{track.flush(tNow());}};
  const vSpeaker=speaker&&vmode==='scripted'?(visitorSpeakerImpl||(()=>createSpeaker({rate:16000})))():null;
  const vTrack=createPcmTrack({rate:16000,mode:'playback',now:tNow});
  let audio=null,vTts=null;const vLines=[];
  const visitorSim=vmode==='scripted'?createVisitor({tts:text=>vTts(text),rng:mulberry32(seedOf(id+clipId)),silentAfter:visitorSilentAfter,tNow,
    inject:pcm=>{audio?.inject(pcm,16000);vTrack.push(pcm,tNow());try{vSpeaker?.write(scalePcm(pcm,0.4));}catch{}},
    record:l=>{if(l.error){errors.push('visitor: '+l.error);return;}const e={t:Math.round(l.t),kind:'visitor_line',text:l.text,dur_ms:l.dur_ms};speech.push(e);vLines.push(e);try{onLine?.({t:e.t,role:'visitor',text:l.text});}catch{}}}):null;
  const hooks={
    onSpeech:ev=>{const {at,session_id,...rest}=ev;speech.push({t:Math.round(((Number.isFinite(at)?at:Date.now())-(t0??Date.now()))*10)/10,...rest});try{visitorSim?.onSpeech(ev);}catch{}},
    onTranscript:ev=>{const text=String(ev.text??ev.delta??'');if(!(text&&['user','assistant'].includes(ev.role)))return;const t=Math.round((Date.now()-(t0??Date.now()))*10)/10;frag.push({t,role:ev.role,text});
      if(onLine){ // live lines: one per turn, flushed on a role change or 1.2 s of quiet
        if(lineBuf&&lineBuf.role!==ev.role)flushLine();
        if(!lineBuf)lineBuf={t,role:ev.role,text:''};lineBuf.text+=text;clearTimeout(lineTimer);lineTimer=setTimeout(flushLine,1200);lineTimer.unref?.();}
      try{visitorSim?.onTranscript(ev);}catch{}},
    onDetect:r=>{
      const t=tNow(),st=r.group?.state;
      if(firstPathT==null&&(r.persons||[]).some(p=>['path','porch'].includes(p.zone)&&p.score>=0.5))firstPathT=t;
      if(st)visitorSim?.onDetect(st);
      if(st&&st!==lastState){lastState=st;timeline.push({t,state:st,count:r.group?.count??null});}
    }
  };
  if(meta.zones?.length){const zf=join(tmp,'zones.json');writeFileSync(zf,JSON.stringify({version:1,zones:meta.zones}),{mode:0o600});overrides.DETECTOR_ZONES_FILE??=zf;}
  const sub=n=>join(tmp,n);
  const envFor={...env,CAMERA_URL:'rtsp://replay.invalid/clip',AUDIO_MODE:'linux',VOICE_BACKEND:backend==='gemini'?'gemini':'openai',VISITS:'off',VISIT_AUDIO:'off',VISIT_DIR:sub('visits'),AUTO_START:'true',START_MODE:'ON',MODE_SCHEDULE:'',MODE_FILE:'',
    DEBUG_SPEAK:'false',DETECTOR_STRATEGY:'preview',BAND_FPS:'0',DETECTOR_FPS:env.DETECTOR_FPS||'4',SESSIONS_DIR:sub('sessions'),COSTS_DIR:sub('costs'),EVENT_AUDIT_DIR:sub('events'),TRANSCRIPT_DIR:sub('transcripts'),JUDGE_LOG_DIR:sub('judge-log'),
    CAPTURE_DIR:sub('captures'),CAPTURE_MIN_FREE_GB:'0',REPLAY_DIR:sub('replay'),PORT:'0',OPENAI_API_KEY:env.OPENAI_API_KEY||'replay-dummy',...overrides};
  delete envFor.AUDIO_INPUT_TARGET;delete envFor.AUDIO_OUTPUT_TARGET;
  const camera=createFileCamera({frames});
  if(visitorSim)vTts=ttsImpl||createTts({platform,ffmpegPath});
  audio=createReplayAudio({mic:vmode==='clip-mic'?mic:null,tNow,sink:null});
  const fetchImpl=createJudgeFetch({mode:judges,meta,tNow});
  const fake=backend==='fake'?createFakeLive({onSpeech:hooks.onSpeech,onTranscript:hooks.onTranscript,audioTap,lines:(meta.transcript?merge(meta.transcript.map(x=>({...x}))).filter(x=>x.role==='assistant').map(x=>x.text):[])}):null;
  const server=createServerImpl({env:envFor,fetchImpl,cameraStreamImpl:camera,detectorSpawnImpl:detector==='recorded'?recordedDetectorSpawn({meta,tNow}):undefined,voiceImpl:fake||undefined,audioSpawnImpl:audio.spawnImpl,audioTap,replayHooks:hooks});
  let aborted=null,connectReason=null;
  const api=async p=>{const port=server.address().port;const r=await fetch(`http://127.0.0.1:${port}${p}`);return r.json();};
  const costNow=async()=>{try{return (await api('/api/costs')).since_start?.total_usd??0;}catch{return null;}};
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const endMs=Math.max(meta.video_ms||0,frames.at(-1)?.t||0);
  try{
    await new Promise((res,rej)=>{server.once('error',rej);server.listen(0,'127.0.0.1',res);});
    // Wait for the sidecar (real YOLO takes a few seconds to load) and, for the always-on Gemini backend, for its connection.
    const readyBy=Date.now()+(detector==='real'?90000:10000);
    while(Date.now()<readyBy){const st=await api('/api/detector/status').catch(()=>null);if(st?.state==='ready')break;if(st&&(st.state==='disabled'||st.error)&&detector==='real'&&Date.now()>readyBy-60000&&st.state==='disabled'){errors.push('Detector sidecar disabled: '+(st.error||'unknown'));break;}await sleep(200);}
    if(backend==='gemini'){
      const by=Date.now()+30000,failed=()=>speech.some(e=>e.kind==='live_failed');
      while(Date.now()<by&&!speech.some(e=>e.kind==='live_connected')&&!failed())await sleep(100);
      if(!speech.some(e=>e.kind==='live_connected')){
        const why=[...speech].reverse().find(e=>e.detail&&['live_reconnect','live_failed'].includes(e.kind))?.detail||(await api('/api/status').catch(()=>({}))).voice_error||null;
        connectReason=why;errors.push(failed()?'Gemini connection failed, not retrying: '+why:'Gemini did not connect within 30 s'+(why?'. Last error: '+why:'.'));
        if(failed()){aborted='error';}
      }
    }
    if(aborted)throw new Error(errors.at(-1));
    t0=Date.now();camera.play(t0);
    const stopAt=endMs+tailMs,hard=stopAt+60000;let lastP=0;
    for(;;){
      const t=tNow();
      if(signal?.aborted){aborted='cancelled';break;}
      if(t>=stopAt&&camera.done())break;
      if(t>=hard){errors.push('Replay timed out.');break;}
      if(maxCostUsd!=null){const c=await costNow();if(c!=null&&c>=maxCostUsd){aborted='max_cost';errors.push('Stopped: cost cap $'+maxCostUsd+' reached.');break;}}
      if(t-lastP>=1000){lastP=t;try{onProgress({t_ms:t,of_ms:stopAt});}catch{}}
      await sleep(250);
    }
    const st=await api('/api/status').catch(()=>({}));if(st.voice_error)errors.push(String(st.voice_error));
    const ds=await api('/api/detector/status').catch(()=>null);if(ds&&ds.fallback?.active)errors.push('Detector fell back to the Judge: '+ds.fallback.reason);
    await server.stopAutomation().catch(e=>errors.push('stop: '+String(e.message||e).slice(0,100)));
    await sleep(300);
  }catch(e){if(!aborted)errors.push(String(e.message||e).slice(0,200));if(!aborted)aborted='error';}
  let cost=null,costs=null;
  try{costs=await api('/api/costs');cost=costs.since_start?.total_usd??null;}catch{}
  try{visitorSim?.stop();}catch{}camera.stop();audio.close();try{await speakerSink?.end();}catch{}try{await vSpeaker?.end();}catch{}try{vTts?.cleanup?.();}catch{}
  await new Promise(r=>{try{server.close(()=>r());server.closeAllConnections?.();}catch{r();}});
  flushLine();const durationMs=Math.max(0,tNow());
  const turns=merge(frag);
  const labels={accepted:acceptedCostumes(meta),truth:truthCostumes(meta)};
  speech.sort((a,b)=>a.t-b.t);
  const metrics=scoreRun({speech,transcript:turns,timeline,firstPathT,labels,cost_usd:cost,endMs:Math.max(endMs,speech.at(-1)?.t||0)});
  const original=scoreRun({speech:meta.speech||[],transcript:merge(meta.transcript||[]),timeline:meta.timeline||[],detections:meta.detections||[],labels,endMs:meta.end_ms});
  const nudgeT=k=>{const e=speech.find(x=>x.kind==='nudge_sent'&&String(x.n)===String(k));return e?e.t:null;};
  Object.assign(metrics,{visitor_turns_simulated:vLines.length,silence_joke_fired:nudgeT('silence')!=null,nudges:{1:nudgeT(1),2:nudgeT(2),silence:nudgeT('silence')}});
  const durN=Math.max(endMs,Math.round(durationMs));
  if(vmode!=='silent'){ // whole exchange: visitor (clip mic or simulated, 16 kHz -> 24 kHz) + assistant
    const v24=vmode==='clip-mic'&&mic?resamplePcm(mic.pcm.subarray(0,Math.min(mic.pcm.length,Math.floor(mic.rate*2*durN/1000)&~1)),mic.rate,ASSISTANT_RATE):resamplePcm(renderSegments(vTrack.segs(),16000,0,durN),16000,ASSISTANT_RATE);
    const a24=renderSegments(track.segs(),ASSISTANT_RATE,0,durN);
    writeFileSync(join(dir,'conversation.wav'),toWav(mixPcm(a24,v24),ASSISTANT_RATE),{mode:0o600});
  }
  const wav=toWav(renderSegments(track.segs(),ASSISTANT_RATE,0,Math.max(endMs,Math.round(durationMs))),ASSISTANT_RATE);
  writeFileSync(join(dir,'assistant.wav'),wav,{mode:0o600});chmodSync(join(dir,'assistant.wav'),0o600);
  Object.assign(run,{state:aborted?'aborted':'done',aborted,duration_ms:Math.round(durationMs),speech,transcript:turns,state_timeline:timeline,errors:[...warnings,...errors],cost_usd:cost,conversation_audio:vmode!=='silent'?'conversation.wav':null,connect_error:connectReason,cost_breakdown:costs?{judge_usd:costs.since_start?.by_category?.judge?.usd??0,scene_usd:costs.since_start?.by_category?.scene?.usd??0,live_usd:costs.since_start?.by_category?.live?.usd??0}:null,
    reconnects:metrics.reconnects,metrics,original_metrics:original,labels,audio:'assistant.wav',clip_end_ms:endMs,finished_at:new Date().toISOString()});
  writeRunJson(dir,run);
  try{rmSync(tmp,{recursive:true,force:true});}catch{}
  return run;
}
