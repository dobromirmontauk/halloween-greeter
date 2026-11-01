import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCaptureStore,labelResolver,sanitizeClipLabel,validClipId} from '../src/presence/capture-store.mjs';
import {createServer} from '../server.mjs';

const here=dirname(fileURLToPath(import.meta.url));
// Synthetic bytes only: never real camera images in tests.
const jpeg=n=>Buffer.from([0xff,0xd8,n&255,(n>>8)&255,0xff,0xd9]);
const frame=at=>({bytes:jpeg(at/10),at});
const answers=n=>[{name:'real_people_count',choice:String(n),confidence:0.99}];

async function setup(opts={}){
  const dir=await mkdtemp(join(tmpdir(),'cap-'));const clock={t:0};let on=true;
  const store=createCaptureStore({dir,now:()=>clock.t,enabled:()=>on,tickMs:3600000,meta:async()=>({rotate:180,ptz:{pan:0.1,tilt:-0.2}}),commit:'abc123',mode:()=>'DATA_CAPTURE',freeBytes:async()=>1e12,...opts});
  const feed=(from,to,step=500)=>{for(let t=from;t<=to;t+=step){clock.t=t;store.onFrame(frame(t));}};
  const read=(extra={})=>store.noteRead({read_id:1,judge:'presence',images:[frame(clock.t)],presence:'present',prompt_sha256:'p'.repeat(64),model:'gpt-6-luna',answers:answers(1),inference_ms:700,...extra});
  const clips=async()=>(await store.list()).clips;
  return {dir,clock,store,feed,read,clips,setOn:v=>{on=v;},cleanup:async()=>{await store.close();await rm(dir,{recursive:true,force:true});}};
}

test('frames are saved only while a Presence read is >= 1 or uncertain; the interval is enforced; clips close after 5 s of confident zero',async()=>{
  const s=await setup({intervalMs:2000});
  try{
    // The yard is empty: nothing is written, not even a clip.
    for(let t=0;t<=4000;t+=1000){s.clock.t=t;s.store.onFrame(frame(t));s.read({presence:'zero',images:[frame(t)],answers:answers(0)});}
    await s.store.flush();
    assert.equal(s.store.status().recording,false);assert.deepEqual(await readdir(s.dir),[],'no frame, clip or directory for an empty yard');
    // Someone arrives; Judge reads every 1 s: one saved frame per 2 s.
    for(let t=5000;t<=9000;t+=1000){s.clock.t=t;s.store.onFrame(frame(t));s.read({read_id:t,images:[frame(t)]});}
    assert.equal(s.store.status().recording,true);
    s.clock.t=9500;s.read({read_id:9500,presence:'zero',images:[frame(9500)],answers:answers(0)});
    for(let t=10000;t<=14400;t+=500){s.clock.t=t;s.store.onFrame(frame(t));}
    assert.equal(s.store.status().recording,true,'still open before 5 s of zero');
    s.clock.t=14500;s.store.tick();assert.equal(s.store.status().recording,false);
    await s.store.flush();
    const [c]=await s.clips();
    assert.equal(c.trigger,'presence');assert.equal(c.close_reason,'absent');assert.equal(c.sampling,'presence_only');assert.equal(c.capture_interval_ms,2000);
    assert.equal(c.mode,'DATA_CAPTURE');assert.equal(c.deployment_commit,'abc123');assert.deepEqual(c.camera,{rotate:180,ptz:{pan:0.1,tilt:-0.2}});
    const d=await s.store.get(c.clip_id);
    assert.deepEqual(d.frames.map(f=>f.at),[5000,7000,9000],'one frame every 2 s, none before the first presence, none for the zero read');
    assert.equal(c.frame_count,3);
    assert.deepEqual(d.judge.map(j=>j.frame_index),[0,1,2],'only the saved frames carry judge lines');
  }finally{await s.cleanup();}
});

test('uncertain reads are saved too (they may contain a person)',async()=>{
  const s=await setup();
  try{
    s.clock.t=1000;s.read({presence:'uncertain',images:[frame(1000)],answers:[{name:'real_people_count',choice:'uncertain',confidence:0.3}]});
    s.clock.t=3000;s.read({presence:'uncertain',images:[frame(3000)]});
    await s.store.flush();
    const [c]=await s.clips();assert.equal(c.trigger,'presence');assert.deepEqual((await s.store.get(c.clip_id)).frames.map(f=>f.at),[1000,3000]);
  }finally{await s.cleanup();}
});

test('frames are addressable by zero-padded index and capture time, byte-for-byte as received',async()=>{
  const s=await setup();
  try{
    s.clock.t=2000;s.read({images:[frame(2000)]});await s.store.flush();
    const [c]=await s.clips();const day=(await readdir(s.dir))[0];
    const names=await readdir(join(s.dir,day,c.clip_id,'frames'));
    assert.deepEqual(names,['000000_2000.jpg']);
    assert.deepEqual(await s.store.frame(c.clip_id,0),jpeg(200));
    assert.equal(await s.store.frame(c.clip_id,99999),null);
    assert.equal(await s.store.frame('../'+c.clip_id,0),null);
  }finally{await s.cleanup();}
});

