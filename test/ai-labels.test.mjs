import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../server.mjs';
import {createJudgeLog} from '../src/presence/judge-log.mjs';
import {createCaptureStore} from '../src/presence/capture-store.mjs';
import {listReads,thresholdFinder} from '../src/server/review-reads.mjs';
import {sanitizeAiLabel,parseAiBody,latestAiLabels,aiDisagrees,aiState,humanVsAi,aiConsensus,aiSummary} from '../src/presence/ai-labels.mjs';
import {aiSummaryLine,hudLines,acceptValue} from '../public/review-keys.js';

const T=Date.parse('2026-10-25T20:00:00Z');
const jpg=Buffer.from([0xff,0xd8,0xff,0xd9]);
const probs=(c,p)=>[{value:c,probability:p},{value:c==='0'?'1':'0',probability:1-p}];
async function fixtures(){
  const root=await mkdtemp(join(tmpdir(),'ai-')),log=createJudgeLog({dir:join(root,'log'),sampleEmptyMs:0});
  // 0: judge says 2 people (tier people); 1: judge says 0 (tier no_people); 2: borderline p=.55
  const ans=(c,p)=>[{type:'choice',name:'real_people_count',choice:c,confidence:p,probabilities:probs(c,p)}];
  log.record({image:{bytes:jpg,at:T},result:{_query_id:'a',answers:ans('2',0.97)},decided_at:T});
  log.record({image:{bytes:jpg,at:T+60000},result:{_query_id:'b',answers:ans('0',0.97)},decided_at:T+60000});
  log.record({image:{bytes:jpg,at:T+120000},result:{_query_id:'c',answers:ans('1',0.55)},decided_at:T+120000});
  await log.flush();
  const captures=createCaptureStore({dir:join(root,'caps'),tickMs:100000});
  const keys=await log.keys();
  return {root,log,captures,deps:{log,captures},keys:keys.map(k=>'j:'+k),cleanup:async()=>{await captures.close();await rm(root,{recursive:true,force:true});}};
}
const rec=(key,labeler,people_present,extra={})=>({key,labeler,people_present,...extra});

test('sanitize: valid, defaults and rejections',()=>{
  const parseKey=k=>/^j:/.test(k);
  const ok=sanitizeAiLabel(rec('j:2026-10-25/x','claude-sonnet-5.5','no',{count:0,false_positive_cause:'skeleton_prop',notes:'n'}),{parseKey,now:()=>T});
  assert.equal(ok.labeled_at,new Date(T).toISOString());assert.equal(ok.count,0);
  for(const bad of [null,[],rec('zzz','claude','no'),rec('j:a','bad labeler!','no'),rec('j:a','claude','maybe'),rec('j:a','claude','no',{count:-1}),rec('j:a','claude','no',{false_positive_cause:'Bad Cause'})])
    assert.throws(()=>sanitizeAiLabel(bad,{parseKey}),{status:400});
});

test('latest record per key per labeler wins',()=>{
  const m=latestAiLabels([rec('k','claude','yes'),rec('k','gemini-3','no'),rec('k','claude','no'),rec('k2','claude','yes')]);
  assert.equal(m.get('k').claude.people_present,'no');assert.equal(m.get('k')['gemini-3'].people_present,'no');assert.equal(m.get('k2').claude.people_present,'yes');
});

test('body parsing: array, NDJSON, cap, junk',()=>{
  assert.equal(parseAiBody('[{"a":1},{"a":2}]').length,2);assert.equal(parseAiBody('{"a":1}\n{"a":2}\n').length,2);
  assert.throws(()=>parseAiBody('[1,2,3]',{max:2}),{status:400});assert.throws(()=>parseAiBody('nope'),{status:400});assert.throws(()=>parseAiBody(''),{status:400});
  assert.equal(parseAiBody(JSON.stringify(Array(2000).fill({}))).length,2000);assert.throws(()=>parseAiBody(JSON.stringify(Array(2001).fill({}))),{status:400});
});

