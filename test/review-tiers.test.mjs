import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {createServer} from '../server.mjs';
import {createJudgeLog} from '../src/presence/judge-log.mjs';
import {createCaptureStore} from '../src/presence/capture-store.mjs';
import {pPeople,tierOf,detectorDisagrees,thresholds,thresholdFinder,listReads,saveLabel,parseKey,peopleLabel,collectReads} from '../src/server/review-reads.mjs';
import {keyAction,isTypingTarget,moveIndex,tabLabel,progressLine} from '../public/review-keys.js';

const T=Date.parse('2026-10-25T20:00:00Z');
const a=(choice,confidence,top)=>[{name:'real_people_count',choice,confidence,...(top?{top}:{})}];
const tp=(...pairs)=>pairs.map(([choice,confidence])=>({choice,confidence}));

test('p_people formula: 0 in top, missing 0, no top, legacy, uncertain',()=>{
  assert.equal(pPeople(a('0',0.97,tp(['0',0.97],['1',0.02],['2',0.01]))).p.toFixed(2),'0.03');
  assert.equal(pPeople(a('1',0.6,tp(['1',0.6],['0',0.3],['2',0.1]))).p.toFixed(2),'0.70');
  // 0 absent from top-3: conservative lower bound = sum(top)
  assert.equal(pPeople(a('2',0.7,tp(['2',0.7],['1',0.2],['3',0.05]))).p.toFixed(2),'0.95');
  // no top (legacy / no distribution)
  assert.equal(pPeople(a('0',0.9)).p.toFixed(2),'0.10');
  assert.equal(pPeople(a('2',0.8)).p.toFixed(2),'0.80');
  const u=pPeople(a('uncertain',0.5,tp(['uncertain',0.5],['0',0.3],['1',0.2])));assert.equal(u.uncertain,true);assert.equal(u.p.toFixed(2),'0.70');
  assert.equal(pPeople([]).p,null);assert.equal(pPeople([]).uncertain,true);
});

test('tier assignment incl. uncertain, errored, detector disagreement and thresholds',()=>{
  const th={high:0.9,low:0.1},v=o=>({p_people:0.95,uncertain:false,errored:false,detector_disagree:false,...o});
  assert.equal(tierOf(v({}),th),'people');assert.equal(tierOf(v({p_people:0.05}),th),'no_people');assert.equal(tierOf(v({p_people:0.5}),th),'borderline');
  assert.equal(tierOf(v({p_people:0.9}),th),'people');assert.equal(tierOf(v({p_people:0.1}),th),'no_people');
  assert.equal(tierOf(v({uncertain:true}),th),'borderline');assert.equal(tierOf(v({errored:true,p_people:0.02}),th),'borderline');
  assert.equal(tierOf(v({detector_disagree:true}),th),'borderline');assert.equal(tierOf(v({p_people:null}),th),'borderline');
  assert.equal(tierOf(v({p_people:0.85}),{high:0.8,low:0.1}),'people');
  assert.equal(detectorDisagrees('0',2),true);assert.equal(detectorDisagrees('2',0),true);assert.equal(detectorDisagrees('2',1),false);assert.equal(detectorDisagrees('uncertain',1),false);assert.equal(detectorDisagrees('0',null),false);
  assert.deepEqual(thresholds({REVIEW_HIGH:'0.8',REVIEW_LOW:'0.2'}),{high:0.8,low:0.2,cutoff:0.75});
  assert.deepEqual(thresholds({},new URLSearchParams('high=0.7&low=0.3')),{high:0.7,low:0.3,cutoff:0.75});
  assert.equal(thresholds({},new URLSearchParams('high=0.2&low=0.5')).high,0.9);
});

