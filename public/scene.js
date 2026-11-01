export function sceneContext(scene,now=Date.now()) {
 if(!scene||now-scene.captured_at>30000)return 'Camera unavailable or stale. Do not claim to see visitors or costumes. Default to child-friendly conversation.';
 return scene.speech_context||'Current scene context unavailable; do not invent visitors or costume details.';
}
export class GreetingGate {
 constructor(){this.last=0;this.empty=2;this.present=false;}
 update(scene,now=Date.now()) {if(now-scene.captured_at>30000)return false;if(!scene.people_visible){this.empty++;if(this.empty>=2)this.present=false;return false;}this.empty=0;const greet=!this.present&&now-this.last>=45000;this.present=true;if(greet)this.last=now;return greet;}
}

export class AbsenceGate {
 constructor(duration=30000){this.duration=duration;this.since=null;this.last=null;}
 reset(){this.since=null;this.last=null;}
 update(scene,now=Date.now()){
  if(!scene||!Number.isFinite(scene.captured_at)||now-scene.captured_at>30000||scene.captured_at>now||!Number.isInteger(scene.visitor_count)||scene.visitor_count<0||scene.people_visible!==(scene.visitor_count>0)){this.reset();return false;}
  if(scene.visitor_count>0){this.reset();return false;}
  // Cached results cannot advance the absence window. A missed/error observation resets it.
  if(this.last!==null&&scene.captured_at<=this.last)return false;
  if(this.last!==null&&scene.captured_at-this.last>25000)this.since=null;
  this.since??=scene.captured_at;this.last=scene.captured_at;
  return scene.captured_at-this.since>=this.duration;
 }
}
