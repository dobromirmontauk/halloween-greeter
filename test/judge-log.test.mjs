import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,stat,readFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createJudgeLog,compareEntry,logConfig} from '../src/presence/judge-log.mjs';
import {createServer} from '../server.mjs';
import {score,main,parseArgs} from '../scripts/judge-eval.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const tmp=()=>mkdtemp(join(tmpdir(),'judge-log-'));
const ans=(count,conf=0.95,extra={})=>({answers:[{type:'choice',name:'real_people_count',choice:count,confidence:conf},...Object.entries(extra).map(([name,choice])=>({type:'choice',name,choice,confidence:0.9}))],_query_id:'q'+Math.random().toString(36).slice(2,8)});
const img=at=>({bytes:Buffer.from([255,216,255,217]),at});
const T=Date.UTC(2026,9,25,12,0,0);
const files=async dir=>{const out=[];for(const d of await readdir(dir)){const s=await stat(join(dir,d));if(s.isDirectory())for(const f of await readdir(join(dir,d)))out.push(d+'/'+f);}return out.sort();};

test('logs reads with people at any confidence and uncertain failures; samples confident-empty once per 60s',async()=>{
 const dir=await tmp(),log=createJudgeLog({dir});
 log.record({image:img(T),result:ans('2',0.95),decided_at:T});
 log.record({image:img(T+1000),result:ans('1',0.4),error:Object.assign(Error('x'),{code:'UNCERTAIN_PEOPLE_COUNT'}),decided_at:T+1000});
 log.record({image:img(T+2000),result:ans('uncertain',0.2),error:Object.assign(Error('x'),{code:'UNCERTAIN_PEOPLE_COUNT'}),decided_at:T+2000});
 log.record({image:img(T+3000),result:ans('0'),decided_at:T+3000});          // sampled
 log.record({image:img(T+4000),result:ans('0'),decided_at:T+4000});          // skipped
 log.record({image:img(T+64000),result:ans('0'),decided_at:T+64000});        // sampled again
 await log.flush();
 const jsons=(await files(dir)).filter(f=>f.endsWith('.json')&&!f.startsWith('labels'));
 assert.equal(jsons.length,5);
 const entries=await Promise.all(jsons.map(async f=>JSON.parse(await readFile(join(dir,f),'utf8'))));
 assert.deepEqual(entries.map(e=>e.reason).sort(),['empty_sample','empty_sample','people','uncertain','uncertain']);
 assert.match(entries[0].read_id,/^q|^[0-9a-f-]+$/);
 assert.equal((await files(dir)).filter(f=>f.endsWith('.jpg')).length,5);
 await rm(dir,{recursive:true});
});

test('entry JSON holds hashes, answers, error and events; file/dir modes are private',async()=>{
 const dir=await tmp(),log=createJudgeLog({dir,commit:'abc123'});
 const request={model:'m',input:[{role:'user',content:[{type:'input_text',text:'prompt'}]}],questions:[{name:'q'}]};
 log.record({image:img(T),result:ans('3'),request,inference_ms:1234,decided_at:T});
 log.noteEvent({id:1,type:'NEW_PARTY',at:T+5,phrase:'New party approaching, 3 people.'});
 await log.flush();
 const [day]=(await readdir(dir)).filter(d=>d.startsWith('2026'));
 const names=await readdir(join(dir,day));const json=names.find(n=>n.endsWith('.json')),jpg=names.find(n=>n.endsWith('.jpg'));
 assert.equal(json.slice(0,-5),jpg.slice(0,-4));
 const e=JSON.parse(await readFile(join(dir,day,json),'utf8'));
 assert.equal(e.deployment_commit,'abc123');assert.equal(e.model,'m');assert.equal(e.inference_ms,1234);assert.match(e.prompt_sha256,/^[0-9a-f]{64}$/);
 assert.equal(e.events[0].type,'NEW_PARTY');assert.equal(e.answers[0].name,'real_people_count');
 assert.equal((await stat(dir)).mode&0o777,0o700);assert.equal((await stat(join(dir,day))).mode&0o777,0o700);
 assert.equal((await stat(join(dir,day,json))).mode&0o777,0o600);assert.equal((await stat(join(dir,day,jpg))).mode&0o777,0o600);
 await log.addLabel({read_key:day+'/'+json.slice(0,-5),real_people_count:'3'});
 assert.equal((await stat(join(dir,'labels.jsonl'))).mode&0o777,0o600);
 await rm(dir,{recursive:true});
});

