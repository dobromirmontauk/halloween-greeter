// A UI replay is refused while the app is ON and someone is present (fake detector, synthetic data only).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../server.mjs';

const jpeg=Buffer.from([255,216,255,217]);
test('HTTP: a replay is refused while someone is on the sidewalk (mode ON)',{timeout:60000},async()=>{
  const base0=mkdtempSync(join(tmpdir(),'rr-')),visits=join(base0,'visits'),id='20261026-190000-abc123';
  mkdirSync(join(visits,id),{recursive:true});writeFileSync(join(visits,id,'visit.json'),JSON.stringify({version:1,id,video_ms:1000,end_ms:1000,frame_count:1,frame_times:[0],timeline:[],detections:[]}));writeFileSync(join(visits,id,'video.mp4'),'stub');
  const fakeSpawn=()=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.kill=()=>{};
    child.stdin={on(){},end(){},write(line){const req=JSON.parse(line);if(req.cmd==='shutdown')return;setImmediate(()=>child.stdout.emit('data',Buffer.from(JSON.stringify({id:req.id,ok:true,persons:[{bbox:[0.63,0.0,0.69,0.2],score:0.9}],ms:3,width:960,height:540})+'\n')));}};
    setImmediate(()=>child.stdout.emit('data',Buffer.from('{"ready":true}\n')));return child;};
  const spawned=[];
  const server=createServer({env:{CAMERA_URL:'rtsp://x/s',OPENAI_API_KEY:'k',AUTO_START:'true',DETECTOR_FPS:'15',PRIMARY_READ_MS:'250',VISIT_DIR:visits,REPLAY_DIR:join(base0,'replay'),JUDGE_LOG_DIR:join(base0,'jl'),SESSIONS_DIR:join(base0,'s'),COSTS_DIR:join(base0,'c')},
    captureImpl:async()=>jpeg,fetchImpl:async()=>({ok:true,json:async()=>({answers:[]})}),detectorSpawnImpl:fakeSpawn,replaySpawnImpl:(cmd,args)=>{spawned.push(args);const p=new EventEmitter();p.stdout=new EventEmitter();p.stderr=new EventEmitter();p.kill=()=>{};return p;}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const end=Date.now()+30000;let g='EMPTY';
    while(Date.now()<end){g=(await (await fetch(`${base}/api/judge/status`)).json()).group_state;if(g!=='EMPTY')break;await new Promise(r=>setTimeout(r,100));}
    assert.notEqual(g,'EMPTY','the fake detector put someone on the sidewalk');
    const res=await fetch(`${base}/api/visits/${id}/replay`,{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({backend:'fake'})});
    assert.equal(res.status,409);assert.match((await res.json()).error,/present|empty/i);assert.equal(spawned.length,0);
  }finally{await server.stopAutomation();await new Promise(r=>server.close(r));rmSync(base0,{recursive:true,force:true});}
});
