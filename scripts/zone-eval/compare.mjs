#!/usr/bin/env node
// Offline comparison: who is more reliable at "a real person is inside the area of interest (path + porch)": the YOLOX detector or the gpt Judge?
// Reads only NDJSON/JSON (no images, no network, no API calls).
//
//   node scripts/zone-eval/compare.mjs --yolo yolo-zones.ndjson --data data --truth truth.ndjson [--yolo-cutoff 0.4] [--json]
//   node scripts/zone-eval/compare.mjs --yolo yolo-zones.ndjson --data data --candidates [--max 400] [--seed 1] > sample.ndjson
//
// truth lines: {"key":"j:2026-10-26/abc","person_in_area":"yes"|"no"|"unsure","count_in_area":1,"notes":""}  (unsure is skipped)
// Judge "in area": real_people_count >= 1 AND closest_person_location in {path, porch}. An uncertain count/location is an abstention (n/a).
// Judge "persons" variant: any person_N_location in {path, porch}; none present = n/a.
// Combined rules fall back to YOLO alone when the Judge abstains: and, or, tiebreak (confident Judge else YOLO).
import {readFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CUTOFFS} from '../../src/presence/decisions.mjs';

export const AREA=['path','porch'];
const num=v=>typeof v==='number'&&Number.isFinite(v);
export const readNdjson=async f=>{const t=await readFile(f,'utf8');return t.split('\n').filter(l=>l.trim()).map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(Boolean);};

// ---------- YOLO ----------
// Re-derive counts at an arbitrary score cutoff from the raw boxes (boxes carry zone + ignored from yolo_zones.py).
export function yoloCounts(rec,cutoff=0.4){
 const live=(rec.boxes||[]).filter(b=>!b.ignored&&b.score>=cutoff);
 return {in_area:live.filter(b=>AREA.includes(b.zone)).length,on_sidewalk:live.filter(b=>b.zone==='sidewalk').length,total:live.length};
}
export const yoloSays=(rec,cutoff=0.4)=>rec&&!rec.error?(yoloCounts(rec,cutoff).in_area>=1?'yes':'no'):null;

// ---------- Judge ----------
const ans=(answers,name)=>(answers||[]).find(a=>a&&a.name===name)||null;
const countYes=c=>c==null||c==='uncertain'?null:(c==='0'?false:true);
// -> {count, count_conf, loc, loc_conf, persons:[{loc,conf}], errored}
export function judgeFields(answers,error=null){
 const c=ans(answers,'real_people_count'),l=ans(answers,'closest_person_location');
 const persons=[];
 for(let n=1;n<=6;n++){const p=ans(answers,`person_${n}_location`);if(p)persons.push({loc:p.choice==null?null:String(p.choice),conf:p.confidence});}
 return {count:c?.choice==null?null:String(c.choice),count_conf:c?.confidence,loc:l?.choice==null?null:String(l.choice),loc_conf:l?.confidence,persons,errored:Boolean(error)};
}
// minConf: both the count and the location answer must reach it, otherwise abstain (null).
export function judgeSays(f,{minConf=0}={}){
 if(!f)return null;
 const cy=countYes(f.count);if(cy==null)return null;
 if(minConf>0&&!(num(f.count_conf)&&f.count_conf>=minConf))return null;
 if(!cy)return 'no';
 if(f.loc==null||f.loc==='uncertain')return null;
 if(minConf>0&&!(num(f.loc_conf)&&f.loc_conf>=minConf))return null;
 return AREA.includes(f.loc)?'yes':'no';
}
export function judgePersonsSays(f,{minConf=0}={}){
 if(!f||!f.persons.length)return null;
 const ps=f.persons.filter(p=>p.loc&&p.loc!=='not_visible'&&p.loc!=='uncertain'&&p.loc!=='none'&&(!minConf||(num(p.conf)&&p.conf>=minConf)));
 if(ps.some(p=>AREA.includes(p.loc)))return 'yes';
 return ps.length||f.persons.some(p=>p.loc==='not_visible')?'no':null;
}
export const judgeConfident=f=>Boolean(f)&&!f.errored&&f.count!=null&&f.count!=='uncertain'&&num(f.count_conf)&&f.count_conf>=CUTOFFS.count;