test('prunes the oldest entries beyond JUDGE_LOG_MAX_ENTRIES',async()=>{
 const dir=await tmp(),log=createJudgeLog({dir,maxEntries:3});
 for(let i=0;i<6;i++)log.record({image:img(T+i*1000),result:ans('1'),decided_at:T+i*1000});
 await log.flush();
 const jsons=(await files(dir)).filter(f=>f.endsWith('.json'));
 assert.equal(jsons.length,3);assert.equal((await files(dir)).filter(f=>f.endsWith('.jpg')).length,3);
 const kept=jsons.map(f=>f.split('/')[1].split('_')[0]);assert.ok(kept.every(k=>k>='2026-10-25T12-00-03'),kept.join());
 await rm(dir,{recursive:true});
});

test('write failures never throw and surface in status',async()=>{
 const dir=join(await tmp(),'blocker');
 await (await import('node:fs/promises')).writeFile(dir,'file');
 const log=createJudgeLog({dir:join(dir,'sub')});
 assert.doesNotThrow(()=>log.record({image:img(T),result:ans('1'),decided_at:T}));
 await log.flush();assert.match(log.status().error,/Judge log write failed/);
});

test('JUDGE_LOG=false disables logging',async()=>{
 const dir=await tmp(),cfg=logConfig({JUDGE_LOG:'false',JUDGE_LOG_DIR:dir},root),log=createJudgeLog(cfg);
 log.record({image:img(T),result:ans('1'),decided_at:T});await log.flush();
 assert.deepEqual(await readdir(dir),[]);
 assert.equal(logConfig({},root).maxEntries,5000);assert.equal(logConfig({},root).enabled,true);
});

test('default log dir is gitignored and ignored paths are not tracked',()=>{
 const cfg=logConfig({},root);
 const rel=cfg.dir.slice(root.length+1);
 const out=execFileSync('git',['check-ignore','-v',join(rel,'2026-10-25','x.jpg'),join(rel,'labels.jsonl')],{cwd:root,encoding:'utf8'});
 assert.match(out,/judge-log/);
 assert.equal(execFileSync('git',['ls-files','--',rel],{cwd:root,encoding:'utf8'}).trim(),'');
});

test('labels: latest per read wins; compare marks agree/disagree',async()=>{
 const dir=await tmp(),log=createJudgeLog({dir});
 log.record({image:img(T),result:ans('2',0.95,{costume_1:'witch'}),decided_at:T});await log.flush();
 const [item]=(await log.list()).items;
 await log.addLabel({read_key:item.read_key,real_people_count:'1',costumes:['pirate']});
 let [a]=(await log.list()).items;
 assert.equal(a.compare.real_people_count.agree,false);assert.equal(a.disagree,true);
 await log.addLabel({read_key:item.read_key,real_people_count:'2',costumes:['witch'],labeler:'me'});
 [a]=(await log.list()).items;
 assert.equal(a.label.real_people_count,'2');assert.equal(a.disagree,false);assert.equal(a.compare.costumes.agree,true);
 assert.equal((await readFile(join(dir,'labels.jsonl'),'utf8')).trim().split('\n').length,2);
 assert.equal((await log.list({filter:'unlabeled'})).total,0);assert.equal((await log.list({filter:'disagreements'})).total,0);
 await assert.rejects(log.addLabel({read_key:'../etc/passwd'}),{status:400});
 await assert.rejects(log.addLabel({read_key:item.read_key,real_people_count:'99'}),{status:400});
 await assert.rejects(log.addLabel({read_key:'2026-10-25/nope'}),{status:404});
 await rm(dir,{recursive:true});
});

