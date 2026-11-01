#!/usr/bin/env node
// Re-run presence-tracker.mjs over the saved per-frame boxes with other tuning; no new visitors needed.
//   node scripts/visit-eval/replay.mjs --dir data/visits [--GROUP_ENTER_MS_PATH=1000 ...] [--DETECTOR_PRESENCE_SCORE=0.6] [--truth truth.ndjson] [--sweep] [--top 15] [--json]
// Without --sweep: prints each clip's replayed timeline next to the live one (and scores with --truth). With --sweep: a small grid of enter/exit/hold values ranked by mean IoU (SIDEWALK, PATH) then flaps (needs --truth), else by transition count.
import {loadVisits,loadTruth,joinTruth,scoreAll,replayClip,optsFromFlags,gridOpts,parseArgs} from './lib.mjs';
import {printReport} from './report.mjs';
const a=parseArgs(process.argv.slice(2)),visits=loadVisits(a.dir||'data/visits'),base=optsFromFlags(a);
const score=a.DETECTOR_PRESENCE_SCORE!==undefined?Number(a.DETECTOR_PRESENCE_SCORE):undefined;
const truth=a.truth?loadTruth(a.truth):null;
const fmt=tl=>tl.map(e=>`${(e.t/1000).toFixed(1)}s ${e.state}`).join(' > ');
if(!a.sweep){
  const re=new Map(visits.map(v=>[v.id,replayClip(v,base,score)]));
  if(!a.json)for(const v of visits)console.log(`${v.id}\n  live   ${fmt(v.timeline)}\n  replay ${fmt(re.get(v.id))}`);
  if(truth){const r=scoreAll(joinTruth(visits,truth,v=>re.get(v.id)));if(a.json)console.log(JSON.stringify({replay:r},null,1));else{console.log('');printReport(r,'Replay vs truth');}}
  else if(a.json)console.log(JSON.stringify([...re].map(([id,tl])=>({id,timeline:tl})),null,1));
}else{
  const rows=[];let n=0;
  for(const o of gridOpts()){
    if(++n>2000)break;
    const opts={...base,...o},re=new Map(visits.map(v=>[v.id,replayClip(v,opts,score)]));
    const row={opts:o,transitions:[...re.values()].reduce((s,t)=>s+Math.max(0,t.length-1),0)};
    if(truth){const r=scoreAll(joinTruth(visits,truth,v=>re.get(v.id)));row.flaps=r.flaps;row.iou_sidewalk=r.states.SIDEWALK.iou;row.iou_path=r.states.PATH.iou;row.path_recall=r.path_events.recall;row.path_false=r.path_events.false_pred;row.score=((r.states.SIDEWALK.iou||0)+(r.states.PATH.iou||0))/2;}
    rows.push(row);
  }
  rows.sort(truth?(x,y)=>y.score-x.score||x.flaps-y.flaps:(x,y)=>x.transitions-y.transitions);
  const top=rows.slice(0,Number(a.top)||15);
  if(a.json)console.log(JSON.stringify(top,null,1));
  else for(const r of top)console.log(Object.entries(r.opts).map(([k,v])=>`${k}=${v}`).join(' ')+'  '+Object.entries(r).filter(([k])=>k!=='opts').map(([k,v])=>`${k}=${typeof v==='number'?Math.round(v*1000)/1000:v}`).join(' '));
}
