// Arrival handling driven by every detector frame (not the ~1 s decision read): Live pre-warm and the early welcome.
//  - Pre-warm (PREWARM=on|off, default on; PREWARM_MAX_MS=15000): when a person is on the sidewalk (SIDEWALK/PATH state, or a confirmed track arriving in sidewalk/path/porch) the Live
//    session connects with no prompt and no audio, so the welcome can be sent the moment someone reaches the path. It closes if nobody reaches the path within PREWARM_MAX_MS or the group
//    goes EMPTY (and is not re-opened for the same group). Never in OFF / DATA_CAPTURE / rehearsal / DEBUG_SPEAK (`enabled()` is false there).
//  - Early welcome: the welcome starts on the first frame where a confirmed track is on path/porch (the tracker's zone hysteresis already requires the foot to be ZONE_MARGIN inside) and
//    arriving (or standing on the porch). It does not wait for the debounced PATH state and never awaits a costume/motion Judge.
// Pure orchestration: all I/O (party, voice, clock, timers) is injected.
import {welcomePromptFor,barkerPromptFor} from '../voice/party-flow.mjs';

const AREA=new Set(['path','porch']);
export function arrivalOptions(env={}){
 const ms=Number(env.PREWARM_MAX_MS);
 return {prewarm:env.PREWARM!=='off',prewarmMaxMs:Number.isFinite(ms)&&ms>0?ms:15000};
}
// True when the tracker result has a confirmed track that has really arrived: on path/porch (inside by the zone margin) and arriving, or standing on the porch.
export function arrivalTrack(group){
 return (group?.motion?.persons||[]).some(p=>AREA.has(p.zone)&&(p.dir==='arriving'||(p.zone==='porch'&&p.dir==='present')));
}
// A sidewalk/path/porch person heading toward the porch, or the debounced state already says someone is there.
export function sidewalkArrival(r){
 const g=r?.group;
 if(g&&(g.state==='SIDEWALK'||g.state==='PATH'))return true;
 return (r?.persons||[]).some(p=>p.dir==='arriving'&&['sidewalk','path','porch'].includes(p.zone));
}
// Group has reached the SIDEWALK state and someone on it is heading toward the porch (barker trigger).
export function sidewalkBarkerTrigger(r){
 const g=r?.group;if(g?.state!=='SIDEWALK')return false;
 const persons=g.motion?.persons||r?.persons||[];
 return persons.some(p=>p.dir==='arriving')||Number(g.motion?.arriving)>0;
}
export function createArrival({env={},heckling=()=>true,now=Date.now,enabled=()=>true,busy=()=>false,party,voice,instructions='',improv,rng=Math.random,note=()=>{},
  schedule=(fn,ms)=>{const t=setTimeout(()=>{Promise.resolve(fn()).catch(()=>{});},ms);t.unref?.();return t;},cancel=clearTimeout}={}){
 const opt=arrivalOptions(env);
 let warm=null,spent=false,beginning=false,starts=0,closes=0,welcomes=0,last=null,barked=false,barkers=0,barking=false;
 const clearWarm=()=>{if(warm){cancel(warm.timer);warm=null;}};
 async function closeWarm(reason){
  const w=warm;if(!w)return;clearWarm();closes++;
  note('prewarm_close',{reason});
  if(reason==='timeout')spent=true;
  try{const v=await voice();if(v.status?.().warm||v.status?.().state==='warm')await v.stop?.('Pre-warm '+reason);}catch{}
 }
 async function startWarm(){
  if(warm)return;
  try{if((await voice()).alwaysOn){spent=true;return;}}catch{} // an always-on backend (Gemini) is already connected: pre-warm is a no-op
  warm={since:now(),timer:schedule(()=>closeWarm('timeout'),opt.prewarmMaxMs)};starts++;
  note('prewarm_start');
  try{const v=await voice();if(!v.prewarm)throw new Error('no prewarm');await v.prewarm({instructions});}
  catch{if(warm){clearWarm();spent=true;}}
 }
 async function startWelcome(group){
  beginning=true;
  try{
   clearWarm(); // the warm session (connected or still connecting) is about to be promoted by party.begin -> voice.start
   note('welcome_triggered',{state:group.state});
   const p=await party();if(p.active||p.locked)return;
   const welcome=welcomePromptFor({partySize:Math.max(1,group.count||1),groupState:'PATH',hour:new Date(now()).getHours(),costumeLabels:[],rng,improv,barked});
   welcomes++;
   await p.begin(welcome,{trigger:'early_path'});
  }finally{beginning=false;}
 }
 async function onDetect(r){
  const g=r?.group;if(!g)return;
  if(g.state==='EMPTY'&&!(g.tracks>0)){spent=false;barked=false;if(warm)await closeWarm('empty');return;}
  if(!enabled()){if(warm)await closeWarm('disabled');return;}
  if(busy()||beginning)return;
  if(heckling()&&!barked&&!barking&&sidewalkBarkerTrigger(r)){ // once per group: a call-out to people on the sidewalk, ahead of the path welcome
   barking=true;
   try{const v=await voice();if(v.barker){const text=barkerPromptFor({partySize:g.count,rng,improv});if(v.barker(text)){barked=true;barkers++;note('barker_triggered',{state:g.state});}}}catch{}finally{barking=false;}
  }
  if(arrivalTrack(g)){last=r.at??null;await startWelcome(g);return;}
  if(opt.prewarm&&!spent&&!warm&&sidewalkArrival(r))await startWarm();
 }
 return {onDetect,status:()=>({prewarm:opt.prewarm,prewarm_max_ms:opt.prewarmMaxMs,warm:Boolean(warm),warm_since:warm?.since??null,spent,starts,closes,welcomes,barkers,barked,last_welcome_frame_at:last}),opts:opt,
  notePartyActive:on=>{if(on)clearWarm();}};
}
