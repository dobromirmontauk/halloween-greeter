#!/usr/bin/env node
// Replay check for the Presence resolvers. NO API calls, no images read: it only reads judge-log entry JSON, labels.jsonl (human) and
// ai_labels.jsonl (AI), and scores three strategies against those labels.
//
//   node scripts/tiebreak-eval.mjs [--dir data/judge-log] [--json]
//   on the device:  cd ~/halloween-greeter && node scripts/tiebreak-eval.mjs --dir data/judge-log
//   (or copy the directory off the box, without the .jpg files if you like, and pass --dir to the copy)
//
// Strategies (people yes/no per read; a strategy may abstain):
//   judge     the Judge's winning count (>=1 = yes) even when below the 0.75 cutoff; "uncertain"/missing = abstain.
//             This is the "winner of 1 is false 63% of the time" view from the AI-label evidence.
//   tiebreak  confident Judge (>= cutoff, no error) as is; otherwise the detector count logged with the read (>=1 yes, 0 no);
//             no detector count = abstain (today's uncertain behavior).
//   primary   the detector count alone; no detector count = abstain.
// Truth: the human label when it says yes/no, else the AI consensus when every decisive AI label agrees. Reported separately.
// Most older reads have NO detector count (that persistence is recent), so "usable" counts are printed first and each strategy is also
// scored on the usable subset (reads that have a detector count), which is the only apples-to-apples comparison.
import {readFile,readdir} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CUTOFFS} from '../src/presence/decisions.mjs';
import {latestAiLabels,aiConsensus} from '../src/presence/ai-labels.mjs';
import {peopleLabel} from '../src/server/review-reads.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const num=v=>Number.isFinite(v);
const lines=async f=>{let t='';try{t=await readFile(f,'utf8');}catch{return [];}return t.split('\n').filter(l=>l.trim()).map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(Boolean);};

export async function loadEntries(dir){
 const out=[];let days=[];
 try{days=await readdir(dir);}catch{return out;}
 for(const day of days.sort()){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day))continue;
  let files=[];try{files=await readdir(join(dir,day));}catch{continue;}
  for(const f of files.sort()){if(!f.endsWith('.json'))continue;try{const e=JSON.parse(await readFile(join(dir,day,f),'utf8'));if(e&&e.read_key)out.push(e);}catch{}}
 }
 return out;
}
export async function loadLabels(dir){
 const human=new Map();
 for(const l of await lines(join(dir,'labels.jsonl'))){if(!l.read_key)continue;if(l.cleared)human.delete(l.read_key);else human.set(l.read_key,l);}
 return {human,ai:latestAiLabels(await lines(join(dir,'ai_labels.jsonl')))};
}

