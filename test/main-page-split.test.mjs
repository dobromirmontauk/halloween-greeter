// Main page: Detector (live) is separate from Last Judge read; detector reads are never dressed up as a Judge "presence" answer.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {detectorView,judgeReadView,fmtAge} from '../public/lib.js';
import {scoreText,hudLines} from '../public/review-keys.js';
import {judgeView} from '../src/server/review-reads.mjs';
import {createServer} from '../server.mjs';
import {judgeAnswer} from './judge-fixtures.mjs';

const jpeg=Buffer.from([255,216,255,217]);
const waitFor=async(fn,ms=16000)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw Error('timeout');await new Promise(r=>setTimeout(r,25));}};
function fakeSpawn(reply){
 return ()=>{
  const child=new EventEmitter();child.stdout=new EventEmitter();child.kill=()=>{};
  child.stdin={on(){},end(){},write(line){const req=JSON.parse(line);if(req.cmd==='shutdown')return;const r=reply(req);if(r===null)return;setImmediate(()=>child.stdout.emit('data',Buffer.from(JSON.stringify({id:req.id,ok:true,...r})+'\n')));}};
  setImmediate(()=>child.stdout.emit('data',Buffer.from('{"ready":true}\n')));return child;
 };
}
const PATH_BOX=[0.5,0.55,0.56,0.7];

test('state API exposes last_judge_read, which survives detector-only reads',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mps-'));let persons=[{bbox:PATH_BOX,score:0.9}];
 const fetchImpl=async(url,opts)=>{const body=JSON.parse(opts.body);await new Promise(r=>setTimeout(r,20));return {ok:true,json:async()=>judgeAnswer(body,{count:'1',location:'path',people:[{motion:'present',face:'yes',location:'path'}],costumes:['witch']})};};
 const server=createServer({env:{CAMERA_URL:'rtsp://x/stream',OPENAI_API_KEY:'test',AUTO_START:'true',DEBUG_SPEAK:'true',DETECTOR_FPS:'15',JUDGE_LOG_DIR:join(dir,'log')},captureImpl:async()=>jpeg,fetchImpl,detectorSpawnImpl:fakeSpawn(()=>({persons,ms:4,width:960,height:540}))});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const status=async()=>(await fetch(base+'/api/judge/status')).json();
 try{
  const s=await waitFor(async()=>{const x=await status();return x.last_judge_read?.judges?.costume?.ran&&x;});
  assert.equal(s.last_judge_read.judges.presence,undefined,'detector presence is not a Judge answer');
  assert.equal((await fetch(base+'/api/judge/frame/last/now')).status,200);
  persons=[]; // yard empties: detector-only reads from now on
  const later=await waitFor(async()=>{const x=await status();return x.last_read.read_id>s.last_judge_read.read_id+2&&!x.last_read.judges.costume.ran&&!x.last_read.judges.motion.ran&&x;});
  const kept=later.last_judge_read;
  assert.ok(kept.read_id<=later.last_read.read_id);
  await new Promise(r=>setTimeout(r,1500));
  const again=await status();
  assert.equal(again.last_judge_read.read_id,kept.read_id);
  assert.ok(Object.values(again.last_judge_read.judges).every(j=>j.ran));
 }finally{await server.stopAutomation();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
});

test('detector reads render as Detector (count by zone, score), not as a Judge presence answer',()=>{
 const v=detectorView({presence_source:'detector',latest:{at:5000,ms:96.8,group:{state:'PATH'},persons:[{zone:'path',score:0.91},{zone:'sidewalk',score:0.6}],ignored:[{}]}});
 assert.deepEqual(v.zones,{sidewalk:1,path:1,porch:0,ignored:1});
 assert.equal(v.group,'PATH');assert.equal(v.topScore,0.91);assert.equal(v.ms,97);assert.equal(v.source,'detector');
 assert.equal(detectorView({presence_source:'judge_fallback',latest:{at:1,persons:[]}}).source,'judge · detector down');
 assert.equal(detectorView({}),null);
 // review page: a detector read shows detector count, never p_people or a Judge probability
 const r=judgeView({read_key:'k',captured_at:1,answers:[{name:'real_people_count',choice:'1',confidence:1}],presence_source:'detector',detector:{count:1,location:'path'}});
 assert.match(scoreText(r),/^detector 1 · path$/);assert.ok(!hudLines(r,{pos:1,total:1,tier:'people'}).some(l=>/p_people|Judge/.test(l)));
 assert.match(scoreText({presence_source:'judge',p_people:0.5}),/p_people 0.500/);
 const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 assert.ok(!/real_people_count|id="fig-prev/.test(html)&&/Detector/.test(html)&&/Last Judge read/.test(html)&&/No Judge reads yet/.test(html));
});

test('Last Judge read: no prev tile without a prev frame, only Judges that ran, none yet => null',()=>{
 const base={read_id:9,captured_at:1000,decided_at:2000,judges:{costume:{ran:true,inference_ms:700,answers:[{name:'costume_1',choice:'witch',confidence:0.9,accepted:true}]}}};
 const a=judgeReadView({...base,has_prev:false},62000);
 assert.deepEqual(a.frames.map(f=>f.key),['now']);assert.deepEqual(a.groups.map(g=>g.judge),['costume']);assert.equal(a.age,'1 min ago');
 const b=judgeReadView({...base,has_prev:true,judges:{...base.judges,motion:{ran:true,inference_ms:600,answers:[]},presence:{ran:false}}},2000);
 assert.deepEqual(b.frames.map(f=>f.key),['prev','now']);assert.deepEqual(b.groups.map(g=>g.judge),['motion','costume']);
 assert.equal(judgeReadView(null),null);assert.equal(fmtAge(1000),'just now');
});
