import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile,writeFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCaptureStore} from '../src/presence/capture-store.mjs';
import {main,parseArgs,planFrames,planCalls,estimateCostUsd,compareIndexes,indexRecords,bucketCount,cutoffFor} from '../scripts/judge-replay.mjs';

// Synthetic bytes only.
const jpeg=n=>Buffer.from([0xff,0xd8,n&255,(n>>8)&255,0xff,0xd9]);
const frame=at=>({bytes:jpeg(at/10),at});

// One synthetic clip: 11 frames at 500 ms, one live presence read at t=2000 (count 1) and one at 4000 (count 1).
async function makeClip(){
  const dir=await mkdtemp(join(tmpdir(),'replay-'));const clock={t:0};
  const store=createCaptureStore({dir,now:()=>clock.t,tickMs:3600000,mode:()=>'DATA_CAPTURE'});
  for(let t=0;t<=8000;t+=500){clock.t=t;store.onFrame(frame(t));
    if(t>0&&t%2000===0)store.noteRead({read_id:t,judge:'presence',images:[frame(t)],presence:'present',prompt_sha256:'live'.padEnd(64,'0'),model:'gpt-6-luna',
      answers:[{name:'real_people_count',choice:'1',confidence:0.99}],parsed:{visitor_count:1}});}
  await store.flush();
  const clip=(await store.list()).clips[0];await store.close();
  return {dir,clip,id:clip.clip_id};
}
const stubFetch=({counts={},override={}}={})=>{
  const calls=[];
  const fn=async(url,init)=>{
    const body=JSON.parse(init.body);calls.push({url,body});
    if(url.endsWith('/responses'))return {ok:true,json:async()=>({output_text:JSON.stringify({people_visible:true,visitor_count:1,description:'x'}),usage:{input_tokens:1000,output_tokens:50}})};
    const answers=body.questions.map(q=>({type:'choice',name:q.name,choice:override[q.name]??(q.name==='real_people_count'?String(counts.n??1):q.choices[0].value),confidence:0.95}));
    return {ok:true,json:async()=>({answers,usage:{input_tokens:1000,output_tokens:20}})};
  };
  fn.calls=calls;return fn;
};
const silent=()=>{const lines=[];const f=l=>lines.push(String(l));f.lines=lines;return f;};