// ---------- loading Judge answers for the yolo keys ----------
export async function loadJudgeFor(dataDir,keys){
 const out=new Map(),jl=join(dataDir,'judge-log'),cdir=join(dataDir,'captures');
 const clipIdx=new Map(); // clip_id -> dir, built lazily
 const buildClips=async()=>{
  if(clipIdx.size)return;
  let days=[];try{days=await readdir(cdir);}catch{return;}
  for(const d of days){if(!/^\d{4}-\d{2}-\d{2}$/.test(d))continue;let cs=[];try{cs=await readdir(join(cdir,d));}catch{continue;}for(const c of cs)clipIdx.set(c,join(cdir,d,c));}
 };
 const clipJudge=new Map();
 for(const key of keys){
  if(key.startsWith('j:')){
   const k=key.slice(2);if(k.includes('..'))continue;
   try{const e=JSON.parse(await readFile(join(jl,k+'.json'),'utf8'));out.set(key,judgeFields(e.answers,e.error||e.judges?.presence?.error));}catch{}
  }else{
   const m=key.match(/^c:([A-Za-z0-9_-]{1,64}):(\d{1,9})$/);if(!m)continue;
   await buildClips();const dir=clipIdx.get(m[1]);if(!dir)continue;
   if(!clipJudge.has(m[1])){const byIdx=new Map();try{for(const l of (await readFile(join(dir,'judge.jsonl'),'utf8')).split('\n')){if(!l.trim())continue;try{const j=JSON.parse(l);if(j.judge==='presence'&&j.frame_index!=null)byIdx.set(j.frame_index,j);}catch{}}}catch{}clipJudge.set(m[1],byIdx);}
   const j=clipJudge.get(m[1]).get(Number(m[2]));if(j)out.set(key,judgeFields(j.answers,j.error));
  }
 }
 return out;
}

// ---------- metrics ----------
// pairs: [{key,pred:'yes'|'no'|null,truth:'yes'|'no'}]
export function metrics(pairs){
 const m={n:0,abstain:0,tp:0,fp:0,fn:0,tn:0,disagree:[]};
 for(const p of pairs){
  if(p.pred==null){m.abstain++;continue;}
  m.n++;const pred=p.pred==='yes',act=p.truth==='yes';
  if(pred&&act)m.tp++;else if(pred){m.fp++;m.disagree.push(p.key);}else if(act){m.fn++;m.disagree.push(p.key);}else m.tn++;
 }
 const r=x=>Math.round(x*1000)/1000;
 m.precision=m.tp+m.fp?r(m.tp/(m.tp+m.fp)):null;m.recall=m.tp+m.fn?r(m.tp/(m.tp+m.fn)):null;m.accuracy=m.n?r((m.tp+m.tn)/m.n):null;
 return m;
}
export const combine={
 and:(y,j)=>j==null?y:(y==null?j:(y==='yes'&&j==='yes'?'yes':'no')),
 or:(y,j)=>j==null?y:(y==null?j:(y==='yes'||j==='yes'?'yes':'no')),
 tiebreak:(y,j,conf)=>conf&&j!=null?j:y
};
export const range=(a,b,s)=>{const o=[];for(let v=a;v<=b+1e-9;v+=s)o.push(Math.round(v*1000)/1000);return o;};

export function evaluate({yolo,judge,truth,yoloCutoff=0.4}){
 const rows=[];
 for(const rec of yolo){const t=truth.get(rec.key);if(!t||(t!=='yes'&&t!=='no'))continue;rows.push({key:rec.key,rec,j:judge.get(rec.key)||null,truth:t});}
 const P=fn=>rows.map(r=>({key:r.key,truth:r.truth,pred:fn(r)}));
 const y=r=>yoloSays(r.rec,yoloCutoff),j=r=>judgeSays(r.j),conf=r=>judgeConfident(r.j);
 const out={rows:rows.length,with_judge:rows.filter(r=>r.j).length,yolo_cutoff:yoloCutoff,methods:{},yolo_sweep:[],judge_conf_sweep:[]};
 out.methods.yolo=metrics(P(y));
 out.methods.judge=metrics(P(j));
 out.methods.judge_persons=metrics(P(r=>judgePersonsSays(r.j)));
 out.methods.yolo_and_judge=metrics(P(r=>combine.and(y(r),j(r))));
 out.methods.yolo_or_judge=metrics(P(r=>combine.or(y(r),j(r))));
 out.methods.tiebreak=metrics(P(r=>combine.tiebreak(y(r),j(r),conf(r))));
 for(const c of range(0.3,0.8,0.05)){const m=metrics(P(r=>yoloSays(r.rec,c)));out.yolo_sweep.push({cutoff:c,...m,disagree:undefined});}
 for(const c of [0,0.5,0.6,0.7,0.75,0.8,0.85,0.9,0.95]){const m=metrics(P(r=>judgeSays(r.j,{minConf:c})));out.judge_conf_sweep.push({min_conf:c,...m,disagree:undefined});}
 return out;
}

