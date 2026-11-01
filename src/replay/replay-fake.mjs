// Free stand-ins for replays and CI: a scripted voice backend, Judge answers (fake / recorded) and a detector sidecar that replays the clip's saved boxes.
import {EventEmitter} from 'node:events';

const UNCERTAIN_COSTUME=new Set(['uncertain','unknown','other_costume','not_visible','none','no_costume']);
export const acceptedCostumes=meta=>{
  const out=new Set();
  for(const r of meta?.judge_reads||[])for(const a of r.judges?.costume?.answers||[])if(a&&a.accepted&&a.choice&&!UNCERTAIN_COSTUME.has(a.choice))out.add(String(a.choice));
  return [...out];
};
export const truthCostumes=meta=>[...new Set([...(meta?.truth_costumes||[]),...(meta?.ai_costumes||[]),...(meta?.ai_labels?.costumes||[])].map(String))];

const LINES={welcome:'Evening, folks. Fine night for a banjo and a bag of candy. What brings you up my path?',costume:'Now that is a costume. What is your favorite candy?',goodbye:'Safe travels, and mind the skeletons on your way out.',farewell:'Come back any time.',default:'Well now, is that so.'};
const sine=(ms,rate=24000,hz=330)=>{const n=Math.round(ms/1000*rate),b=Buffer.alloc(n*2);for(let i=0;i<n;i++)b.writeInt16LE(Math.round(Math.sin(2*Math.PI*hz*i/rate)*3000),i*2);return b;};

// Same surface as createLinuxLive (openai-like): start/prewarm/stop/sendPrompt/instruct/status ... Emits the same speech events and transcript fragments, and "speaks" a tone through the audio tap.
// lines: assistant lines to use in order (e.g. the original clip's assistant turns); falls back to generic ones. Costs nothing.
export function createFakeLive({now=Date.now,onSpeech=()=>{},onTranscript=()=>{},onUsage=()=>{},audioTap=null,lines=[],schedule=(fn,ms)=>{const h=setTimeout(fn,ms);h.unref?.();return h;},cancel=clearTimeout,connectMs=60,firstAudioMs=120}={}){
  let state='idle',warm=false,sessionId=null,startedAt=null,serial=0,aTurn=null,firstOut=false,spoke=0,timers=new Set();
  const kinds=new Set();
  const speech=(kind,extra={})=>{try{onSpeech({kind,at:now(),session_id:sessionId,...extra});}catch{}};
  const later=(fn,ms)=>{const h=schedule(()=>{timers.delete(h);fn();},ms);timers.add(h);return h;};
  const status=()=>({state,active:state==='active',warm,muted:false,sessionId,startedAt,error:null,apiError:null,transcripts:[],inputBytes:0,outputBytes:0,usage:null,prompt_events:[...kinds],backend:'fake',model:'fake-voice'});
  function say(kind){
    const text=lines[spoke]||LINES[kind]||LINES.default;spoke++;
    if(aTurn){cancel(aTurn.timer);}
    const ms=Math.min(2500,500+text.length*18);
    later(()=>{
      if(state!=='active')return;
      if(!firstOut){firstOut=true;speech('first_audio_out',{source:'audio'});speech('first_transcript');}
      speech('assistant_turn_start');
      try{onTranscript({session_id:sessionId,received_at:new Date(now()).toISOString(),role:'assistant',text,delta:text});}catch{}
      try{audioTap?.out?.(sine(ms));}catch{}
      const turn={timer:null};aTurn=turn;
      turn.timer=schedule(()=>{if(aTurn===turn){aTurn=null;speech('assistant_turn_end',{text:text.replace(/\s+/g,' ').slice(0,80)});}},ms);turn.timer.unref?.();
    },firstAudioMs);
  }
  function activate(welcome){
    state='active';warm=false;firstOut=false;
    speech('live_activated');
    if(welcome!=null)sendPrompt('welcome',welcome||'welcome');
  }
  function sendPrompt(kind,content){
    if(state!=='active'||!['welcome','costume','goodbye'].includes(kind)||kinds.has(kind)||!String(content||'').trim())return false;
    kinds.add(kind);speech(kind+'_sent');say(kind);return true;
  }
  const instruct=(content,kind='instruct')=>{if(state!=='active'||!String(content||'').trim())return false;speech(String(kind).replace(/[^a-z_]/g,'')+'_sent');say(kind);return true;};
  async function connect(prewarm){
    sessionId='fake-'+(++serial);startedAt=Date.now();state='starting';warm=Boolean(prewarm);
    speech('live_start_requested',{prewarm:Boolean(prewarm)});
    await new Promise(r=>later(r,connectMs));
    speech('live_connected',{prewarm:Boolean(prewarm)});
  }
  async function start({welcomePrompt=''}={}){
    if(state==='active')return status();
    if(state==='warm'){activate(welcomePrompt);return status();}
    await connect(false);if(state!=='starting')return status();
    state='active';sendPrompt('welcome',welcomePrompt||'welcome');return status();
  }
  async function prewarm(){if(state!=='idle')return status();await connect(true);if(state==='starting')state='warm';return status();}
  async function stop(reason='operator'){
    if(state==='idle')return status();
    const wasWarm=state==='warm';
    for(const h of timers)cancel(h);timers.clear();
    if(aTurn){cancel(aTurn.timer);speech('assistant_turn_end',{text:''});aTurn=null;}
    speech('live_end',{reason});state='idle';warm=false;kinds.clear();
    try{onUsage({sessionId,seconds:0,estimated:false,backend:'fake',usd:0});}catch{}
    return {...status(),stopped_warm:wasWarm};
  }
  return {start,prewarm,stop,setMuted:()=>status(),updateContext:()=>false,sendPrompt,instruct,rearmPrompts:(...k)=>{for(const x of k)kinds.delete(x);},status,close:stop};
}