test('motion lines follow their read; the previous frame is linked only when it was a saved frame',async()=>{
  const s=await setup({intervalMs:2000});
  try{
    s.clock.t=1000;s.read({read_id:1,images:[frame(1000)]});
    s.clock.t=3000;
    s.read({read_id:2,images:[frame(3000)]});
    s.store.noteRead({read_id:2,judge:'motion',images:[frame(3000),frame(1000)],presence:null,answers:[],prompt_sha256:'m'.repeat(64)});
    s.clock.t=3500;
    s.read({read_id:3,images:[frame(3500)]});  // inside the interval: not saved
    s.store.noteRead({read_id:3,judge:'motion',images:[frame(3500),frame(3000)],presence:null,answers:[]});
    await s.store.flush();
    const d=await s.store.get((await s.clips())[0].clip_id);
    assert.deepEqual(d.frames.map(f=>f.at),[1000,3000]);
    const motion=d.judge.filter(j=>j.judge==='motion');assert.equal(motion.length,1,'no line for the unsaved read');
    assert.deepEqual(motion[0].frame_indexes,[1,0]);assert.deepEqual(motion[0].frame_ats,[3000,1000]);
  }finally{await s.cleanup();}
});

test('presence again before 5 s of zero keeps the same clip open; clips roll over at the max length',async()=>{
  const s=await setup({maxClipMs:10000});
  try{
    s.clock.t=1000;s.read({images:[frame(1000)]});
    s.clock.t=3000;s.read({presence:'zero',images:[frame(3000)],answers:answers(0)});
    s.clock.t=6000;s.read({images:[frame(6000)]}); // back before 5 s elapsed
    s.clock.t=9500;s.store.tick();assert.equal((await s.clips()).length,1);
    s.clock.t=11500;s.store.tick();s.read({images:[frame(11500)]});await s.store.flush();
    const clips=await s.clips();assert.equal(clips.length,2);
    assert.ok(clips.some(c=>c.trigger==='rollover')&&clips.some(c=>c.close_reason==='max_length'));
  }finally{await s.cleanup();}
});

test('nothing is captured while disabled; leaving capture mode closes the open clip',async()=>{
  const s=await setup();
  try{
    s.setOn(false);s.clock.t=3000;s.read({images:[frame(3000)]});
    assert.deepEqual(await s.clips(),[]);assert.deepEqual(await readdir(s.dir),[]);
    s.setOn(true);s.clock.t=5000;s.read({images:[frame(5000)]});assert.equal(s.store.status().recording,true);
    s.setOn(false);s.clock.t=5500;s.store.tick();await s.store.flush();
    assert.equal(s.store.status().recording,false);assert.equal((await s.clips())[0].close_reason,'mode');
  }finally{await s.cleanup();}
});

test('retention prunes the oldest clips first and keeps the open clip',async()=>{
  const s=await setup({maxBytes:3000,intervalMs:0});
  try{
    for(let k=0;k<4;k++){
      const base=k*100000;
      for(let i=0;i<40;i++){s.clock.t=base+i*500;s.store.noteRead({read_id:base+i,judge:'presence',images:[{bytes:Buffer.alloc(100,i),at:s.clock.t}],presence:'present',answers:answers(1)});}
      s.clock.t=base+30000;s.read({presence:'zero',images:[frame(base+30000)],answers:answers(0)});
      s.clock.t=base+40000;s.store.tick();await s.store.flush();
    }
    await s.store.prune();
    const st=s.store.status();
    assert.ok(st.disk_bytes<=3000,'disk bytes within cap: '+st.disk_bytes);
    const left=await s.clips();assert.ok(left.length<4,'oldest clips were pruned');
  }finally{await s.cleanup();}
});

test('captures are private: dirs 0700, files 0600, gitignored',async()=>{
  const s=await setup();
  try{
    s.clock.t=3000;s.read({images:[frame(3000)]});
    await s.store.flush();
    await s.store.addLabel((await s.clips())[0].clip_id,{real_people_count:'1'});
    s.store.noteEvent({type:'NEW_PARTY',at:3000});await s.store.flush();
    const walk=async d=>{const out=[];for(const e of await readdir(d,{withFileTypes:true})){const p=join(d,e.name);out.push(p);if(e.isDirectory())out.push(...await walk(p));}return out;};
    const all=[s.dir,...await walk(s.dir)];assert.ok(all.length>6);
    for(const p of all){const st=await stat(p);assert.equal(st.mode&0o777,st.isDirectory()?0o700:0o600,p);}
    const files=all.map(p=>p.split('/').pop());
    for(const f of ['clip.json','judge.jsonl','events.jsonl','labels.jsonl'])assert.ok(files.includes(f),f);
    const ignore=await readFile(join(here,'..','.gitignore'),'utf8');
    assert.match(ignore,/^\/?data\/captures\/?$/m);
  }finally{await s.cleanup();}
});

