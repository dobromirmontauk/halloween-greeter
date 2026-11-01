#!/usr/bin/env node
// Sample points for a labeler: NDJSON {clip,t,key} at --fps (default 1) per visit clip. Fetch the image with GET /api/visits/<clip>/frame?t=<t> (no image is written to disk).
// node scripts/visit-eval/frames.mjs --dir data/visits [--fps 1]
import {loadVisits,parseArgs} from './lib.mjs';
const a=parseArgs(process.argv.slice(2)),fps=Math.min(10,Math.max(0.1,Number(a.fps)||1)),step=1000/fps,MAX=20000;
let n=0;
for(const v of loadVisits(a.dir||'data/visits')){
  const end=v.video_ms||v.end_ms||0;
  for(let t=0;t<end&&n<MAX;t+=step,n++)process.stdout.write(JSON.stringify({clip:v.id,t:Math.round(t),key:`${v.id}@${Math.round(t)}`})+'\n');
}