// One entry -> {judge, confident, detector, human, ai, uncertain} with yes/no/null values.
export function describeEntry(entry,{human,ai}){
 const a=(entry.answers||[]).find(x=>x&&x.name==='real_people_count');
 const winner=a?.choice==null?null:String(a.choice);
 const errored=Boolean(entry.error||entry.judges?.presence?.error);
 const confident=!errored&&winner!=null&&winner!=='uncertain'&&num(a.confidence)&&a.confidence>=CUTOFFS.count;
 const judge=winner==null||winner==='uncertain'?null:(winner==='0'?'no':'yes');
 const dc=entry.detector?.count;
 const detector=num(dc)?(dc>=1?'yes':'no'):null;
 const h=peopleLabel(human.get(entry.read_key)),humanLabel=h==='yes'||h==='no'?h:null;
 const labs=ai.get('j:'+entry.read_key);
 const c=labs?aiConsensus(Object.fromEntries(Object.entries(labs).map(([k,v])=>[k,{people_present:v.people_present}]))):null;
 return {judge,confident,detector,human:humanLabel,ai:c==='yes'||c==='no'?c:null,uncertain:!confident};
}
export const STRATEGIES={
 judge:d=>d.judge,
 tiebreak:d=>d.confident?d.judge:d.detector,
 primary:d=>d.detector
};
const blank=()=>({n:0,correct:0,wrong:0,abstain:0,false_yes:0,false_no:0});
function score(rows,truthKey,only=()=>true){
 const out={};for(const s of Object.keys(STRATEGIES))out[s]=blank();
 for(const d of rows){
  const t=d[truthKey];if(!t||!only(d))continue;
  for(const [s,fn] of Object.entries(STRATEGIES)){
   const m=out[s],p=fn(d);m.n++;
   if(p==null)m.abstain++;else if(p===t)m.correct++;else{m.wrong++;if(p==='yes')m.false_yes++;else m.false_no++;}
  }
 }
 for(const m of Object.values(out))m.accuracy=m.n-m.abstain?Math.round(1000*m.correct/(m.n-m.abstain))/1000:null; // over the reads the strategy answered
 return out;
}
export function evaluate(entries,labels){
 const rows=entries.map(e=>describeEntry(e,labels));
 const usable=rows.filter(d=>d.detector!=null);
 const has=d=>d.detector!=null,hasU=d=>d.detector!=null&&d.uncertain;
 return {
  reads:rows.length,with_detector_count:usable.length,with_human_label:rows.filter(d=>d.human).length,with_ai_label:rows.filter(d=>d.ai).length,
  usable_with_human:usable.filter(d=>d.human).length,usable_with_ai:usable.filter(d=>d.ai).length,
  uncertain_reads:rows.filter(d=>d.uncertain).length,usable_uncertain:usable.filter(d=>d.uncertain).length,
  vs_ai:{all:score(rows,'ai'),usable:score(rows,'ai',has),usable_uncertain_only:score(rows,'ai',hasU)},
  vs_human:{all:score(rows,'human'),usable:score(rows,'human',has),usable_uncertain_only:score(rows,'human',hasU)}
 };
}
const fmt=m=>`n=${m.n} answered=${m.n-m.abstain} correct=${m.correct} wrong=${m.wrong} (false_yes ${m.false_yes}, false_no ${m.false_no}) abstain=${m.abstain} accuracy=${m.accuracy==null?'n/a':(m.accuracy*100).toFixed(1)+'%'}`;
export function format(r){
 const o=[`Reads: ${r.reads}; with a detector count: ${r.with_detector_count} (usable); uncertain/errored Judge reads: ${r.uncertain_reads} (${r.usable_uncertain} usable)`,
  `Labels: human ${r.with_human_label} (${r.usable_with_human} usable), AI ${r.with_ai_label} (${r.usable_with_ai} usable)`];
 if(!r.with_detector_count)o.push('NO read has a detector count yet: tiebreak and primary cannot be scored. Re-run after more reads are logged.');
 for(const [who,block] of [['AI labels',r.vs_ai],['Human labels',r.vs_human]])
  for(const [part,title] of [['all','all labeled reads'],['usable','reads with a detector count'],['usable_uncertain_only','uncertain reads with a detector count']]){
   o.push('',`${who}, ${title}:`);for(const [s,m] of Object.entries(block[part]))o.push(`  ${s.padEnd(9)} ${fmt(m)}`);
  }
 return o.join('\n');
}
export function parseArgs(argv){
 const o={dir:resolve(process.env.JUDGE_LOG_DIR||join(root,'data','judge-log')),json:false};
 for(let i=0;i<argv.length;i++){const a=argv[i];if(a==='--dir'){if(i+1>=argv.length)throw new Error('Missing value for --dir');o.dir=resolve(argv[++i]);}else if(a==='--json')o.json=true;else throw new Error('Unknown argument: '+a);}
 return o;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const o=parseArgs(process.argv.slice(2));
  const r=evaluate(await loadEntries(o.dir),await loadLabels(o.dir));
  console.log(o.json?JSON.stringify(r,null,1):format(r));
 }catch(e){console.error(e.message);process.exit(1);}
}