test('threshold finder math on synthetic labels',()=>{
  const mk=(p,l)=>({p_people:p,people_label:l});
  const views=[mk(0.95,'yes'),mk(0.8,'yes'),mk(0.6,'yes'),mk(0.45,'no'),mk(0.35,'yes'),mk(0.1,'no'),mk(0.2,'no'),mk(0.9,'unsure'),mk(null,'yes')];
  const f=thresholdFinder(views),at=c=>f.table.find(r=>r.cutoff===c);
  assert.equal(f.labeled,7);assert.equal(f.needed,23);assert.equal(f.meaningful,false);
  const r=at(0.5);assert.deepEqual([r.tp,r.fp,r.fn,r.tn],[3,0,1,3]);assert.equal(r.precision,1);assert.equal(r.recall,0.75);assert.equal(r.accuracy,0.857);
  const lo=at(0.3);assert.deepEqual([lo.tp,lo.fp,lo.fn,lo.tn],[4,1,0,2]);
  assert.equal(f.best,0.3);// 0.30 and 0.35 tie on accuracy and recall; the lower cutoff wins
});
test('threshold finder best: max accuracy then recall',()=>{
  const views=[{p_people:0.9,people_label:'yes'},{p_people:0.6,people_label:'yes'},{p_people:0.5,people_label:'no'},{p_people:0.2,people_label:'no'}];
  const f=thresholdFinder(views,{minLabels:4});assert.equal(f.meaningful,true);
  assert.equal(f.best,0.55);// first of equal-accuracy cutoffs 0.55..0.6 (same recall)
  const g=thresholdFinder([{p_people:0.9,people_label:'yes'},{p_people:0.35,people_label:'yes'},{p_people:0.34,people_label:'no'}],{minLabels:1});
  assert.equal(g.best,0.35);
  assert.equal(thresholdFinder([]).best,null);
});

test('keyboard handler logic',()=>{
  assert.deepEqual(keyAction({key:'p'}),{type:'label',value:'yes'});assert.deepEqual(keyAction({key:'N'}),{type:'label',value:'no'});assert.deepEqual(keyAction({key:'u'}),{type:'label',value:'unsure'});
  assert.deepEqual(keyAction({key:'j'}),{type:'move',delta:1});assert.deepEqual(keyAction({key:'k'}),{type:'move',delta:-1});
  assert.equal(keyAction({key:'p'},{typing:true}),null);assert.equal(keyAction({key:'p',ctrlKey:true}),null);assert.equal(keyAction({key:'x'}),null);
  assert.equal(isTypingTarget({tagName:'INPUT'}),true);assert.equal(isTypingTarget({tagName:'DIV'}),false);assert.equal(isTypingTarget(null),false);
  assert.equal(moveIndex(0,-1,5),0);assert.equal(moveIndex(4,1,5),4);assert.equal(moveIndex(2,1,5),3);assert.equal(moveIndex(0,1,0),0);
  const counts={borderline:{total:9,labeled:4,unlabeled:5},people:{total:10,labeled:2,unlabeled:8},no_people:{total:3,labeled:0,unlabeled:3}};
  assert.equal(tabLabel('borderline',counts),'Borderline (5 unlabeled)');assert.equal(tabLabel('people',counts),'People (8)');assert.equal(tabLabel('no_people',counts),'No people (3)');
  assert.equal(progressLine(counts,'borderline'),'labeled 4 / 9');
});

