import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {main,parseArgs,newStats,addFrame,formatReport} from '../scripts/detector-replay.mjs';
import {main as judgeReplay} from '../scripts/judge-replay.mjs';
import {analyze,readZonesFile,DEFAULT_ZONES_FILE} from '../src/presence/person-detector.mjs';

const zones=readZonesFile(DEFAULT_ZONES_FILE).zones;
const jpeg=Buffer.from([255,216,255,217]);
const porchPerson={bbox:[0.45,0.5,0.55,0.95],score:0.9},prop={bbox:[0.15,0.5,0.33,0.96],score:0.8};
function makeClip(dir,frames=5){
 const clip=join(dir,'2026-10-26','clipA');mkdirSync(join(clip,'frames'),{recursive:true});
 const ats=[];
 for(let i=1;i<=frames;i++){const at=1000+i*2000;ats.push(at);writeFileSync(join(clip,'frames',String(i).padStart(6,'0')+'_'+at+'.jpg'),jpeg);}
 writeFileSync(join(clip,'clip.json'),JSON.stringify({clip_id:'clipA',started_at:'2026-10-26T00:00:00Z',ended_at:'2026-10-26T00:01:00Z',frame_count:frames}));
 writeFileSync(join(clip,'judge.jsonl'),ats.flatMap(at=>[
  {judge:'presence',frame_ats:[at],parsed:{visitor_count:1},answers:[{name:'real_people_count',choice:'1',confidence:0.9}]},
  {judge:'motion',frame_ats:[at],parsed:{visitor_location:'porch'},answers:[]}]).map(x=>JSON.stringify(x)).join('\n')+'\n');
 writeFileSync(join(clip,'labels.jsonl'),JSON.stringify({scope:'clip',real_people_count:'1'})+'\n');
 return clip;
}
const stub=script=>{const calls=[];let i=0;return {calls,start(){},stop(){},status:()=>({state:'ready'}),call:async(cmd,p)=>{calls.push(p.jpeg.length);return script[Math.min(i++,script.length-1)];}};};

test('replay writes compare-readable results next to the clip, with a report on props, labels and location',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'detreplay-'));const clip=makeClip(dir,4);
 const sc=stub([{persons:[porchPerson,prop],ms:20},{persons:[porchPerson],ms:22},{persons:[],ms:18},{persons:[porchPerson,porchPerson],ms:25}]);
 const r=await main(['--dir',dir,'--yes'],{log:()=>{},sidecar:sc});
 assert.equal(r.frames,4);assert.equal(sc.calls.length,4);
 const runDir=join(clip,'replays',r.run_id);assert.match(r.run_id,/^detector-\d{8}-\d{6}$/);
 const rows=readFileSync(join(runDir,'results.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.deepEqual(rows.map(x=>x.answers[0].choice),['1','1','0','2']);assert.ok(rows.every(x=>x.judge==='presence'&&x.answers[0].name==='real_people_count'));
 assert.equal(rows[0].detector.ignored.length,1,'the prop box is ignored by its mask');assert.equal(rows[0].detector.location,'porch');
 assert.equal(JSON.parse(readFileSync(join(runDir,'run.json'),'utf8')).source,'detector');
 const rep=readFileSync(join(runDir,'report.md'),'utf8');
 assert.match(rep,/WITHIN those frames/);assert.match(rep,/removed by ignore masks: 1 in 1 frames/);assert.match(rep,/false negatives 1, false positives 0/);assert.match(rep,/porch -> porch: 3/);
 assert.equal(statSync(runDir).mode&0o777,0o700);assert.equal(statSync(join(runDir,'results.jsonl')).mode&0o777,0o600);
 // judge-replay --compare reads the detector run unchanged
 const cmp=await judgeReplay(['--dir',dir,'--compare','live',r.run_id],{log:()=>{}});
 assert.equal(cmp.clips,1);assert.equal(cmp.result.questions.real_people_count.n,4);assert.equal(cmp.result.questions.real_people_count.same,2);
});

test('replay is gated behind --yes and capped by --max-frames and --every',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'detreplay-'));makeClip(dir,6);
 const sc=stub([{persons:[],ms:1}]);
 assert.deepEqual(await main(['--dir',dir],{log:()=>{},sidecar:sc}),{frames:6,gated:true});assert.equal(sc.calls.length,0);
 const r=await main(['--dir',dir,'--yes','--max-frames','2'],{log:()=>{},sidecar:sc});assert.equal(r.frames,2);assert.equal(sc.calls.length,2);
 const r2=await main(['--dir',dir,'--yes','--every','3','--label','sparse'],{log:()=>{},sidecar:sc});assert.equal(r2.frames,2);assert.match(r2.run_id,/-sparse$/);
 assert.equal(existsSync(join(dir,r2.run_id+'.md')),true);
 assert.throws(()=>parseArgs(['--bogus']),/Unknown argument/);assert.throws(()=>parseArgs(['--width','5']),/--width/);
});

test('metrics: false negatives, residual false positives, prop counts and location confusion',()=>{
 const st=newStats();
 const res=persons=>analyze({persons,ms:10},{zones,at:1});
 addFrame(st,{result:res([porchPerson]),live:{count:1,location:'porch'},label:{real_people_count:'1'}});
 addFrame(st,{result:res([]),live:{count:1,location:'sidewalk'},label:{real_people_count:'1'}});          // FN
 addFrame(st,{result:res([porchPerson,prop]),live:{count:0,location:null},label:{real_people_count:'0'}}); // residual FP, prop ignored
 assert.equal(st.label.fn,1);assert.equal(st.label.fp,1);assert.equal(st.props.ignored,1);assert.equal(st.live.detector_only,1);assert.equal(st.live.judge_only,1);
 assert.equal(st.location.n,1);assert.equal(st.location.agree,1);
 assert.match(formatReport('t',st,{meta:{}}),/residual false positives .*: 1 frames/);
});
