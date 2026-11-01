import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {yoloCounts,yoloSays,judgeFields,judgeSays,judgePersonsSays,metrics,evaluate,candidates,loadJudgeFor,parseArgs,combine} from '../scripts/zone-eval/compare.mjs';

const box=(zone,score=0.9,ignored=false)=>({bbox:[0,0,1,1],score,zone,ignored});
const A=(count,cc,loc,lc)=>[{name:'real_people_count',choice:count,confidence:cc},{name:'closest_person_location',choice:loc,confidence:lc}];

test('yoloCounts honours cutoff, ignored boxes and sidewalk',()=>{
 const rec={boxes:[box('path',0.9),box('porch',0.45),box('sidewalk',0.9),box('path',0.95,true),box('other',0.9)]};
 assert.deepEqual(yoloCounts(rec,0.4),{in_area:2,on_sidewalk:1,total:4});
 assert.equal(yoloCounts(rec,0.5).in_area,1);
 assert.equal(yoloSays({boxes:[box('sidewalk')]}),'no');
 assert.equal(yoloSays({boxes:[box('path',0.9,true)]}),'no');
 assert.equal(yoloSays({error:'x'}),null);
});

test('judge in-area rule and abstentions',()=>{
 assert.equal(judgeSays(judgeFields(A('1',0.9,'path',0.9))),'yes');
 assert.equal(judgeSays(judgeFields(A('2',0.9,'porch',0.9))),'yes');
 assert.equal(judgeSays(judgeFields(A('1',0.9,'sidewalk',0.9))),'no');
 assert.equal(judgeSays(judgeFields(A('0',0.9,'none',0.9))),'no');
 assert.equal(judgeSays(judgeFields(A('uncertain',0.3,'none',0.3))),null);
 assert.equal(judgeSays(judgeFields(A('1',0.9,'uncertain',0.3))),null);
 assert.equal(judgeSays(judgeFields(A('1',0.6,'path',0.9)),{minConf:0.75}),null);
 const f=judgeFields([...A('2',0.9,'sidewalk',0.9),{name:'person_1_location',choice:'porch',confidence:0.9},{name:'person_2_location',choice:'sidewalk',confidence:0.9}]);
 assert.equal(judgeSays(f),'no');assert.equal(judgePersonsSays(f),'yes');
 assert.equal(judgePersonsSays(judgeFields(A('1',0.9,'path',0.9))),null);
});

test('metrics counts the confusion matrix and lists disagreements',()=>{
 const m=metrics([{key:'a',pred:'yes',truth:'yes'},{key:'b',pred:'yes',truth:'no'},{key:'c',pred:'no',truth:'yes'},{key:'d',pred:'no',truth:'no'},{key:'e',pred:null,truth:'yes'}]);
 assert.deepEqual([m.n,m.abstain,m.tp,m.fp,m.fn,m.tn],[4,1,1,1,1,1]);
 assert.equal(m.precision,0.5);assert.equal(m.recall,0.5);assert.equal(m.accuracy,0.5);
 assert.deepEqual(m.disagree,['b','c']);
});

test('combine rules fall back to YOLO when the Judge abstains',()=>{
 assert.equal(combine.and('yes',null),'yes');assert.equal(combine.and('yes','no'),'no');assert.equal(combine.or('no','yes'),'yes');
 assert.equal(combine.tiebreak('yes','no',true),'no');assert.equal(combine.tiebreak('yes','no',false),'yes');
});

function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'ze-'));
 mkdirSync(join(dir,'judge-log','2026-10-26'),{recursive:true});mkdirSync(join(dir,'captures','2026-10-26','clip1'),{recursive:true});
 const put=(id,answers)=>writeFileSync(join(dir,'judge-log','2026-10-26',id+'.json'),JSON.stringify({read_key:'2026-10-26/'+id,answers}));
 put('a',A('1',0.95,'path',0.95));put('b',A('1',0.95,'sidewalk',0.95));put('c',A('0',0.95,'none',0.95));put('d',A('1',0.95,'path',0.95));
 writeFileSync(join(dir,'captures','2026-10-26','clip1','judge.jsonl'),JSON.stringify({judge:'presence',frame_index:7,answers:A('1',0.9,'porch',0.9)})+'\n');
 return dir;
}
const yrec=(key,...boxes)=>({key,source:key.startsWith('j:')?'judge':'capture',boxes});