test('review.js only looks up ids present in review.html',()=>{
  const js=readFileSync(new URL('../public/review.js',import.meta.url),'utf8'),html=readFileSync(new URL('../public/review.html',import.meta.url),'utf8');
  const ids=new Set([...html.matchAll(/id="([^"]+)"/g)].map(m=>m[1]));
  const used=new Set([...js.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map(m=>m[1]));
  assert.deepEqual([...used].filter(i=>!ids.has(i)),[]);
});

// ---- fixtures: both sources ----
const pngish=Buffer.from([0xff,0xd8,0xff,0xd9]);
async function fixtures(){
  const root=await mkdtemp(join(tmpdir(),'review-'));
  const logDir=join(root,'log'),capDir=join(root,'caps');
  const log=createJudgeLog({dir:logDir,sampleEmptyMs:0});
  const rec=(at,answers,extra={})=>log.record({image:{bytes:pngish,at},result:{_query_id:'q'+at,answers:answers.map(x=>({type:'choice',...x}))},decided_at:at,...extra});
  const mkAns=(choice,probs)=>[{name:'real_people_count',choice,confidence:probs.find(p=>p.value===choice)?.probability,probabilities:probs}];
  // judge-log: people (0.98), borderline (0.5), no-people sample (0.99 zero), detector-disagree
  rec(T,mkAns('2',[{value:'2',probability:0.97},{value:'1',probability:0.02},{value:'0',probability:0.01}]));
  rec(T+1000,mkAns('1',[{value:'1',probability:0.55},{value:'0',probability:0.4},{value:'2',probability:0.05}]));
  rec(T+2000,mkAns('0',[{value:'0',probability:0.99},{value:'1',probability:0.01}]));
  rec(T+3000,mkAns('2',[{value:'2',probability:0.96},{value:'0',probability:0.02},{value:'1',probability:0.02}]),{detector:{count:0,gap_ms:40}});
  await log.flush();
  // capture clip with 3 reads (one duplicates the judge-log read at T)
  const clip='20261025-200000-abcd',dir=join(capDir,'2026-10-25',clip);
  await mkdir(join(dir,'frames'),{recursive:true});
  const top=(c,p)=>({name:'real_people_count',choice:c,confidence:p[0].confidence,top:p});
  const line=(i,at,ans,extra={})=>JSON.stringify({at,read_id:i+10,judge:'presence',frame_index:i,frame_indexes:[i],frame_ats:[at],answers:[ans],...extra});
  await writeFile(join(dir,'judge.jsonl'),[
    line(0,T,top('2',tp(['2',0.97],['1',0.02],['0',0.01]))),
    line(1,T+60000,top('1',tp(['1',0.7],['0',0.25],['2',0.05])),{detector:{count:1,gap_ms:10}}),
    line(2,T+61000,top('0',tp(['0',0.95],['1',0.05]))),
    JSON.stringify({at:T+60000,read_id:11,judge:'motion',frame_index:1,frame_indexes:[1,0],frame_ats:[T+60000,T],answers:[]})
  ].join('\n')+'\n');
  for(const i of [0,1,2])await writeFile(join(dir,'frames',String(i).padStart(6,'0')+'_'+(T+i)+'.jpg'),pngish);
  const captures=createCaptureStore({dir:capDir,tickMs:100000});
  return {root,log,captures,deps:{log,captures},cleanup:async()=>{await captures.close();await rm(root,{recursive:true,force:true});}};
}

test('unified list across both sources: dedupe, tiers, counts, sort, sliders, filters',async()=>{
  const f=await fixtures();
  try{
    const all=await collectReads(f.deps);
    assert.equal(all.length,4+2);// capture read at T deduped against the judge-log read
    const r=await listReads(f.deps,{tier:'borderline',labeled:'all'});
    assert.deepEqual(r.counts.people,{total:1,labeled:0,unlabeled:1});
    assert.equal(r.counts.no_people.total,2);assert.equal(r.counts.borderline.total,3);
    // borderline: 0.6 judge-read, 0.75 capture read (|0.75-.75|=0), detector-disagree judge read p=0.98 (dist .23)
    assert.deepEqual(r.items.map(i=>[i.source,i.detector_disagree]),[['capture',false],['judge',false],['judge',true]]);
    assert.equal(r.items[0].p_people,0.75);assert.equal(r.items[0].prev_index,0);assert.equal(r.items[0].detector_count,1);
    // sliders via query: lowering HIGH to 0.5 moves the 0.55 read into People; raising LOW to 0.6 moves it... (0.55<=0.6) into No people
    const hi=await listReads(f.deps,{tier:'people'},thresholds({},new URLSearchParams('high=0.5')));assert.ok(hi.items.some(i=>Math.abs(i.p_people-0.6)<1e-9));
    const lo=await listReads(f.deps,{tier:'no_people'},thresholds({},new URLSearchParams('high=0.95&low=0.6')));assert.ok(lo.items.some(i=>Math.abs(i.p_people-0.6)<1e-9));
    assert.equal((await listReads(f.deps,{tier:'people',source:'capture'})).total,0);
    assert.equal((await listReads(f.deps,{tier:'people',source:'judge'})).total,1);
    assert.equal((await listReads(f.deps,{tier:'borderline',labeled:'all',from:'2026-10-26'})).total,0);
    const s=await listReads(f.deps,{tier:'no_people',sample:1,seed:7});assert.equal(s.items.length,1);assert.equal(s.total,2);
  }finally{await f.cleanup();}
});

test('label round-trip for both sources; unlabeled default hides labeled; finder sees labels',async()=>{
  const f=await fixtures();
  try{
    const first=await listReads(f.deps,{tier:'borderline'});
    const cap=first.items.find(i=>i.source==='capture'),jud=first.items.find(i=>i.source==='judge'&&!i.detector_disagree);
    await saveLabel(f.deps,{key:cap.key,people_present:'yes'});
    await saveLabel(f.deps,{key:jud.key,people_present:'no'});
    await saveLabel(f.deps,{key:jud.key,notes:'later note'});// merges, keeps people_present
    const after=await listReads(f.deps,{tier:'borderline'});
    assert.equal(after.total,1);assert.equal(after.counts.borderline.labeled,2);
    const all=await listReads(f.deps,{tier:'borderline',labeled:'all'});
    assert.equal(all.items.find(i=>i.key===cap.key).people_label,'yes');
    const j=all.items.find(i=>i.key===jud.key);assert.equal(j.people_label,'no');assert.equal(j.label.notes,'later note');
    assert.equal(all.finder.labeled,2);
    assert.match(await readFile(join(f.root,'caps','2026-10-25','20261025-200000-abcd','labels.jsonl'),'utf8'),/"people_present":"yes"/);
    await assert.rejects(saveLabel(f.deps,{key:'j:../x',people_present:'yes'}),{status:400});
    await assert.rejects(saveLabel(f.deps,{key:cap.key,people_present:'maybe'}),{status:400});
    assert.equal(parseKey('c:abc:../1'),null);assert.equal(parseKey('x:1'),null);assert.equal(peopleLabel({real_people_count:'0'}),'no');assert.equal(peopleLabel({real_people_count:'3'}),'yes');assert.equal(peopleLabel({people_present:'unsure'}),'unsure');
  }finally{await f.cleanup();}
});

test('review routes: unified list, image, label with origin check',async()=>{
  const f=await fixtures();
  const server=createServer({env:{JUDGE_LOG_DIR:join(f.root,'log'),CAPTURE_DIR:join(f.root,'caps'),OPENAI_API_KEY:'x',REVIEW_HIGH:'0.9',REVIEW_LOW:'0.1'}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const d=await (await fetch(base+'/api/review/reads?tier=borderline&labeled=all&high=0.9')).json();
    assert.equal(d.thresholds.high,0.9);assert.equal(d.counts.people.total,1);assert.ok(d.items.length>=3);
    const cap=d.items.find(i=>i.source==='capture'),jud=d.items.find(i=>i.source==='judge');
    for(const it of [cap,jud]){const im=await fetch(base+'/api/review/read-image?key='+encodeURIComponent(it.key));assert.equal(im.status,200);assert.equal((await im.arrayBuffer()).byteLength,4);}
    assert.equal((await fetch(base+'/api/review/read-image?key='+encodeURIComponent(cap.key)+'&prev=0')).status,200);
    assert.equal((await fetch(base+'/api/review/read-image?key=c:..:1')).status,404);
    const body=JSON.stringify({key:cap.key,people_present:'no'});
    assert.equal((await fetch(base+'/api/review/read-label',{method:'POST',body})).status,403);
    assert.equal((await fetch(base+'/api/review/read-label',{method:'POST',body,headers:{Origin:base,'Content-Type':'application/json'}})).status,200);
    assert.equal((await fetch(base+'/api/review/read-label',{method:'POST',body:JSON.stringify({key:'zzz'}),headers:{Origin:base,'Content-Type':'application/json'}})).status,400);
    const again=await (await fetch(base+'/api/review/reads?tier=borderline')).json();assert.ok(!again.items.some(i=>i.key===cap.key));
    assert.equal((await fetch(base+'/review.html')).status,200);assert.equal((await fetch(base+'/review-keys.js')).status,200);
  }finally{server.close();await f.cleanup();}
});
