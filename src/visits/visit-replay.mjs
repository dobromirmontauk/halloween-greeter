// Re-run the CURRENT presence tracker over a visit's saved per-frame boxes, so old clips (recorded before tracker fixes, e.g. the double-count bug, and before
// per-box track/v/dir existed) show the timelines the current logic would produce. Pure; the same idea as scripts/visit-eval/replay.mjs, shaped for the /visits.html player.
import {createPresenceTracker,trackerOptions} from '../presence/presence-tracker.mjs';

export function replayMeta(meta,{env=process.env,presenceScore=meta.presence_score??0.5}={}){
  const opts=trackerOptions(env),tracker=createPresenceTracker(opts),zones=meta.zones||[];
  const timeline=[],counts=[],detections=[];
  for(const d of meta.detections||[]){
    const persons=[],fed=new Map();
    (d.boxes||[]).forEach((b,i)=>{if(!b.ignored&&!b.suppressed&&!b.weak&&b.s>=presenceScore){const p={bbox:b.b,score:b.s};fed.set(i,p);persons.push(p);}});
    const side=(d.boxes||[]).filter(b=>b.zone==='sidewalk'&&!b.ignored&&!b.suppressed&&b.s>=0.35&&(b.src==='band'||(b.weak&&b.s<presenceScore))).map(b=>({bbox:b.b,score:b.s}));
    const g=tracker.update(persons,d.t,zones,[],side);
    if(!timeline.length||timeline.at(-1).state!==g.state)timeline.push({t:d.t,state:g.state,count:g.state==='EMPTY'?0:g.count});
    const shown=g.state==='EMPTY'?0:g.count; // the debounced state decides whether anybody is "there"; no count while EMPTY
    if(!counts.length||counts.at(-1).count!==shown)counts.push({t:d.t,count:shown});
    detections.push({...d,boxes:(d.boxes||[]).map((b,i)=>{
      const {track,v,dir,...rest}=b,p=fed.get(i);
      return p?{...rest,track:p.track,v:p.v,dir:p.dir}:rest;
    })});
  }
  return {replayed:true,tracker:opts,initial_state:'EMPTY',timeline,counts,detections};
}
