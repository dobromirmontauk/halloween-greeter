// Pure event state machine over merged Judge reads (Presence + Motion + Costume judges). Buckets are counted from per-person motion answers. Inject `now` for tests.
// Every event needs its condition on two consecutive reads (debounce). Uncertain reads break streaks.
const MIXED_WINDOW_MS=2000,READS=2,COSTUME_CONFIDENCE=0.85,NO_VISITORS_REPEAT_MS=5000,UNCERTAIN_REPEAT_MS=10000,RING=20;
const label=value=>String(value).replace(/_/g,' ');
const people=n=>n===1?'1 person':`${n} people`;
export function phraseFor(event){
 switch(event.type){
  case 'PEOPLE_ON_SIDEWALK':return `People on sidewalk, ${people(event.count)}.`;
  case 'PEOPLE_ON_PATH':return `People on path, ${people(event.count)}.`;
  case 'NEW_PARTY':return `New party approaching, ${people(event.count)}.`;
  case 'COSTUMES':return `Costumes: ${event.labels.map(label).join(', ')}.`;
  case 'LEAVING':return 'Party leaving.';
  case 'NEWCOMERS':return `${event.newcomers} arriving.`;
  case 'DEPARTURES':return `${event.departures} leaving.`;
  case 'MIXED':return `${event.newcomers} arriving, ${event.departures} leaving.`;
  case 'NO_VISITORS':return 'No visitors.';
  case 'UNCERTAIN':return 'Count uncertain.';
  case 'COUNT_CHANGED':return `Now ${people(event.count)}.`;
  case 'STATUS':return `${event.group==='PATH'?'Path':'Sidewalk'}, ${people(event.count)}.${event.costumes?.length?` Costume: ${event.costumes.map(label).join(', ')}.`:''}`;
  default:return '';
 }
}
export const GROUP_LABELS={EMPTY:null,SIDEWALK:'PEOPLE ON SIDEWALK',PATH:'PEOPLE ON PATH'};
const unusable=new Set(['uncertain','not_visible']);
// Detector-sourced reads (presence_source 'detector') arrive already debounced in time by presence-tracker.mjs, so a group-state change from them commits on one read; Judge reads need two.
// statusMs>0 (debug speech): while the group is not EMPTY emit a STATUS (state, count, costumes) every statusMs and an immediate COUNT_CHANGED when the debounced count changes within a state. STATUS is never stored as last_event/in the ring.
export function createJudgeEvents({now=Date.now,onEvent=()=>{},statusMs=0,mixedWindowMs=MIXED_WINDOW_MS}={}){
 const s={group_state:'EMPTY',buckets:{arriving:null,present:null,leaving:null},visitor_count:null,visitor_location:'uncertain',costume_slots:[],persons:[],unbucketed:0,updated_at:null,uncertain:true};
 const ring=[];let seq=0,last=null;
 const streak={group:0,party:0,costumes:0,leaving:0,empty:0,uncertain:0};
 let groupCandidate=null,partyArmed=true,arrivingZero=0,partyBase=0,partyKind=null,lastPresent=0;
 let costumesArmed=true,costumeKey=null,leavingArmed=true;
 let pendNew=0,pendLeave=0,pendSince=null;
 let lastEmpty=null,lastUncertain=null,lastStatus=null,costumeLabels=[],costumeFiredCount=0,stateCount=null,countCandidate=null,countStreak=0;
 const emit=(type,extra={})=>{
  const event={id:++seq,type,at:now(),buckets:{...s.buckets},...extra};event.phrase=phraseFor(event);
  if(type!=='STATUS'){last=event;ring.push(event);if(ring.length>RING)ring.shift();}
  try{onEvent(event);}catch{}
  return event;
 };
 function feed(decision){
  const t=now(),{arriving=null,present=null,leaving=null}=decision||{};const events=[];
  const count=Number.isInteger(decision?.visitor_count)?decision.visitor_count:null;
  Object.assign(s,{buckets:{arriving,present,leaving},visitor_count:count,visitor_location:decision?.visitor_location||'uncertain',costume_slots:(decision?.costume_slots||[]).map(slot=>({...slot})),persons:(decision?.persons||[]).map(p=>({...p})),unbucketed:decision?.unbucketed||0,updated_at:t,uncertain:count===null});
  if(count===null)return feedUncertain();
  streak.uncertain=0;
  // Group state (EMPTY / SIDEWALK / PATH). A transition needs the same candidate on two consecutive reads; an unknown location breaks the streak and keeps the state.
  const loc=decision?.visitor_location,pathy=loc==='path'||loc==='porch';
  const candidate=count===0?'EMPTY':pathy?'PATH':loc==='sidewalk'?'SIDEWALK':null;
  let toPath=false,fromEmpty=false,groupEvent=null;
  if(candidate===null||candidate===s.group_state){streak.group=0;groupCandidate=null;}
  else{streak.group=candidate===groupCandidate?streak.group+1:1;groupCandidate=candidate;
   if(streak.group>=(decision?.presence_source==='detector'?1:READS)){fromEmpty=s.group_state==='EMPTY';s.group_state=candidate;streak.group=0;groupCandidate=null;
    if(candidate==='SIDEWALK')groupEvent={type:'PEOPLE_ON_SIDEWALK',count};
    else if(candidate==='PATH'){toPath=true;groupEvent={type:'PEOPLE_ON_PATH',count};}}}
  // NEW_PARTY: arrivals only count once someone is on the path or porch; sidewalk people never start a party.
  if(count>0&&!pathy){if(loc==='sidewalk')lastPresent=0;streak.party=0;partyKind=null;}
  if(arriving===0){if(++arrivingZero>=READS)partyArmed=true;}else if(arriving>0)arrivingZero=0;
  const kind=!pathy?null:arriving>0?'arriving':present>0?'present':null;
  if(kind&&partyArmed){
   if(streak.party===0||partyKind!==kind){streak.party=0;partyBase=lastPresent;}
   partyKind=kind;streak.party++;
   // A porch appearance only counts when the porch was empty before the streak began.
   if(kind==='present'&&partyBase!==0)streak.party=0;
   if(streak.party>=READS){
    partyArmed=false;arrivingZero=0;streak.party=0;costumesArmed=true;costumeLabels=[];costumeFiredCount=0;
    events.push(emit('NEW_PARTY',{count:kind==='arriving'?arriving:present,silent:true,crowd:Boolean(decision?.crowd)}));
   }
  }else{streak.party=0;partyKind=null;}
  if(present!==null&&pathy)lastPresent=present;
  // PEOPLE_ON_PATH from EMPTY also opens a party when the buckets did not (e.g. first sighting, no Motion read); NEW_PARTY stays an alias fired at the same moment. A group drifting sidewalk->path again is not a new party.
  if(toPath&&fromEmpty&&!(leaving>0)&&partyArmed&&!events.some(e=>e.type==='NEW_PARTY')){partyArmed=false;arrivingZero=0;streak.party=0;costumesArmed=true;costumeLabels=[];costumeFiredCount=0;events.push(emit('NEW_PARTY',{count,silent:true,crowd:Boolean(decision?.crowd)}));}
  // Emitted after NEW_PARTY so the announced (spoken) event is the latest one. NEW_PARTY is silent: debug speech says People on sidewalk / People on path instead.
  if(groupEvent)events.push(emit(groupEvent.type,{count:groupEvent.count}));
  // COUNT_CHANGED / group tracking (debug speech): the count is already debounced for detector reads; Judge reads need two in a row.
  if(s.group_state==='EMPTY'||groupEvent){stateCount=s.group_state==='EMPTY'?null:count;countCandidate=null;countStreak=0;if(s.group_state==='EMPTY'){costumeLabels=[];lastStatus=null;}else if(groupEvent)lastStatus=t;}
  else if(count>0&&stateCount!==null&&count!==stateCount){
   countStreak=count===countCandidate?countStreak+1:1;countCandidate=count;
   if(countStreak>=(decision?.presence_source==='detector'?1:READS)){stateCount=count;countCandidate=null;countStreak=0;if(statusMs>0)events.push(emit('COUNT_CHANGED',{count,group:s.group_state}));}
  }else{countCandidate=null;countStreak=0;}
  // A larger group re-arms COSTUMES so the new people get read.
  if(count>costumeFiredCount&&!costumesArmed&&costumeFiredCount>0){costumesArmed=true;streak.costumes=0;costumeKey=null;}
  // COSTUMES
  const need=Math.min(count,3),slots=s.costume_slots.slice(0,need);
  const ok=costumesArmed&&need>0&&slots.length===need&&slots.every(slot=>slot.confidence>=COSTUME_CONFIDENCE&&slot.label&&!unusable.has(slot.label));
  if(ok){const key=slots.map(slot=>slot.label).join('|');streak.costumes=key===costumeKey?streak.costumes+1:1;costumeKey=key;
   if(streak.costumes>=READS){costumesArmed=false;streak.costumes=0;costumeFiredCount=count;costumeLabels=slots.map(slot=>slot.label);events.push(emit('COSTUMES',{labels:costumeLabels}));}
  }else{streak.costumes=0;costumeKey=null;}
  // LEAVING
  // Detector reads carry leaveGroup: the goodbye needs everybody heading out (or the group just walked back to the sidewalk), never one person leaving while others stay or somebody crossing the porch.
  const leaveGroup=decision?.leaveGroup,leavingN=leaveGroup===undefined?leaving:leaveGroup?Math.max(leaving||0,1):0;
  if(!(leavingN>0))leavingArmed=true;
  if(leavingN>0&&leavingArmed){if(++streak.leaving>=READS){leavingArmed=false;streak.leaving=0;events.push(emit('LEAVING',{count:leavingN}));}}else streak.leaving=0;
  // Crowd (detector reads, a Live party is active): newcomers and departures from the tracker's greeted set. Both within mixedWindowMs become ONE MIXED event; a lone one is emitted once the window passes.
  // The window also holds back a lone one while it is still open, so a late partner can join it.
  if(s.group_state==='EMPTY'){pendNew=pendLeave=0;pendSince=null;}
  else{
   const c=decision?.crowd;
   if(c&&(c.newcomers>0||c.departures>0)){pendNew+=c.newcomers||0;pendLeave+=c.departures||0;pendSince??=t;}
   if(pendSince!==null&&((pendNew>0&&pendLeave>0)||t-pendSince>=mixedWindowMs)){
    const type=pendNew>0&&pendLeave>0?'MIXED':pendNew>0?'NEWCOMERS':'DEPARTURES';
    const extra=type==='MIXED'?{newcomers:pendNew,departures:pendLeave,count:pendNew+pendLeave}:type==='NEWCOMERS'?{newcomers:pendNew,count:pendNew}:{departures:pendLeave,count:pendLeave};
    if(pendNew>0){costumesArmed=true;costumeKey=null;streak.costumes=0;costumeLabels=[];costumeFiredCount=0;} // newcomers: read their costumes
    pendNew=pendLeave=0;pendSince=null;
    events.push(emit(type,extra));
   }
  }
  // NO_VISITORS
  if(count===0&&arriving===0&&present===0&&leaving===0){
   if(++streak.empty>=READS&&(lastEmpty===null||t-lastEmpty>=NO_VISITORS_REPEAT_MS)){lastEmpty=t;events.push(emit('NO_VISITORS'));}
  }else{streak.empty=0;lastEmpty=null;}
  const st=tick();if(st)events.push(st);
  return events;
 }
 // Periodic STATUS while the group is not EMPTY. Called from feed(); exported for tests / timers.
 function tick(){
  if(!(statusMs>0)||s.group_state==='EMPTY'||!(s.visitor_count>0))return null;
  const t=now();
  if(lastStatus===null){lastStatus=t;return null;}
  if(t-lastStatus<statusMs)return null;
  lastStatus=t;
  const costumes=costumeLabels.filter(l=>!unusable.has(l));
  return emit('STATUS',{count:s.visitor_count,group:s.group_state,costumes});
 }
 function feedUncertain(){
  const t=now();const events=[];
  Object.assign(s,{buckets:{arriving:null,present:null,leaving:null},visitor_count:null,visitor_location:'uncertain',costume_slots:[],persons:[],unbucketed:0,updated_at:t,uncertain:true});
  streak.party=streak.costumes=streak.leaving=streak.empty=streak.group=0;groupCandidate=null;partyKind=null;costumeKey=null;lastEmpty=null;
  if(++streak.uncertain>=READS&&(lastUncertain===null||t-lastUncertain>=UNCERTAIN_REPEAT_MS)){lastUncertain=t;events.push(emit('UNCERTAIN'));}
  return events;
 }
 const status=()=>({group_state:s.group_state,group_label:GROUP_LABELS[s.group_state],buckets:{...s.buckets},visitor_count:s.visitor_count,visitor_location:s.visitor_location,costume_slots:s.costume_slots.map(slot=>({...slot})),persons:s.persons.map(p=>({...p})),unbucketed:s.unbucketed,updated_at:s.updated_at,uncertain:s.uncertain,last_event:last&&{...last},phrase:last?last.phrase:null,events:ring.map(event=>({...event}))});
 return {feed,feedUncertain,status,tick};
}