test('loadJudgeFor reads judge-log sidecars and clip judge.jsonl',async()=>{
 const dir=fixture();
 const m=await loadJudgeFor(dir,['j:2026-10-26/a','c:clip1:7','c:clip1:8','j:2026-10-26/zzz']);
 assert.equal(m.size,2);assert.equal(judgeSays(m.get('j:2026-10-26/a')),'yes');assert.equal(judgeSays(m.get('c:clip1:7')),'yes');
});

test('evaluate and candidates on synthetic data',async()=>{
 const dir=fixture();
 const yolo=[yrec('j:2026-10-26/a',box('path')),yrec('j:2026-10-26/b',box('sidewalk')),yrec('j:2026-10-26/c'),yrec('j:2026-10-26/d',box('sidewalk')),yrec('c:clip1:7',box('porch'))];
 const judge=await loadJudgeFor(dir,yolo.map(r=>r.key));
 const truth=new Map([['j:2026-10-26/a','yes'],['j:2026-10-26/b','no'],['j:2026-10-26/c','no'],['j:2026-10-26/d','yes'],['c:clip1:7','yes']]);
 const r=evaluate({yolo,judge,truth});
 assert.equal(r.rows,5);
 assert.deepEqual([r.methods.yolo.tp,r.methods.yolo.fn,r.methods.yolo.fp,r.methods.yolo.tn],[2,1,0,2]);
 assert.deepEqual([r.methods.judge.tp,r.methods.judge.fn,r.methods.judge.fp,r.methods.judge.tn],[3,0,0,2]);
 assert.deepEqual(r.methods.yolo.disagree,['j:2026-10-26/d']);
 assert.equal(r.yolo_sweep.length,11);
 const cand=candidates({yolo,judge,max:400,seed:3,emptySample:150});
 assert.equal(cand[0].key,'j:2026-10-26/d');assert.equal(cand[0].why,'disagree');
 assert.equal(cand.length,5);
 assert.equal(candidates({yolo,judge,max:2}).length,2);
 assert.equal(candidates({yolo,judge,emptySample:0}).some(c=>c.why==='both_empty'),false);
 // deterministic with a seed
 assert.deepEqual(candidates({yolo,judge,seed:5}),candidates({yolo,judge,seed:5}));
});

test('parseArgs validates; CLI end to end',()=>{
 assert.throws(()=>parseArgs([]),/--yolo/);assert.throws(()=>parseArgs(['--yolo','x']),/--truth/);assert.throws(()=>parseArgs(['--yolo','x','--bogus']),/Unknown/);
 const dir=fixture(),yf=join(dir,'y.ndjson'),tf=join(dir,'t.ndjson');
 writeFileSync(yf,[yrec('j:2026-10-26/a',box('path')),yrec('j:2026-10-26/c')].map(r=>JSON.stringify(r)).join('\n'));
 writeFileSync(tf,[{key:'j:2026-10-26/a',person_in_area:'yes'},{key:'j:2026-10-26/c',person_in_area:'no'},{key:'j:2026-10-26/b',person_in_area:'unsure'}].map(r=>JSON.stringify(r)).join('\n'));
 const out=execFileSync('node',['scripts/zone-eval/compare.mjs','--yolo',yf,'--data',dir,'--truth',tf],{cwd:join(import.meta.dirname,'..'),encoding:'utf8'});
 assert.match(out,/Labeled frames with a YOLO record: 2/);assert.match(out,/yolo\s+n=\s*2/);
 const cands=execFileSync('node',['scripts/zone-eval/compare.mjs','--yolo',yf,'--data',dir,'--candidates'],{cwd:join(import.meta.dirname,'..'),encoding:'utf8'}).trim().split('\n');
 assert.equal(cands.length,2);
});