// ---------- candidates (no truth) ----------
export function rng(seed){let s=(seed>>>0)||123456789;return()=>{s^=s<<13;s>>>=0;s^=s>>>17;s^=s<<5;s>>>=0;return s/4294967296;};}
export function candidates({yolo,judge,yoloCutoff=0.4,max=400,seed=1,emptySample=150}){
 const dis=[],pos=[],empty=[];
 for(const rec of yolo){
  if(rec.error)continue;
  const jf=judge.get(rec.key)||null,yc=yoloCounts(rec,yoloCutoff),ys=yc.in_area>=1?'yes':'no',js=judgeSays(jf),side=yc.on_sidewalk>=1||jf?.loc==='sidewalk';
  const row={key:rec.key,source:rec.source,captured_at:rec.captured_at,yolo_in_area:yc.in_area,yolo_on_sidewalk:yc.on_sidewalk,judge_in_area:js,judge_closest:jf?.loc??null,judge_count:jf?.count??null};
  if(js!=null&&js!==ys)dis.push({...row,why:'disagree'});
  else if(ys==='yes'||js==='yes'||side)pos.push({...row,why:ys==='yes'||js==='yes'?'in_area':'sidewalk'});
  else empty.push({...row,why:'both_empty'});
 }
 const rand=rng(seed),sh=[...empty];
 for(let i=sh.length-1;i>0;i--){const k=Math.floor(rand()*(i+1));[sh[i],sh[k]]=[sh[k],sh[i]];}
 return [...dis,...pos,...sh.slice(0,emptySample)].slice(0,max);
}

// ---------- CLI ----------
export function parseArgs(argv){
 const o={yolo:null,data:'data',truth:null,candidates:false,max:400,seed:1,yoloCutoff:0.4,json:false};
 const need=i=>{if(i+1>=argv.length)throw new Error('Missing value for '+argv[i]);return argv[i+1];};
 for(let i=0;i<argv.length;i++){
  const a=argv[i];
  if(a==='--yolo')o.yolo=resolve(need(i++));else if(a==='--data')o.data=resolve(need(i++));else if(a==='--truth')o.truth=resolve(need(i++));
  else if(a==='--max')o.max=Number(need(i++));else if(a==='--seed')o.seed=Number(need(i++));else if(a==='--yolo-cutoff')o.yoloCutoff=Number(need(i++));
  else if(a==='--candidates')o.candidates=true;else if(a==='--json')o.json=true;else throw new Error('Unknown argument: '+a);
 }
 if(!o.yolo)throw new Error('--yolo <file> is required');
 if(!o.candidates&&!o.truth)throw new Error('--truth <file> is required (or use --candidates)');
 if(!(o.max>=1))throw new Error('--max must be >= 1');
 return o;
}
const pct=v=>v==null?'n/a':(v*100).toFixed(1)+'%';
const fmt=(name,m)=>`${name.padEnd(16)} n=${String(m.n).padStart(4)} abstain=${String(m.abstain).padStart(3)} TP=${m.tp} FP=${m.fp} FN=${m.fn} TN=${m.tn} precision=${pct(m.precision)} recall=${pct(m.recall)} accuracy=${pct(m.accuracy)}`;
export function format(r){
 const o=[`Labeled frames with a YOLO record: ${r.rows} (with Judge answers: ${r.with_judge}); YOLO cutoff ${r.yolo_cutoff}`,'', 'Methods (positive = a real person in path/porch; abstentions excluded from n):'];
 for(const [k,m] of Object.entries(r.methods))o.push('  '+fmt(k,m));
 o.push('','Disagreements with truth (FP/FN keys):');
 for(const [k,m] of Object.entries(r.methods))o.push(`  ${k}: ${m.disagree.length?m.disagree.join(' '):'-'}`);
 o.push('','YOLO score-cutoff sweep:');for(const m of r.yolo_sweep)o.push('  '+fmt('cutoff '+m.cutoff.toFixed(2),m));
 o.push('','Judge confidence-cutoff sweep (below the cutoff = abstain):');for(const m of r.judge_conf_sweep)o.push('  '+fmt('conf>='+m.min_conf,m));
 return o.join('\n');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const o=parseArgs(process.argv.slice(2));
  const yolo=await readNdjson(o.yolo),judge=await loadJudgeFor(o.data,yolo.map(r=>r.key));
  if(o.candidates){for(const c of candidates({yolo,judge,yoloCutoff:o.yoloCutoff,max:o.max,seed:o.seed}))console.log(JSON.stringify(c));}
  else{
   const truth=new Map();for(const l of await readNdjson(o.truth))if(l.key&&(l.person_in_area==='yes'||l.person_in_area==='no'))truth.set(l.key,l.person_in_area);
   const r=evaluate({yolo,judge,truth,yoloCutoff:o.yoloCutoff});
   console.log(o.json?JSON.stringify(r,null,1):format(r));
  }
 }catch(e){console.error(e.message);process.exit(1);}
}