// ---- Judges ----
const ans=(name,choice,confidence=0.99,probabilities)=>({type:'choice',name,choice,confidence,...(probabilities?{probabilities}:{})});
function neutralAnswers(body){
  return (body.questions||[]).map(q=>q.name==='real_people_count'?ans(q.name,'1'):q.name==='closest_person_location'?ans(q.name,'path'):/_motion$/.test(q.name)?ans(q.name,'present'):/face_or_mask/.test(q.name)?ans(q.name,'not_visible'):/_location$/.test(q.name)?ans(q.name,'path'):ans(q.name,'uncertain',0.99));
}
const sceneResult=(costumes=[])=>({output:[{content:[{type:'output_text',text:JSON.stringify({people_visible:true,visitor_count:1,audience:'uncertain',costumes,speech_context:costumes.length?'A visitor on the path, possibly dressed as '+costumes.join(', ')+'.':'A visitor on the path; costume unclear.',props:[],clothing:[],costume_status:costumes.length?'obvious_costume':'uncertain',description:'Replay scene.'})}]}],usage:null});
const json=body=>({ok:true,status:200,json:async()=>body});
// mode: 'fake' (neutral/uncertain answers) | 'recorded' (the clip's judge_reads, nearest in time) | 'real' (realFetch, goes to OpenAI).
export function createJudgeFetch({mode='fake',meta=null,tNow=()=>0,realFetch=null}={}){
  if(mode==='real')return realFetch||((...a)=>fetch(...a));
  const reads=(meta?.judge_reads||[]).filter(r=>Number.isFinite(r.t));
  const recordedFor=(kind,t)=>{
    let best=null,bd=Infinity;
    for(const r of reads){const j=r.judges?.[kind];if(!j?.answers?.length)continue;const d=Math.abs(r.t-t);if(d<bd){bd=d;best=j;}}
    return best&&bd<=4000?best.answers:null;
  };
  const costumes=acceptedCostumes(meta);
  return async(url,opts={})=>{
    let body={};try{body=JSON.parse(opts.body||'{}');}catch{}
    if(/\/responses$/.test(String(url)))return json(sceneResult(mode==='recorded'?costumes.slice(0,2):[]));
    const names=(body.questions||[]).map(q=>q.name),kind=names.includes('real_people_count')?'presence':names.some(n=>/_motion$/.test(n))?'motion':'costume';
    if(mode==='recorded'){
      const rec=recordedFor(kind,tNow());
      if(rec)return json({answers:rec.map(a=>ans(a.name,a.choice,a.confidence??0,a.top?a.top.map(x=>({value:x.choice,probability:x.confidence})):undefined))});
    }
    return json({answers:neutralAnswers(body)});
  };
}

// ---- detector sidecar that answers from the clip's saved boxes (preview and band boxes alike: weak sidewalk boxes feed the tracker's sidewalk list exactly as live) (deterministic, free). Same protocol as face-greeter's sidecar client. ----
export function recordedDetectorSpawn({meta,tNow=()=>0,maxGapMs=1000}={}){
  const dets=(meta?.detections||[]).slice().sort((a,b)=>a.t-b.t);
  const at=t=>{let best=null,bd=Infinity;for(const d of dets){const x=Math.abs(d.t-t);if(x<bd){bd=x;best=d;}else if(d.t>t)break;}return best&&bd<=maxGapMs?best:null;};
  return ()=>{
    const child=new EventEmitter();child.stdout=new EventEmitter();child.kill=()=>{};
    child.stdin={on(){},end(){},write(line){
      const req=JSON.parse(line);if(req.cmd==='shutdown')return;
      const d=at(tNow()),persons=(d?.boxes||[]).filter(b=>!b.suppressed).map(b=>({bbox:b.b,score:b.s}));
      setImmediate(()=>child.stdout.emit('data',Buffer.from(JSON.stringify({id:req.id,ok:true,persons,ms:3,width:960,height:540})+'\n')));
    }};
    setImmediate(()=>child.stdout.emit('data',Buffer.from('{"ready":true}\n')));
    return child;
  };
}