test('review routes list, serve image, and POST label with origin check',async()=>{
 const dir=await tmp(),log=createJudgeLog({dir});
 log.record({image:img(T),result:ans('1'),decided_at:T});await log.flush();
 const server=createServer({env:{JUDGE_LOG_DIR:dir,OPENAI_API_KEY:'x'}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 try{
  const list=await (await fetch(base+'/api/review/list')).json();assert.equal(list.total,1);
  const key=list.items[0].read_key;
  const im=await fetch(base+'/api/review/image?key='+encodeURIComponent(key));assert.equal(im.headers.get('content-type'),'image/jpeg');assert.equal((await im.arrayBuffer()).byteLength,4);
  assert.equal((await fetch(base+'/api/review/image?key=..%2F..%2Fetc%2Fpasswd')).status,404);
  const body=JSON.stringify({read_key:key,real_people_count:'1'});
  assert.equal((await fetch(base+'/api/review/label',{method:'POST',body})).status,403);
  const ok=await fetch(base+'/api/review/label',{method:'POST',body,headers:{Origin:base,'Content-Type':'application/json'}});assert.equal(ok.status,200);
  assert.equal((await (await fetch(base+'/api/judge/status')).json()).judge_log.enabled,true);
  assert.equal((await fetch(base+'/review.html')).status,200);
 }finally{server.close();}
});

test('eval scoring on synthetic entries',()=>{
 const mk=(key,count,conf,arr)=>({entry:{read_key:key,answers:[{name:'real_people_count',choice:count,confidence:conf},{name:'arriving_count',choice:arr,confidence:0.9}]},label:{real_people_count:'2',arriving_count:'1'}});
 const s=score([mk('a/1','2',0.9,'1'),mk('a/2','3',0.9,'1'),mk('a/3','1',0.5,'0')]);
 assert.equal(s.fields.real_people_count.correct,1);assert.equal(s.fields.real_people_count.n,3);
 assert.equal(s.fields.real_people_count.above.n,2);assert.equal(s.fields.real_people_count.below.n,1);
 assert.equal(s.fields.real_people_count.confusion['2']['3'],1);
 assert.equal(s.fields.arriving_count.correct,2);assert.equal(s.wrong.length,2);
});

test('eval --rerun is gated without --yes and never calls the API',async()=>{
 const dir=await tmp(),log=createJudgeLog({dir});
 log.record({image:img(T),result:ans('2'),decided_at:T});await log.flush();
 const [item]=(await log.list()).items;await log.addLabel({read_key:item.read_key,real_people_count:'2'});
 let calls=0;const lines=[];
 const r=await main(['--dir',dir,'--rerun'],{env:{OPENAI_API_KEY:'k'},fetchImpl:async()=>{calls++;throw Error('no');},log:l=>lines.push(l)});
 assert.equal(r.gated,true);assert.equal(calls,0);assert.match(lines.join('\n'),/1 paid Decisions calls/);
 const r2=await main(['--dir',dir,'--rerun','--yes'],{env:{OPENAI_API_KEY:'k'},fetchImpl:async()=>({ok:true,json:async()=>ans('1')}),log:l=>lines.push(l)});
 assert.equal(r2.rerun.fields.real_people_count.correct,0);assert.equal(r2.old.fields.real_people_count.correct,1);
 assert.ok((await readdir(dir)).some(f=>f.startsWith('eval-')));
 assert.throws(()=>parseArgs(['--bogus']));
 await rm(dir,{recursive:true});
});

import {presenceRequest,motionRequest,costumeRequest} from '../src/presence/decisions.mjs';
const a2=(name,choice,confidence=0.9)=>({type:'choice',name,choice,confidence});
test('multi-judge entries log each judge answers, prompt hash and timing; Motion saves both frames; skipped judges are recorded',async()=>{
 const dir=await tmp(),log=createJudgeLog({dir}),cur=img(T+1000),prev=img(T);
 const presenceReq=presenceRequest(cur),motionReq=motionRequest(prev,cur),costumeReq=costumeRequest(cur);
 log.record({image:cur,prev_image:prev,decided_at:T+1500,judges:{
  presence:{request:presenceReq,result:{answers:[a2('real_people_count','2')],_query_id:'qa'},inference_ms:300},
  motion:{request:motionReq,result:{answers:[a2('person_1_motion','arriving'),a2('person_1_face_or_mask_visible','yes')]},inference_ms:420},
  costume:{request:costumeReq,result:null,inference_ms:900,error:Object.assign(Error('boom'),{code:'JUDGE_TIMEOUT'})}}});
 log.record({image:img(T+9000),decided_at:T+9500,judges:{presence:{request:presenceReq,result:{answers:[a2('real_people_count','1')],_query_id:'qb'},inference_ms:250},motion:{skipped:'no_previous_frame'},costume:{request:costumeReq,result:{answers:[a2('costume_1','witch')]},inference_ms:600}}});
 await log.flush();
 const [x,y]=(await log.list()).items.sort((p,q)=>p.captured_at-q.captured_at);
 assert.equal(x.version,2);assert.equal(x.has_prev,true);assert.equal(x.judges.presence.inference_ms,300);assert.equal(x.judges.presence.prompt_sha256.length,64);
 assert.notEqual(x.judges.motion.prompt_sha256,x.judges.presence.prompt_sha256);assert.deepEqual(x.judges.motion.answers.map(r=>r.name),['person_1_motion','person_1_face_or_mask_visible']);
 assert.equal(x.judges.costume.error.code,'JUDGE_TIMEOUT');assert.equal(x.reason,'people');assert.equal(x.answers.length,3);
 assert.equal(y.has_prev,false);assert.deepEqual(y.judges.motion,{ran:false,skipped:'no_previous_frame'});
 assert.equal((await files(dir)).filter(f=>f.endsWith('_prev.jpg')).length,1);
 assert.ok(await log.image(x.read_key,{prev:true}));assert.equal(await log.image(y.read_key,{prev:true}),null);
 const small=createJudgeLog({dir,maxEntries:1});await small.prune();assert.equal((await files(dir)).filter(f=>f.endsWith('_prev.jpg')).length,0);
 assert.equal(JSON.stringify(x).includes('base64'),false,'no image data in the entry');
});
test('per-person motion labels compare on the fields that exist; legacy entries stay comparable; counts compare in Presence buckets',()=>{
 const entry={answers:[a2('real_people_count','4_5'),a2('person_1_motion','arriving'),a2('person_2_motion','leaving')]};
 const c=compareEntry(entry,{real_people_count:'5',person_1_motion:'arriving',person_2_motion:'present',person_3_motion:null,arriving_count:'1'});
 assert.equal(c.real_people_count.agree,true);assert.equal(c.person_1_motion.agree,true);assert.equal(c.person_2_motion.agree,false);assert.equal('person_3_motion' in c,false);assert.equal('arriving_count' in c,false,'new entries have no legacy bucket answers');
 const legacy={answers:[a2('real_people_count','7'),a2('arriving_count','1')]};
 const l=compareEntry(legacy,{real_people_count:'6_plus',arriving_count:'1',person_1_motion:'arriving'});
 assert.equal(l.real_people_count.agree,true);assert.equal(l.arriving_count.agree,true);assert.equal('person_1_motion' in l,false);
});
test('labels accept per-person motion values and reject others',async()=>{
 const dir=await tmp(),log=createJudgeLog({dir});log.record({image:img(T),result:ans('1'),decided_at:T});await log.flush();
 const [item]=(await log.list()).items;
 const label=await log.addLabel({read_key:item.read_key,real_people_count:'4_5',person_1_motion:'leaving'});assert.equal(label.person_1_motion,'leaving');assert.equal(label.person_2_motion,null);
 await assert.rejects(log.addLabel({read_key:item.read_key,person_1_motion:'sprinting'}),{status:400});
});

test('eval --rerun runs Motion only for entries with a logged previous frame, reports the others as skipped, and counts calls',async()=>{
 const dir=await tmp(),log=createJudgeLog({dir}),cur=img(T+1000),prev=img(T),legacy=img(T+9000);
 log.record({image:cur,prev_image:prev,decided_at:T+1500,judges:{presence:{request:presenceRequest(cur),result:{answers:[a2('real_people_count','1')]},inference_ms:1},motion:{request:motionRequest(prev,cur),result:{answers:[a2('person_1_motion','present')]},inference_ms:1},costume:{skipped:'x'}}});
 log.record({image:legacy,result:ans('1'),decided_at:T+9500});
 await log.flush();
 for(const item of (await log.list()).items)await log.addLabel({read_key:item.read_key,real_people_count:'1',person_1_motion:'arriving'});
 const bodies=[],lines=[];
 const fetchImpl=async(url,opts)=>{const b=JSON.parse(opts.body);bodies.push(b);const n=b.questions[0].name;return {ok:true,json:async()=>({answers:[a2(n,n==='person_1_motion'?'arriving':'1',0.99)]})};};
 const gated=await main(['--dir',dir,'--rerun'],{env:{OPENAI_API_KEY:'k'},fetchImpl,log:l=>lines.push(l)});
 assert.equal(gated.gated,true);assert.equal(bodies.length,0);assert.ok(lines.some(l=>/would make 3 paid Decisions calls/.test(l)),'2 Presence + 1 Motion');
 const r=await main(['--dir',dir,'--rerun','--yes'],{env:{OPENAI_API_KEY:'k'},fetchImpl,log:l=>lines.push(l)});
 assert.equal(bodies.length,3);const motion=bodies.filter(b=>b.questions[0].name==='person_1_motion');assert.equal(motion.length,1);assert.equal(motion[0].input[0].content.filter(c=>c.type==='input_image').length,2);
 assert.equal(r.rerun.skipped.length,1);assert.equal(r.rerun.fields.person_1_motion.n,1);assert.equal(r.rerun.fields.person_1_motion.correct,1);
 assert.ok(lines.some(l=>/skipped \(no previous frame/.test(l)));
});