test('replay prints the plan and refuses to run without --yes',async()=>{
  const {dir}=await makeClip();const fetchImpl=stubFetch();const log=silent();
  try{
    const r=await main(['--dir',dir,'--clips','all','--judges','presence,motion,costume'],{env:{OPENAI_API_KEY:'k'},fetchImpl,log});
    assert.equal(r.gated,true);assert.equal(fetchImpl.calls.length,0);
    const text=log.lines.join('\n');assert.match(text,/Calls: \d+/);assert.match(text,/Estimated cost: \$/);assert.match(text,/--yes/);
    const clipDirs=await readdir(join(dir,(await readdir(dir))[0]));assert.ok(!(await readdir(join(dir,(await readdir(dir))[0],clipDirs[0]))).includes('replays'),'nothing written');
    await assert.rejects(()=>main(['--dir',dir,'--yes'],{env:{},fetchImpl,log}),/OPENAI_API_KEY/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('planning: frame spacing pairs, --every, --limit, call counts and cost estimate',()=>{
  const frames=Array.from({length:11},(_,i)=>({index:i,at:i*500}));
  const p=planFrames(frames,{spacingMs:1000});
  assert.equal(p.length,11);assert.equal(p[0].prev,null);assert.equal(p[1].prev.at,0);   // snaps to the nearest saved frame within [spacing/2, 2*spacing]
  assert.equal(p[2].prev.at,0);assert.equal(p[4].prev.at,1000);
  assert.equal(planFrames(frames,{spacingMs:2000})[8].prev.at,2000);
  assert.equal(planFrames(frames,{every:5}).length,3);assert.equal(planFrames(frames,{limit:4}).length,4);
  const calls=planCalls([{positions:p}],['presence','motion','costume']);
  assert.equal(calls.presence,11);assert.equal(calls.motion,p.filter(x=>x.prev).length);assert.equal(calls.costume,11);
  assert.ok(estimateCostUsd(calls)>0);
  const o=parseArgs(['--clips','a*','--judges','motion,scene','--spacing-ms','1500','--every','2','--limit','7','--yes','--prompt-file','x.mjs']);
  assert.deepEqual([o.clips,o.judges,o.spacingMs,o.every,o.limit,o.yes],['a*',['motion','scene'],1500,2,7,true]);
  assert.throws(()=>parseArgs(['--judges','bogus']));
});

test('replay over a synthetic clip with stubbed fetch writes a private run dir; prompt versions sit side by side',async()=>{
  const {dir,id}=await makeClip();const fetchImpl=stubFetch();const log=silent();
  try{
    const env={OPENAI_API_KEY:'k'};
    const r1=await main(['--dir',dir,'--clips','all','--judges','presence,motion,costume,scene','--spacing-ms','2000','--label','current','--yes'],{env,fetchImpl,log});
    assert.equal(r1.gated,false);assert.ok(r1.calls>0);
    const day=(await readdir(dir))[0],clipDir=join(dir,day,id);
    const runs=await readdir(join(clipDir,'replays'));assert.equal(runs.length,1);
    const run=JSON.parse(await readFile(join(clipDir,'replays',runs[0],'run.json'),'utf8'));
    assert.equal(run.clip_id,id);assert.equal(run.spacing_ms,2000);assert.equal(run.model,'gpt-6-luna');assert.ok(run.started_at&&run.finished_at);
    for(const j of ['presence','motion','costume','scene'])assert.match(run.prompt_sha256[j],/^[0-9a-f]{64}$/);
    assert.ok(run.cost.usd>0&&run.cost.calls===r1.calls);
    const lines=(await readFile(join(clipDir,'replays',runs[0],'results.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l));
    assert.equal(lines.length,r1.calls);
    assert.ok(lines.some(l=>l.judge==='presence'&&l.answers[0].name==='real_people_count'));
    const motion=lines.find(l=>l.judge==='motion');assert.ok(motion.prev_frame_index!=null);assert.ok(Math.abs(motion.spacing_ms-2000)<=500);
    assert.ok(fetchImpl.calls.some(c=>c.url.endsWith('/responses')),'scene replay used the Luna request');
    // privacy of outputs
    for(const p of [join(clipDir,'replays'),join(clipDir,'replays',runs[0])])assert.equal((await stat(p)).mode&0o777,0o700);
    for(const f of ['run.json','results.jsonl'])assert.equal((await stat(join(clipDir,'replays',runs[0],f))).mode&0o777,0o600);
    // an alternative prompt module: different hash, separate directory, first run untouched
    const alt=join(dir,'alt-prompts.mjs');
    await writeFile(alt,"import {presenceRequest as base} from '"+new URL('../src/presence/decisions.mjs',import.meta.url).href+"';\nexport const presenceRequest=(img,ctx)=>{const r=base(img,ctx);r.input[0].content[0].text+=' ALT';return r;};\n");
    const r2=await main(['--dir',dir,'--judges','presence','--prompt-file',alt,'--label','alt','--yes'],{env,fetchImpl,log});
    const runs2=(await readdir(join(clipDir,'replays'))).filter(n=>!n.endsWith('.md'));assert.equal(runs2.length,2);
    const run2=JSON.parse(await readFile(join(clipDir,'replays',runs2.find(n=>n.endsWith('alt')),'run.json'),'utf8'));
    assert.notEqual(run2.prompt_sha256.presence,run.prompt_sha256.presence);assert.equal(run2.prompt_file,alt);
    assert.equal(JSON.parse(await readFile(join(clipDir,'replays',runs[0],'run.json'),'utf8')).prompt_sha256.presence,run.prompt_sha256.presence);
    assert.ok(r2.run_id.endsWith('alt'));
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('compare scoring: agreement, accuracy vs labels, calibration around the cutoff, disagreeing frames',()=>{
  const rec=(at,name,choice,confidence)=>({at,judge:'presence',answers:[{name,choice,confidence}]});
  const A=indexRecords([rec(1000,'real_people_count','1',0.95),rec(2000,'real_people_count','2',0.60),rec(3000,'real_people_count','0',0.9),rec(4000,'real_people_count','1',0.8)]);
  const B=indexRecords([rec(1000,'real_people_count','1',0.9),rec(2000,'real_people_count','1',0.9),rec(3000,'real_people_count','0',0.92),rec(4000,'real_people_count','2',0.5)]);
  const labels={1000:{real_people_count:'1'},2000:{real_people_count:'1'},3000:{real_people_count:'0'},4000:{real_people_count:'1'}};
  const r=compareIndexes(A,B,{labelsAt:at=>labels[at]});
  const q=r.questions.real_people_count;assert.equal(q.n,4);assert.equal(q.same,2);
  assert.equal(q.both_above.n,2);assert.equal(q.both_above.same,2);assert.equal(q.other.n,2);assert.equal(q.other.same,0);
  assert.deepEqual(r.accuracy.A.real_people_count,{n:4,correct:3});assert.deepEqual(r.accuracy.B.real_people_count,{n:4,correct:3});
  assert.deepEqual(r.calibration.A.below,{n:1,correct:0});assert.deepEqual(r.calibration.A.above,{n:3,correct:3});
  assert.deepEqual(r.disagreements.map(d=>d.at),[2000,4000]);
  assert.equal(bucketCount('11_plus'),'6_plus');assert.equal(bucketCount('5'),'4_5');assert.equal(bucketCount('3'),'3');assert.equal(cutoffFor('person_2_motion'),0.8);assert.equal(cutoffFor('costume_1'),0.85);
});

test('--compare writes a markdown report next to the runs (live vs run, per-question agreement, labels)',async()=>{
  const {dir,id}=await makeClip();const log=silent();
  try{
    const store=createCaptureStore({dir,enabled:()=>false});
    await store.addLabel(id,{real_people_count:'1'});await store.flush();
    await main(['--dir',dir,'--judges','presence','--label','one','--yes'],{env:{OPENAI_API_KEY:'k'},fetchImpl:stubFetch({counts:{n:1}}),log});
    await main(['--dir',dir,'--judges','presence','--label','two','--yes'],{env:{OPENAI_API_KEY:'k'},fetchImpl:stubFetch({counts:{n:2}}),log});
    const out=await main(['--dir',dir,'--compare','one','two'],{log});
    assert.equal(out.clips,1);
    const report=await readFile(out.file,'utf8');
    assert.match(report,/real_people_count/);assert.match(report,/Accuracy against labels/);assert.match(report,/disagree/);
    const live=await main(['--dir',dir,'--compare','live','one'],{log});assert.equal(live.clips,1);
    const lr=live.result.questions.real_people_count;assert.equal(lr.same,lr.n); // live read '1' at both judged frames; run "one" says 1
    const day=(await readdir(dir)).find(n=>/^\d{4}/.test(n));
    assert.ok((await readdir(join(dir,day,id,'replays'))).some(n=>n.startsWith('compare-')));
  }finally{await rm(dir,{recursive:true,force:true});}
});