test('disagree math: vs Judge winner, vs tier, unsure ignored, consensus, human vs AI',()=>{
  const v=o=>({winner:'2',uncertain:false,tier:'people',ai_labels:{claude:{people_present:'no'}},...o});
  assert.equal(aiDisagrees(v()),true);
  assert.equal(aiDisagrees(v({ai_labels:{claude:{people_present:'yes'}}})),false);
  assert.equal(aiDisagrees(v({winner:'0',tier:'borderline',ai_labels:{claude:{people_present:'yes'}}})),true);
  assert.equal(aiDisagrees(v({winner:'uncertain',uncertain:true,tier:'borderline'})),false);// AI "no" vs unknown judge, borderline tier: nothing to disagree with
  assert.equal(aiDisagrees(v({ai_labels:{claude:{people_present:'unsure'}}})),false);
  assert.equal(aiState(v({ai_labels:null})),'none');assert.equal(aiState(v({ai_labels:{c:{people_present:'unsure'}}})),'none');assert.equal(aiState(v()),'disagree');
  assert.equal(aiConsensus({a:{people_present:'no'},b:{people_present:'no'}}),'no');assert.equal(aiConsensus({a:{people_present:'no'},b:{people_present:'yes'}}),'mixed');assert.equal(aiConsensus(null),null);
  assert.equal(humanVsAi({people_label:'yes',ai_labels:{c:{people_present:'no'}}}),'disagree');assert.equal(humanVsAi({people_label:'no',ai_labels:{c:{people_present:'no'}}}),'agree');assert.equal(humanVsAi({people_label:'unsure',ai_labels:{c:{people_present:'no'}}}),null);
  const s=aiSummary([{ai_labels:{c:{people_present:'no',false_positive_cause:'skeleton_prop'}}},{ai_labels:{c:{people_present:'no',false_positive_cause:'skeleton_prop'}}},{ai_labels:null}]);
  assert.deepEqual([s.total,s.with_ai,s.no,s.causes.skeleton_prop],[3,2,2,2]);
  assert.equal(aiSummaryLine(s,'borderline'),'AI says no people on 2 / 3 borderline · skeleton_prop 2');assert.equal(aiSummaryLine(null,'borderline'),'');
});

test('accept key: AIs must agree, Claude preferred; HUD shows AI labels',()=>{
  assert.deepEqual(acceptValue({'gemini-3':{people_present:'no'},'claude-sonnet-5.5':{people_present:'no'}}),{value:'no',labeler:'claude-sonnet-5.5'});
  assert.equal(acceptValue({a:{people_present:'no'},claude:{people_present:'yes'}}),null);
  const l=hudLines({captured_at:T,ai_labels:{'claude-sonnet-5.5':{people_present:'no'},'gemini-3':{people_present:'no'}}},{pos:1,total:2,tier:'borderline'});
  assert.ok(l.includes('Claude: no · Gemini: no'));
});

test('import + list: storage, filters, sort, summary, provisional finder, perms',async()=>{
  const f=await fixtures();
  try{
    const [a,b,c]=f.keys;
    // validation is all-or-nothing
    await assert.rejects(import('../src/server/review-reads.mjs').then(m=>m.saveAiLabels(f.deps,JSON.stringify([rec(a,'claude-sonnet-5.5','no'),rec('j:2026-10-25/nope','claude-sonnet-5.5','no')]))),{status:404});
    assert.equal((await listReads(f.deps,{tier:'people',labeled:'all'})).items[0].ai_labels,null);
    const {saveAiLabels}=await import('../src/server/review-reads.mjs');
    const nd=[rec(a,'claude-sonnet-5.5','no',{false_positive_cause:'skeleton_prop'}),rec(b,'claude-sonnet-5.5','yes'),rec(c,'claude-sonnet-5.5','no',{false_positive_cause:'vest_prop'}),rec(c,'gemini-3-pro','no'),rec(c,'claude-sonnet-5.5','yes',{false_positive_cause:'none'})].map(r=>JSON.stringify(r)).join('\n');
    assert.deepEqual(await saveAiLabels(f.deps,nd),{saved:5,judge:5,capture:0});
    const file=join(f.root,'log','ai_labels.jsonl');assert.equal((await stat(file)).mode&0o777,0o600);
    const L=async o=>(await listReads(f.deps,{labeled:'all',...o}));
    const people=await L({tier:'people'});
    assert.deepEqual(people.items[0].ai_labels['claude-sonnet-5.5'].people_present,'no');assert.equal(people.items[0].ai_disagree,true);
    const bord=await L({tier:'borderline'});assert.equal(bord.items[0].ai_labels['claude-sonnet-5.5'].people_present,'yes');// latest wins
    assert.equal(bord.items[0].ai_labels['gemini-3-pro'].people_present,'no');
    assert.equal((await L({tier:'people',ai:'disagree'})).total,1);assert.equal((await L({tier:'people',ai:'agree'})).total,0);
    assert.equal((await L({tier:'no_people',ai:'disagree'})).total,1);
    assert.equal((await L({tier:'borderline',ai:'none'})).total,0);
    assert.equal((await L({tier:'people',false_positive_cause:'skeleton_prop'})).total,1);assert.equal((await L({tier:'people',false_positive_cause:'vest_prop'})).total,0);
    assert.equal((await L({tier:'borderline',false_positive_cause:'any'})).total,0);// claude's latest cause is "none"
    assert.equal(people.ai_summary.people.no,1);assert.equal(people.ai_summary.people.causes.skeleton_prop,1);
    assert.equal((await L({tier:'people',sort:'ai_disagree'})).items[0].ai_disagree,true);
    // human vs AI
    const {saveLabel}=await import('../src/server/review-reads.mjs');
    await saveLabel(f.deps,{key:a,people_present:'yes'});
    assert.equal((await L({tier:'people',human_vs_ai:'disagree'})).total,1);assert.equal((await L({tier:'people',human_vs_ai:'agree'})).total,0);
    assert.match(await readFile(join(f.root,'log','labels.jsonl'),'utf8'),/"people_present":"yes"/);
    assert.doesNotMatch(await readFile(join(f.root,'log','labels.jsonl'),'utf8'),/claude/);// human labels stay separate
    // provisional: borderline c has AI consensus mixed (claude yes, gemini no) -> not used; no_people b (claude yes only) is
    const finder=await L({tier:'borderline',provisional:'1'});assert.equal(finder.finder.provisional,1);
    assert.equal((await L({tier:'borderline'})).finder.provisional,0);
    // pure finder: provisional rows counted
    assert.equal(thresholdFinder([{p_people:0.9,people_label:'yes',provisional:true},{p_people:0.1,people_label:'no'}]).provisional,1);
  }finally{await f.cleanup();}
});

