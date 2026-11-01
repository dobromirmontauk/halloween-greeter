import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createCosts,tokenCostUsd,liveCostUsd,PRICING,pricingForApi} from '../src/lib/costs.mjs';
import {createLinuxLive} from '../src/voice/linux-live.mjs';
import {createServer} from '../server.mjs';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);

test('token cost math uses input, cached input and output prices',()=>{
 near(tokenCostUsd('gpt-6-luna',{input:1000,output:200}),0.0002);
 near(tokenCostUsd('gpt-6-luna',{input:1_000_000,cached:400_000,output:1_000_000}),0.6*0.1+0.4*0.01+0.5);
 assert.equal(tokenCostUsd('mystery',{input:5}),null);
});
test('live seconds cost math is per second',()=>{near(liveCostUsd(60),0.05);near(liveCostUsd(90),0.075);near(liveCostUsd(1),0.05/60);});
test('pricing table has sources and verification dates',()=>{
 for(const p of pricingForApi())assert.ok(((p.model.startsWith('gemini')&&p.source.startsWith('https://ai.google.dev/')&&p.verified==='2026-10-26')||(p.source.startsWith('https://developers.openai.com/')&&p.verified==='2026-10-25'))&&!p.status);
 assert.equal(pricingForApi(PRICING.map(p=>({...p,verified:null})))[0].status,'unverified');
});
test('responses are bucketed by category, purpose and model',()=>{
 const c=createCosts();
 c.recordResponse({model:'gpt-6-luna',purpose:'judge-presence',usage:{input_tokens:1000,output_tokens:100,input_tokens_details:{cached_tokens:500}}});
 c.recordResponse({model:'gpt-6-luna',purpose:'decisions',usage:{input_tokens:1000,output_tokens:0}});
 c.recordResponse({model:'gpt-6-luna',purpose:'scene',usage:{input_tokens:2000,output_tokens:200}});
 const s=c.snapshot();
 assert.equal(s.since_start.by_category.judge.calls,2);
 assert.equal(s.since_start.by_category.judge.by_purpose['judge-presence'].cached_tokens,500);
 assert.equal(s.since_start.by_category.scene.calls,1);
 near(s.since_start.by_category.scene.usd,(2000*0.1+200*0.5)/1e6);
 assert.equal(s.since_start.by_model['gpt-6-luna'].calls,3);
 near(s.since_start.total_usd,s.today.total_usd);
 assert.ok(s.rate_usd_per_hour_last_10min>0);assert.ok(s.as_of);
});
test('live usage is cumulative per session and estimates are marked then corrected',()=>{
 const c=createCosts();
 c.recordLive({sessionId:'a',seconds:12});c.recordLive({sessionId:'a',seconds:15});
 let l=c.snapshot().since_start.by_category.live;
 assert.equal(l.seconds,15);assert.equal(l.sessions,1);near(l.usd,0.0125);
 c.recordLive({sessionId:'b',seconds:60,estimated:true});
 l=c.snapshot().since_start.by_category.live;assert.equal(l.sessions,2);assert.equal(l.estimated_seconds,60);
 c.recordLive({sessionId:'b',seconds:50,estimated:false});
 l=c.snapshot().since_start.by_category.live;assert.equal(l.seconds,65);assert.equal(l.estimated_seconds,0);
});
test('totals persist 0600 in 0700 dir and reload today only',async()=>{
 const dir=join(await mkdtemp(join(tmpdir(),'costs-')),'costs');
 const a=createCosts({dir});
 a.recordResponse({model:'gpt-6-luna',purpose:'scene',usage:{input_tokens:1000,output_tokens:200}});
 a.recordLive({sessionId:'x',seconds:30});
 await a.flush();
 const file=join(dir,`${a.snapshot().today.date}.json`);
 assert.equal((await stat(file)).mode&0o777,0o600);assert.equal((await stat(dir)).mode&0o777,0o700);
 assert.ok(JSON.parse(await readFile(file,'utf8')).totals.total_usd>0);
 const b=createCosts({dir});await b.ready();
 const s=b.snapshot();
 near(s.today.total_usd,a.snapshot().today.total_usd);assert.equal(s.since_start.total_usd,0);
 assert.equal(s.today.by_category.live.seconds,30);
});
test('writes are debounced',async()=>{
 const dir=join(await mkdtemp(join(tmpdir(),'costs-')),'costs');
 const c=createCosts({dir,debounceMs:50});
 c.recordResponse({model:'gpt-6-luna',purpose:'scene',usage:{input_tokens:1}});
 await assert.rejects(stat(dir));
 await new Promise(r=>setTimeout(r,300));
 assert.ok((await stat(dir)).isDirectory());
});
test('current porch session gets its own totals',()=>{
 let id=null;const c=createCosts({sessionId:()=>id});
 c.recordResponse({model:'gpt-6-luna',purpose:'scene',usage:{input_tokens:1000}});
 assert.equal(c.snapshot().session,null);
 id='s1';c.recordResponse({model:'gpt-6-luna',purpose:'scene',usage:{input_tokens:1000}});
 id='s2';
 let s=c.snapshot();assert.equal(s.session.id,'s2');assert.equal(s.session.total_usd,0);
 id='s1';s=c.snapshot();near(s.session.total_usd,1000*0.1/1e6);near(s.since_start.total_usd,2000*0.1/1e6);
});
test('data/costs is gitignored and untracked',()=>{
 const out=execFileSync('git',['check-ignore','-v','data/costs/2026-10-25.json'],{cwd:root,encoding:'utf8'});
 assert.match(out,/data\/costs/);
 assert.equal(execFileSync('git',['ls-files','--','data/costs'],{cwd:root,encoding:'utf8'}).trim(),'');
});
test('Live usage events update totals; missing final usage is estimated',async()=>{
 const c=createCosts();
 const ws=new EventEmitter();ws.readyState=0;ws.send=()=>{};ws.close=()=>{ws.readyState=3;};ws.terminate=ws.close;
 const spawnImpl=()=>{const ch=new EventEmitter();Object.assign(ch,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null,kill(){this.exitCode=0;}});return ch;};
 const live=createLinuxLive({env:{OPENAI_API_KEY:'k'},webSocketFactory:()=>ws,spawnImpl,closeTimeoutMs:10,onUsage:u=>c.recordLive(u)});
 const ev=v=>ws.emit('message',Buffer.from(JSON.stringify(v)));
 const p=live.start({});await Promise.resolve();ws.readyState=1;ws.emit('open');ev({type:'session.started',session:{id:'s1'}});await p;
 ev({type:'session.usage.updated',usage:{seconds:20}});
 assert.equal(c.snapshot().since_start.by_category.live.seconds,20);
 ev({type:'session.closed',usage:{seconds:30}});
 let l=c.snapshot().since_start.by_category.live;assert.equal(l.seconds,30);assert.equal(l.estimated_seconds,0);
 const p2=live.start({});await Promise.resolve();ws.readyState=1;ws.emit('open');ev({type:'session.started',session:{id:'s2'}});await p2;
 await live.stop('test');
 l=c.snapshot().since_start.by_category.live;assert.equal(l.sessions,2);assert.ok(l.seconds>=30);
});
test('server openai() hook records usage and GET /api/costs reports it',async()=>{
 const dir=join(await mkdtemp(join(tmpdir(),'costs-')),'c');
 const server=createServer({env:{CAMERA_URL:'rtsp://p:s@camera/stream2',OPENAI_API_KEY:'t',COSTS_DIR:dir},captureImpl:async()=>Buffer.from([255,216,255,217]),
  fetchImpl:async()=>({ok:true,json:async()=>({output:[],usage:{input_tokens:1000,output_tokens:100}})})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{
  await fetch(base+'/api/scene',{method:'POST',headers:{Origin:base}}).catch(()=>{});
  const s=await (await fetch(base+'/api/costs')).json();
  // The unparseable decision still bills: usage is recorded before parsing.
  assert.equal(s.since_start.by_category.judge.calls,1);near(s.since_start.by_category.judge.usd,(1000*0.1+100*0.5)/1e6);
  assert.ok(Array.isArray(s.pricing)&&s.pricing.length>=4);assert.ok('rate_usd_per_hour_last_10min' in s);
 }finally{await new Promise(r=>server.close(r));}
});