test('labels: validated, ids cannot traverse paths, latest label wins per frame/range/clip',async()=>{
  const s=await setup({intervalMs:0});
  try{
    for(const t of [1000,2000,3000,4000]){s.clock.t=t;s.read({images:[frame(t)]});}
    await s.store.flush();
    const id=(await s.clips())[0].clip_id;
    await assert.rejects(s.store.addLabel('../../etc',{real_people_count:'1'}),{status:404});
    await assert.rejects(s.store.addLabel(id,{real_people_count:'99'}),{status:400});
    await assert.rejects(s.store.addLabel(id,{frame_index:1,from_index:0,to_index:2}),{status:400});
    assert.equal(validClipId('..'),false);assert.equal(validClipId('a/b'),false);assert.equal(validClipId('20261025-101500-ab12'),true);
    await s.store.addLabel(id,{real_people_count:'1',labeler:'me'});
    await s.store.addLabel(id,{from_index:2,to_index:3,real_people_count:'2',arriving_count:'1'});
    await s.store.addLabel(id,{frame_index:3,real_people_count:'3'});
    await s.store.addLabel(id,{real_people_count:'0'});
    const lines=(await s.store.get(id)).labels_list;assert.equal(lines.length,4);
    const at=labelResolver(lines);
    assert.equal(at(0).real_people_count,'0');             // later clip-wide label wins
    assert.equal(at(2).arriving_count,'1');
    assert.equal(sanitizeClipLabel({frame_index:5,real_people_count:'2'}).scope,'frame');
  }finally{await s.cleanup();}
});

// --- server integration ---
test('server in DATA_CAPTURE records a clip from Judge reads and serves /api/captures and labels',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cap-srv-'));
  const server=createServer({
    env:{CAMERA_URL:'rtsp://camera/stream2',OPENAI_API_KEY:'test',AUDIO_MODE:'linux',START_MODE:'DATA_CAPTURE',CAPTURE_DIR:join(dir,'caps'),CAPTURE_MIN_FREE_GB:'0',MODE_FILE:join(dir,'mode.json'),SESSIONS_DIR:join(dir,'s'),JUDGE_LOG:'false'},
    captureImpl:async()=>Buffer.from([255,216,1,2,3,255,217]),
    fetchImpl:async()=>({ok:true,json:async()=>({answers:answers(1)})})
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  const post=(path,body,origin=base)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)});
  try{
    let list;for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,100));list=await (await fetch(base+'/api/captures')).json();if(list.clips.length&&list.clips[0].judge_reads>=1)break;}
    assert.equal(list.clips.length,1);assert.equal(list.capture.recording,true);assert.equal(list.clips[0].mode,'DATA_CAPTURE');
    const id=list.clips[0].clip_id;
    const mode=await (await fetch(base+'/api/mode')).json();assert.equal(mode.capture.recording,true);assert.equal(mode.capture.clip_id,id);
    assert.equal((await (await fetch(base+'/api/status')).json()).capture.clip_id,id);
    const detail=await (await fetch(base+'/api/captures/'+id)).json();
    assert.ok(detail.frames.length>=1);assert.ok(detail.judge.some(j=>j.judge==='presence'));
    const img=await fetch(base+'/api/captures/'+id+'/frames/'+detail.frames[0].index);
    assert.equal(img.status,200);assert.equal(img.headers.get('content-type'),'image/jpeg');
    assert.deepEqual(Buffer.from(await img.arrayBuffer()),Buffer.from([255,216,1,2,3,255,217]));
    assert.equal((await fetch(base+'/api/captures/..%2F..%2Fetc')).status,404);
    assert.equal((await fetch(base+'/api/captures/'+id+'/frames/999')).status,404);
    assert.equal((await post('/api/captures/'+id+'/labels',{real_people_count:'1'},'http://evil.example')).status,403);
    assert.equal((await post('/api/captures/'+id+'/labels',{real_people_count:'nope'})).status,400);
    assert.equal((await post('/api/captures/'+id+'/labels',{real_people_count:'1',labeler:'t'})).status,200);
    assert.equal((await (await fetch(base+'/api/captures/'+id)).json()).labels_list.length,1);
  }finally{await server.stopAutomation();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('ON mode does not capture unless CAPTURE_IN_ON=true',async()=>{
  for(const flag of [undefined,'true']){
    const dir=await mkdtemp(join(tmpdir(),'cap-srv-'));
    const server=createServer({
      env:{CAMERA_URL:'rtsp://camera/stream2',OPENAI_API_KEY:'test',START_MODE:'ON',CAPTURE_IN_ON:flag,CAPTURE_DIR:join(dir,'caps'),CAPTURE_MIN_FREE_GB:'0',MODE_FILE:join(dir,'mode.json'),SESSIONS_DIR:join(dir,'s'),JUDGE_LOG:'false'},
      captureImpl:async()=>Buffer.from([255,216,1,255,217]),fetchImpl:async()=>({ok:true,json:async()=>({answers:answers(1)})})
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    try{
      await new Promise(r=>setTimeout(r,800));
      const list=await (await fetch('http://127.0.0.1:'+server.address().port+'/api/captures')).json();
      assert.equal(list.clips.length,flag?1:0,'CAPTURE_IN_ON='+flag);
    }finally{await server.stopAutomation();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
  }
});
