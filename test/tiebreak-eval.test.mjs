import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {loadEntries,loadLabels,evaluate,format,parseArgs} from '../scripts/tiebreak-eval.mjs';

// Synthetic log: [id, winner, confidence, errored, detector count|null, ai label, human label|null]
const rows=[
 ['a','1',0.97,false,1,'yes',null],       // confident, right
 ['b','0',0.97,false,0,'no',null],        // confident, right
 ['c','1',0.5,true,0,'no',null],          // uncertain false "1": detector 0 fixes it
 ['d','1',0.5,true,1,'yes',null],         // uncertain true "1": detector agrees
 ['e','0',0.5,true,1,'yes',null],         // uncertain "0" but a person: detector fixes it
 ['f','1',0.5,true,null,'no',null],       // uncertain, no detector count: tiebreak abstains
 ['g','1',0.97,false,0,'yes','no'],       // confident, detector 0; human overrides AI
];
function build(){
 const dir=mkdtempSync(join(tmpdir(),'tbe-'));mkdirSync(join(dir,'2026-10-26'));
 const ai=[],hu=[];
 for(const [id,w,c,err,det,aiL,hL] of rows){
  const key='2026-10-26/'+id;
  writeFileSync(join(dir,'2026-10-26',id+'.json'),JSON.stringify({read_key:key,answers:[{name:'real_people_count',choice:w,confidence:c}],error:err?{code:'UNCERTAIN_PEOPLE_COUNT'}:null,detector:det==null?null:{count:det,gap_ms:5}}));
  writeFileSync(join(dir,'2026-10-26',id+'.jpg'),'x');
  ai.push(JSON.stringify({key:'j:'+key,labeler:'claude',people_present:aiL}));
  if(hL)hu.push(JSON.stringify({read_key:key,real_people_count:hL==='yes'?'1':'0'}));
 }
 writeFileSync(join(dir,'ai_labels.jsonl'),ai.join('\n')+'\n');writeFileSync(join(dir,'labels.jsonl'),hu.join('\n')+'\n');
 return dir;
}
test('eval scores judge, tiebreak and primary on synthetic labeled reads and reports usable counts',async()=>{
 const dir=build();
 try{
  const r=evaluate(await loadEntries(dir),await loadLabels(dir));
  assert.equal(r.reads,7);assert.equal(r.with_detector_count,6);assert.equal(r.with_ai_label,7);assert.equal(r.with_human_label,1);assert.equal(r.usable_uncertain,3);
  const ai=r.vs_ai.all;
  assert.deepEqual([ai.judge.correct,ai.judge.wrong],[4,3]);
  assert.deepEqual([ai.tiebreak.correct,ai.tiebreak.wrong,ai.tiebreak.abstain],[6,0,1]);
  assert.deepEqual([ai.primary.correct,ai.primary.wrong,ai.primary.abstain],[5,1,1]);
  const u=r.vs_ai.usable_uncertain_only;
  assert.equal(u.tiebreak.accuracy,1);assert.equal(u.judge.accuracy,0.333);
  const h=r.vs_human.all;assert.equal(h.judge.n,1);assert.equal(h.judge.wrong,1,'human says no, confident judge says yes');assert.equal(h.tiebreak.wrong,1,'a confident Judge is never overridden');assert.equal(h.primary.correct,1);
  assert.match(format(r),/usable/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('no detector counts: says so and does not crash; CLI runs against --dir',async()=>{
 const empty=mkdtempSync(join(tmpdir(),'tbe0-'));
 try{
  const r=evaluate(await loadEntries(empty),await loadLabels(empty));assert.equal(r.reads,0);assert.match(format(r),/NO read has a detector count/);
  assert.throws(()=>parseArgs(['--bogus']));assert.throws(()=>parseArgs(['--dir']));
  const dir=build();
  try{const out=execFileSync('node',['scripts/tiebreak-eval.mjs','--dir',dir,'--json'],{cwd:new URL('..',import.meta.url).pathname,encoding:'utf8'});assert.equal(JSON.parse(out).reads,7);}finally{rmSync(dir,{recursive:true,force:true});}
 }finally{rmSync(empty,{recursive:true,force:true});}
});
