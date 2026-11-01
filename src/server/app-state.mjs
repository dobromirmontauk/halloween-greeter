// Server-computed operator state. Pure: inject everything, including `now`.
export const PHASES=['GREETING','COSTUMES','GOODBYE'];
// Prompt kinds (party-flow onPrompt) -> Live phase. A NEW_PARTY handoff restarts at GREETING.
const PHASE_BY_KIND={welcome:'GREETING',handoff:'GREETING',costume:'COSTUMES',goodbye:'GOODBYE',farewell:'GOODBYE'};
export const nextPhase=(prev,kind)=>PHASE_BY_KIND[kind]||prev||null;

export function deriveAppState({automatic=false,debugSpeak=false,speaker=null,live=null,visitorCount=null,groupState='EMPTY',absentSince=null,absenceMs=30000,phase=null,now=Date.now(),limitSeconds=1800}={}){
 const state=live?.state||'idle';
 const liveOn=['starting','active','stopping'].includes(state);
 const elapsed=live?.startedAt&&liveOn?Math.max(0,Math.floor((now-live.startedAt)/1000)):null;
 const base={elapsed_seconds:elapsed,limit_seconds:limitSeconds,visitor_count:visitorCount,group_state:groupState||'EMPTY',group_label:groupState==='PATH'?'PEOPLE ON PATH':groupState==='SIDEWALK'?'PEOPLE ON SIDEWALK':null,mode:debugSpeak?'debug':'live',greeter:automatic,live_phase:null,message:null,phrase:null,absence_seconds_left:null};
 const out=(app_state,extra={})=>({...base,app_state,...extra});
 if(state==='error'&&!debugSpeak)return out('ERROR',{message:live.error||'Live audio failed'});
 if(liveOn&&!debugSpeak){
  const live_phase=state==='active'?(phase||'GREETING'):null;
  if(state==='starting')return out('LIVE_STARTING');
  const left=absentSince!=null?Math.max(0,Math.ceil((absenceMs-(now-absentSince))/1000)):null;
  if(state==='stopping')return out('CLOSING',{live_phase,absence_seconds_left:left});
  if(live.muted)return out('MUTED',{live_phase});
  if(visitorCount===0&&left!=null)return out('CLOSING',{live_phase,absence_seconds_left:left});
  return out('LIVE_ACTIVE',{live_phase});
 }
 if(!automatic)return out('OFF');
 if(debugSpeak&&speaker?.error)return out('ERROR',{message:speaker.error});
 if(debugSpeak&&speaker?.speaking)return out('DEBUG_SPEAKING',{phrase:speaker.current||null});
 return out(visitorCount>=1?'PARTY_DETECTED':'WATCHING');
}
