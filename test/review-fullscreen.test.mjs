import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createJudgeLog} from '../src/presence/judge-log.mjs';
import {groupVisits,onePerVisit,listReads,saveLabel} from '../src/server/review-reads.mjs';
import {keyAction,createSession,reduce,preloadUrls,hudLines,acceptValue,humanValue} from '../public/review-keys.js';

const mk=(key,at,over={})=>({key,source:'judge',captured_at:at,labeled:false,p_people:0.5,...over});

test('visit grouping: same source, gap <= 5 s',()=>{
  const vs=[mk('a',0),mk('b',5000),mk('c',10001),mk('d',10500,{source:'capture'}),mk('e',11000)];
  const groups=groupVisits(vs);
  assert.deepEqual(groups.map(g=>g.map(v=>v.key)),[['a','b'],['c','e'],['d']]);
  assert.equal(vs[0].visit_size,2);assert.equal(vs[3].visit_size,1);
});

test('one per visit: closest to cutoff, newest on ties; visit_keys are unlabeled members',()=>{
  const dist=v=>Math.abs(v.p_people-0.75);
  const vs=[mk('a',0,{p_people:0.3}),mk('b',1000,{p_people:0.7}),mk('c',2000,{p_people:0.7}),mk('d',3000,{p_people:0.1,labeled:true}),mk('z',60000,{p_people:0.9})];
  const visits=groupVisits(vs),reps=onePerVisit(vs.filter(v=>!v.labeled),visits,dist);
  assert.deepEqual(reps.map(r=>r.key).sort(),['c','z']);
  assert.deepEqual(reps.find(r=>r.key==='c').visit_keys,['a','b','c']);
  assert.equal(reps.find(r=>r.key==='c').visit_size,4);
});

const items=()=>[
  {key:'j:1',p_people:0.5,has_prev:true,visit_keys:['j:1','j:2']},{key:'j:2',has_prev:false},{key:'j:3',people_label:'no'},
  {key:'j:4',ai_labels:{'claude-sonnet-5.5':{people_present:'no'},'gemini-x':{people_present:'no'}}},
  {key:'j:5',ai_labels:{'claude-sonnet-5.5':{people_present:'no'},'gemini-x':{people_present:'yes'}}}];

test('keyboard actions: y/n/u, shift, arrows, undo, space, escape, typing guard',()=>{
  assert.deepEqual(keyAction({key:'y'}),{type:'label',value:'yes'});
  assert.deepEqual(keyAction({key:'N',shiftKey:true}),{type:'label',value:'no',visit:true});
  assert.deepEqual(keyAction({key:'u'}),{type:'label',value:'unsure'});
  assert.deepEqual(keyAction({key:'ArrowRight'}),{type:'move',delta:1});assert.deepEqual(keyAction({key:'ArrowLeft'}),{type:'move',delta:-1});
  assert.deepEqual(keyAction({key:'z'}),{type:'undo'});assert.deepEqual(keyAction({key:' '}),{type:'toggle'});
  assert.deepEqual(keyAction({key:'Escape'}),{type:'exit'});assert.deepEqual(keyAction({key:'a'}),{type:'accept'});
  assert.equal(keyAction({key:'y'},{typing:true}),null);
});

test('session: label saves and advances; undo restores; visit apply; accept; end',()=>{
  const s=createSession(items());
  let o=reduce(s,{type:'label',value:'yes'});
  assert.deepEqual(o.saves,[{key:'j:1',value:'yes'}]);assert.equal(s.cur,1);assert.equal(o.flash,'yes');
  o=reduce(s,{type:'undo'});assert.deepEqual(o.saves,[{key:'j:1',value:null}]);assert.equal(s.cur,0);assert.equal(humanValue(s,s.items[0]),null);
  o=reduce(s,{type:'label',value:'no',visit:true});
  assert.deepEqual(o.saves.map(x=>x.key),['j:1','j:2']);assert.equal(o.flash,'no x2');assert.equal(s.cur,1);
  o=reduce(s,{type:'undo'});assert.equal(o.saves.length,2);
  // undo restores a prior human label rather than clearing it
  s.cur=2;reduce(s,{type:'label',value:'yes'});o=reduce(s,{type:'undo'});assert.deepEqual(o.saves,[{key:'j:3',value:'no'}]);
  // toggle only with prev
  s.cur=0;reduce(s,{type:'toggle'});assert.equal(s.view,'prev');reduce(s,{type:'move',delta:1});assert.equal(s.view,'now');reduce(s,{type:'toggle'});assert.equal(s.view,'now');
  // accept: AIs agree -> Claude's value; disagree -> nothing
  s.cur=3;o=reduce(s,{type:'accept'});assert.deepEqual(o.saves,[{key:'j:4',value:'no',labeler:'accepted:claude-sonnet-5.5'}]);
  o=reduce(s,{type:'accept'});assert.equal(o.saves.length,0);assert.match(o.flash,/no agreed/);assert.equal(s.cur,4);
  // end of list
  o=reduce(s,{type:'label',value:'yes'});assert.equal(o.ended,true);assert.equal(s.cur,4);
  assert.equal(reduce(s,{type:'exit'}).exit,true);
  assert.equal(acceptValue({}),null);
});

test('preload ordering: next three, nearest first, bounded',()=>{
  const its=[1,2,3,4,5].map(i=>({key:'k'+i}));const u=(r)=>'u'+r.key;
  assert.deepEqual(preloadUrls(its,0,u),['uk2','uk3','uk4']);assert.deepEqual(preloadUrls(its,3,u),['uk5']);assert.deepEqual(preloadUrls(its,4,u),[]);
});

test('HUD lines carry tier position, p_people, judge, detector, time',()=>{
  const l=hudLines({p_people:0.5,winner:'1',confidence:0.55,detector_count:2,captured_at:Date.now(),visit_size:3},{pos:37,total:609,tier:'borderline'});
  assert.equal(l[0],'Borderline 37 / 609');assert.ok(l.includes('Judge 1 55%'));assert.ok(l.includes('detector 2'));assert.ok(l.includes('visit 3'));
});

test('clear label removes a judge label; visits param collapses reads',async()=>{
  const root=await mkdtemp(join(tmpdir(),'rvfs-')),log=createJudgeLog({dir:join(root,'log'),sampleEmptyMs:0});
  const T=Date.parse('2026-10-25T20:00:00Z');
  const ans=[{type:'choice',name:'real_people_count',choice:'1',confidence:0.55,probabilities:[{value:'1',probability:0.55},{value:'0',probability:0.4}]}];
  for(const dt of [0,1000,2000,60000])log.record({image:{bytes:Buffer.from([0xff,0xd8,0xff,0xd9]),at:T+dt},result:{_query_id:'q'+dt,answers:ans},decided_at:T+dt});
  await log.flush();
  try{
    const deps={log,captures:null};
    const all=await listReads(deps,{tier:'borderline'});assert.equal(all.total,4);
    const one=await listReads(deps,{tier:'borderline',visits:'1'});assert.equal(one.total,2);
    const rep=one.items.find(i=>i.visit_size===3);assert.equal(rep.visit_keys.length,3);
    await saveLabel(deps,{key:rep.key,people_present:'yes'});
    assert.equal((await listReads(deps,{tier:'borderline',labeled:'yes'})).total,1);
    await saveLabel(deps,{key:rep.key,clear:true});
    assert.equal((await listReads(deps,{tier:'borderline',labeled:'yes'})).total,0);
    assert.equal((await listReads(deps,{tier:'borderline'})).total,4);
  }finally{await rm(root,{recursive:true,force:true});}
});