test('capture-clip AI labels stored in the clip dir and surfaced on reads',async()=>{
  const root=await mkdtemp(join(tmpdir(),'aicap-')),capDir=join(root,'caps'),clip='20261025-200000-abcd',dir=join(capDir,'2026-10-25',clip);
  await mkdir(join(dir,'frames'),{recursive:true});
  await writeFile(join(dir,'judge.jsonl'),JSON.stringify({at:T,read_id:1,judge:'presence',frame_index:0,frame_indexes:[0],frame_ats:[T],answers:[{name:'real_people_count',choice:'1',confidence:0.6,top:[{choice:'1',confidence:0.6},{choice:'0',confidence:0.4}]}]})+'\n');
  await writeFile(join(dir,'frames','000000_'+T+'.jpg'),jpg);
  const captures=createCaptureStore({dir:capDir,tickMs:100000});
  try{
    const {saveAiLabels}=await import('../src/server/review-reads.mjs'),deps={log:null,captures};
    await assert.rejects(saveAiLabels(deps,JSON.stringify([rec('c:nope:0','claude','no')])),{status:404});
    await saveAiLabels(deps,JSON.stringify([rec(`c:${clip}:0`,'claude-sonnet-5.5','no',{false_positive_cause:'reflection'})]));
    const st=await stat(join(dir,'ai_labels.jsonl'));assert.equal(st.mode&0o777,0o600);
    const r=await listReads(deps,{tier:'borderline',labeled:'all'});
    assert.equal(r.items[0].ai_labels['claude-sonnet-5.5'].false_positive_cause,'reflection');
  }finally{await captures.close();await rm(root,{recursive:true,force:true});}
});

test('POST /api/review/ai-labels: origin check, validation, cap, round-trip in /reads',async()=>{
  const f=await fixtures();
  const server=createServer({env:{JUDGE_LOG_DIR:join(f.root,'log'),CAPTURE_DIR:join(f.root,'caps'),OPENAI_API_KEY:'x'}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`,H={Origin:base,'Content-Type':'application/json'};
  try{
    const body=JSON.stringify([rec(f.keys[0],'claude-sonnet-5.5','no')]);
    assert.equal((await fetch(base+'/api/review/ai-labels',{method:'POST',body})).status,403);
    const ok=await fetch(base+'/api/review/ai-labels',{method:'POST',body,headers:H});assert.equal(ok.status,200);assert.equal((await ok.json()).saved,1);
    assert.equal((await fetch(base+'/api/review/ai-labels',{method:'POST',body:JSON.stringify([rec('zzz','claude','no')]),headers:H})).status,400);
    assert.equal((await fetch(base+'/api/review/ai-labels',{method:'POST',body:JSON.stringify(Array(2001).fill(rec(f.keys[0],'claude','no'))),headers:H})).status,400);
    assert.equal((await fetch(base+'/api/review/ai-labels',{method:'POST',body:'{bad',headers:H})).status,400);
    const d=await (await fetch(base+'/api/review/reads?tier=people&labeled=all&ai=disagree')).json();
    assert.equal(d.items.length,1);assert.equal(d.items[0].ai_labels['claude-sonnet-5.5'].people_present,'no');
  }finally{server.close();await f.cleanup();}
});
