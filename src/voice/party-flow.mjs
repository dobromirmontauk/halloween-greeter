import {createImprov,costumeQuestion,barkerBrief,welcomeBrief,goodbyeBrief,angleBrief,newcomersBrief,departuresBrief,mixedBrief} from './improv.mjs';
const unsafe=/\b(?:vests?|hi[\s-]?vis|high[\s-]?(?:vis(?:ibility)?|viz)|reflective|fluorescent)\b/i;
export const MAX_SESSION_SECONDS=1800;
// Env SESSION_LIMIT_SECONDS (default and cap 1800s = 30 minutes).
export function sessionLimitMs(env={}){const seconds=Number(env.SESSION_LIMIT_SECONDS);return Math.max(10,Math.min(MAX_SESSION_SECONDS,Number.isFinite(seconds)&&seconds>0?seconds:MAX_SESSION_SECONDS))*1000;}
export const HANDOFF_INSTRUCTION='A new group is arriving. If the departing guests are still in earshot give them a quick goodbye, then greet the newcomers in one short line and ask one question. Treat them as a new group: their costumes and answers are unknown; do not reuse anything the previous group said.';
export const FAREWELL_INSTRUCTION='The guests have left. Say one short, friendly farewell in case they are still in earshot, then stay quiet and ask no new question.';
export function safeVoiceText(value){return String(value||'').split(/(?<=[.!?])\s+|\n+/).filter(sentence=>!unsafe.test(sentence)).join(' ').trim();}
// No sidewalk variant: the welcome is only ever sent once the group is on the path (see PartyController.observe).
// A brief (facts + random angle + avoid-recent), not a script; the model improvises the words.
export function welcomePromptFor(options={}){return safeVoiceText(welcomeBrief(options).prompt);}
export function barkerPromptFor(options={}){return safeVoiceText(barkerBrief(options).prompt);}
export function goodbyePromptFor(options={}){return safeVoiceText(goodbyeBrief(options).prompt);}
export class PartyController{
 constructor({voice,limitMs=60000,describe=async()=>'',instructions='',improv=createImprov(),rng=Math.random,onActive=()=>{},onPrompt=()=>{},now=Date.now,schedule=(fn,ms)=>{const timer=setTimeout(()=>{Promise.resolve(fn()).catch(()=>{});},ms);timer.unref?.();return timer;},cancel=clearTimeout}={}){Object.assign(this,{improv,rng,voice,limitMs,limitStopped:false,describe,instructions,onActive,onPrompt,now,schedule,cancel});this.active=false;this.locked=false;this.serial=0;this.timers=[];this.absentSince=null;this.lastObservation=null;this.costumeKey=null;this.costumeReads=0;this.leavingReads=0;this.sent=new Set();this.lastNewPartyAt=null;this.partyClaimed=false;}
 status(){return {active:this.active,locked:this.locked,prompts:[...this.sent],started_at:this.startedAt||null};}
 onStopped(){this.active=false;for(const timer of this.timers)this.cancel(timer);this.timers=[];this.onActive(false);}
 async close(reason='party ended'){if(!this.active)return;this.onStopped();await this.voice.stop(reason);}
 async prompt(kind,text,source={trigger:'decisions'}){if(!this.active||this.sent.has(kind))return false;const clean=safeVoiceText(text);if(!clean)return false;const delivered=await this.voice.sendPrompt(kind,clean.slice(0,1600));if(delivered===false)return false;this.sent.add(kind);await this.onPrompt({kind,live_prompt:clean.slice(0,1600),...source});return true;}
 async goodbye(source={trigger:'timer'}){if(!this.active||this.sent.has('goodbye'))return;await this.prompt('goodbye',goodbyePromptFor({rng:this.rng,improv:this.improv}),source);}
 async begin(welcome,source={trigger:'manual'}){
   this.locked=true;this.active=true;this.serial++;this.auditSessionId=null;this.startedAt=this.now();this.sent=new Set(['welcome']);this.costumeRequested=false;this.costumeKey=null;this.costumeReads=0;this.leavingReads=0;this.partyClaimed=this.lastNewPartyAt!=null&&this.now()-this.lastNewPartyAt<15000;this.onActive(true);
   this.limitStopped=false;if(source.trigger!=='manual')this.timers.push(this.schedule(()=>this.goodbye(),Math.max(0,this.limitMs-8000)));this.timers.push(this.schedule(()=>{this.limitStopped=true;return this.close('session time limit');},this.limitMs));
   this.starting=true;try{await this.voice.start({instructions:safeVoiceText(this.instructions),welcomePrompt:welcome});}catch{this.onStopped();return;}finally{this.starting=false;}
   await this.onPrompt({kind:'welcome',live_prompt:safeVoiceText(welcome).slice(0,1600),...source});
 }
 // Judge events: NEWCOMERS / DEPARTURES / MIXED speak one improvised brief and keep the session open; NEW_PARTY while a session is active hands off to the newcomers; LEAVING with nobody arriving or present gets one farewell. Neither closes the session.
 async onJudgeEvent(event){
  if(event.type==='NEW_PARTY'){
   const claimed=this.partyClaimed;this.lastNewPartyAt=this.now();
   if(!this.active){if(this.locked&&this.limitStopped){this.locked=false;this.limitStopped=false;}return;}
   this.partyClaimed=true;
   if(!claimed||this.starting||this.sent.has('goodbye'))return; // this event is the party the session already greeted
   if(event.crowd)return; // detector reads: the tracker's NEWCOMERS/MIXED events own the handoff (they know who was already greeted)
   if(this.lastCrowdAt!=null&&this.now()-this.lastCrowdAt<10000)return; // a NEWCOMERS/MIXED line already welcomed them
   if(await this.instruct('handoff',HANDOFF_INSTRUCTION,event)){this.lastHandoffAt=this.now();this.costumeRequested=false;this.costumeKey=null;this.costumeReads=0;this.sent.delete('costume');this.voice.rearmPrompts?.('costume');}
  }else if(event.type==='NEWCOMERS'||event.type==='MIXED'||event.type==='DEPARTURES'){
   // Crowd events while a session is open (the tracker only reports them while it is live). Nothing here closes the session.
   if(!this.active||this.starting||this.sent.has('goodbye'))return;
   if(event.type!=='DEPARTURES'&&this.lastHandoffAt!=null&&this.now()-this.lastHandoffAt<10000)return; // the NEW_PARTY handoff already welcomed them
   const n=event.newcomers||0,d=event.departures||0,args={newcomers:n,departures:d,rng:this.rng,improv:this.improv};
   const brief=event.type==='MIXED'?mixedBrief(args):event.type==='NEWCOMERS'?newcomersBrief(args):departuresBrief(args);
   const kind=event.type==='MIXED'?'mixed':event.type==='NEWCOMERS'?'newcomers':'departures';
   if(await this.instruct(kind,safeVoiceText(brief.prompt),event)&&n>0){this.lastCrowdAt=this.now();this.costumeRequested=false;this.costumeKey=null;this.costumeReads=0;this.sent.delete('costume');this.voice.rearmPrompts?.('costume');}
  }else if(event.type==='LEAVING'){
   if(!this.active||this.starting||this.sent.has('goodbye'))return;
   if(event.buckets?.arriving!==0||event.buckets?.present!==0)return;
   await this.instruct('farewell',FAREWELL_INSTRUCTION,event);
  }
 }
 async instruct(kind,text,event){
  if(!this.voice.instruct?.(text,kind))return false;
  await this.onPrompt({kind,live_prompt:text,trigger:'judge',judge_event:{type:event.type,phrase:event.phrase,at:event.at}});return true;
 }
 async depart(source={trigger:'manual'}){await this.goodbye(source);this.timers.push(this.schedule(()=>this.close('party departed'),8000));}
 async observe(image,decision){
  const at=image?.at,now=this.now();
  if(!Number.isFinite(at)||now-at>10000||at>now||!Number.isInteger(decision?.visitor_count))return; // unusable reads never reset absence
  if(this.lastObservation!==null&&at<=this.lastObservation)return;
  this.lastObservation=at;
  if(decision.visitor_count===0){this.absentSince??=at;if(at-this.absentSince>=30000&&decision.absence_close!==false){await this.close('thirty seconds without visitors');this.locked=false;}return;}
  this.absentSince=null;
  if(!this.active){
   if(this.locked)return;
   // Sidewalk people count as present (absence is reset above) but never start Live; only PATH does.
   const onPath=decision.group_state?decision.group_state==='PATH':['path','porch'].includes(decision.visitor_location);
   if(!onPath)return;
   const labels=(decision.costume_slots||[]).filter(slot=>slot.confidence>=0.85&&!unsafe.test(slot.label)&&!['uncertain','unknown','other_costume','not_visible'].includes(slot.label)).slice(0,2).map(slot=>slot.label);
   const welcome=welcomePromptFor({partySize:decision.visitor_count,groupState:decision.group_state||'PATH',hour:new Date(now).getHours(),costumeLabels:labels,rng:this.rng,improv:this.improv});
   await this.begin(welcome,{trigger:'decisions',decision_response:decision.audit||null});if(!this.active)return;
  }else if(this.starting)return;
  if(this.sent.has('goodbye')||this.costumeRequested)return;
  const slots=(decision.costume_slots||[]).slice(0,3).filter(slot=>slot.confidence>=0.85&&!unsafe.test(slot.label)&&!['uncertain','unknown','other_costume','not_visible'].includes(slot.label));
  const key=slots.length?slots.map(slot=>slot.label).sort().join('|'):null;
  if(key&&key===this.costumeKey)this.costumeReads++;else{this.costumeKey=key;this.costumeReads=key?1:0;}
  if(this.costumeReads<2&&decision.visitor_location!=='porch')return;
  this.costumeRequested=true;const serial=this.serial;
  const question=costumeQuestion({rng:this.rng,improv:this.improv}).text;
  const fallback=safeVoiceText('Costume details. Costume unclear; do not guess. Improvise one short dry line (comedic angle: '+angleBrief({rng:this.rng,improv:this.improv}).theme+') then ask: "'+question+'" Then WAIT for the guest response. Keep the conversation open; do not repeat answered questions or add a goodbye.');
  // A video-capable backend (Gemini) sees the guests itself: skip the costume describe call and only cue it. Judge labels stay as hints.
  if(this.voice.seesCostumes?.()){const hint=slots.length?' Vision hint (uncertain, the guests\' words win): '+slots.map(slot=>slot.label).join(', ')+'.':'';const cue=safeVoiceText('Costume details. Look at the guests on the camera now and make one short dry line about the costumes you can really see (comedic angle: '+angleBrief({rng:this.rng,improv:this.improv}).theme+'), then ask: "'+question+'" If no costume is clear, do not guess.'+hint+' Then WAIT for the guest response. Do not repeat answered questions or add a goodbye.');if(this.active&&serial===this.serial&&!this.sent.has('goodbye'))await this.prompt('costume',cue||fallback,{trigger:'decisions',decision_response:decision.audit||null});return;}
  try{const description=await this.describe(image,decision,slots);if(this.active&&serial===this.serial&&!this.sent.has('goodbye'))await this.prompt('costume',safeVoiceText(description)||fallback,{trigger:'decisions',decision_response:decision.audit||null});}catch{if(this.active&&serial===this.serial&&!this.sent.has('goodbye'))await this.prompt('costume',fallback,{trigger:'decisions',decision_response:decision.audit||null});}
 }
}
