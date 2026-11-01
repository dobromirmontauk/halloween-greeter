import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCameraStream,jpegSize} from '../src/presence/camera-stream.mjs';
import {createCaptureStore,captureConfig} from '../src/presence/capture-store.mjs';
import {main,parseArgs,resizeJpeg,applyDetail} from '../scripts/judge-replay.mjs';

// Synthetic JPEG-like bytes with a real SOF0 header so dimensions can be read; no real camera images.
const sof=(w,h,tag=0)=>Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xc0,0x00,0x11,8,h>>8,h&255,w>>8,w&255,3,1,0x22,0,2,0x11,1,3,0x11,1,tag&255,0xff,0xd9])]);
const hasFfmpeg=(()=>{try{execFileSync('ffmpeg',['-version'],{stdio:'ignore'});return true;}catch{return false;}})();

test('jpegSize reads width and height from the SOF marker',()=>{
  assert.deepEqual(jpegSize(sof(2560,1440)),{width:2560,height:1440});
  assert.equal(jpegSize(Buffer.from([1,2,3,4])),null);
});

function streamFixture(options={}){
  const children=[];
  const spawnImpl=(command,args,config)=>{
    const child=new EventEmitter();Object.assign(child,{command,args,config,stdout:new PassThrough(),stderr:new PassThrough(),stdio:[null,null,null,config.stdio.length>3?new PassThrough():undefined],killed:[]});
    child.kill=sig=>{child.killed.push(sig);};children.push(child);return child;
  };
  const stream=createCameraStream({url:'rtsp://cam/stream1',spawnImpl,stallTimeoutMs:0,...options});
  return {stream,children};
}

test('camera stream: defaults are unchanged (960 px, one output); JUDGE width is configurable',()=>{
  const a=streamFixture();a.stream.start();
  assert.ok(a.children[0].args.includes('fps=6,scale=960:-2'));
  assert.equal(a.children[0].config.stdio.length,3);assert.ok(!a.children[0].args.includes('-filter_complex'));
  const b=streamFixture({width:1280});b.stream.start();assert.ok(b.children[0].args.join(' ').includes('scale=1280:-2'));
  a.stream.stop();b.stream.stop();
});

test('camera stream: nativeFps adds a native-resolution output on fd 3 that is parsed with its dimensions',()=>{
  const {stream,children}=streamFixture({nativeFps:6,nativeQuality:2,fps:6});
  const got=[];stream.subscribeNative(f=>got.push(f));stream.start();
  const args=children[0].args.join(' ');
  assert.equal(children[0].config.stdio.length,4);
  assert.match(args,/-filter_complex \[0:v\]split=2\[a\]\[b\];\[a\]fps=6,scale=960:-2\[p\];\[b\]fps=6\[n\]/);
  assert.match(args,/-q:v 2 -f image2pipe pipe:3/);assert.match(args,/pipe:1/);
  children[0].stdio[3].write(Buffer.concat([sof(2560,1440,1),sof(2560,1440,2)]));
  assert.equal(got.length,2);assert.equal(got[0].width,2560);assert.equal(got[0].height,1440);
  const st=stream.status();assert.equal(st.native.enabled,true);assert.equal(st.native.width,2560);assert.equal(st.native.frames,2);
  // the 960 branch is untouched
  const seen=[];stream.subscribe(f=>seen.push(f));children[0].stdout.write(sof(960,540,9));assert.equal(seen.length,1);
  stream.stop();
});

test('camera stream: configureNative turns the branch on/off by restarting the decoder once',()=>{
  const {stream,children}=streamFixture();stream.start();
  assert.equal(children[0].config.stdio.length,3);
  stream.configureNative({fps:6});assert.deepEqual(children[0].killed,['SIGTERM']);
  stream.configureNative({fps:6});assert.deepEqual(children[0].killed,['SIGTERM'],'no second restart for the same setting');
  stream.stop();
});

test('clip.json records native dimensions; scaled frames are ignored while native frames flow; judged frames tie to their native twin',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'hires-'));const clock={t:0};
  const store=createCaptureStore({dir,now:()=>clock.t,tickMs:3600000,mode:()=>'DATA_CAPTURE',freeBytes:async()=>1e12});
  try{
    for(let t=0;t<=3000;t+=500){clock.t=t;store.onNativeFrame({...{bytes:sof(2560,1440,t/10),at:t,width:2560,height:1440}});store.onFrame({bytes:sof(960,540,t/10),at:t+5});}
    const judged={bytes:sof(960,540,77),at:3003};clock.t=3003;
    store.noteRead({read_id:1,judge:'presence',images:[judged],presence:'present',answers:[],prompt_sha256:'x'.repeat(64)});
    await store.flush();
    const [c]=(await store.list()).clips;
    assert.deepEqual(c.resolution,{width:2560,height:1440,native:true});
    const d=await store.get(c.clip_id);
    for(const f of d.frames)assert.deepEqual(jpegSize(await store.frame(c.clip_id,f.index)),{width:2560,height:1440},'every stored frame is native');
    const j=d.judge[0];assert.equal(j.frame_ats[0],3003,'judged (scaled) capture time is kept');
    assert.equal(d.frames.find(f=>f.index===j.frame_index).at,3000,'judge read is tied to the native twin');
    assert.equal(store.status().native.width,2560);assert.equal(store.status().native.active,true);
  }finally{await store.close();await rm(dir,{recursive:true,force:true});}
});

test('free-space guard stops recording with an error and resumes once space is back',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'hires-'));const clock={t:0};let free=100*1024**3;
  const store=createCaptureStore({dir,now:()=>clock.t,tickMs:3600000,mode:()=>'DATA_CAPTURE',freeBytes:async()=>free,minFreeBytes:3*1024**3,freeCheckMs:1000});
  const frame=at=>({bytes:sof(100,100,at/10),at});
  try{
    for(let t=0;t<=2000;t+=500){clock.t=t;store.onFrame(frame(t));}
    clock.t=2000;store.noteRead({read_id:1,judge:'presence',images:[frame(2000)],presence:'present',answers:[]});
    assert.equal(store.status().recording,true);
    free=1*1024**3;clock.t=4000;store.tick();await store.flush();
    let st=store.status();assert.equal(st.recording,false);assert.equal(st.low_disk,true);assert.match(st.error,/free disk/);
    assert.equal((await store.list()).clips[0].close_reason,'low_disk');
    clock.t=4500;store.noteRead({read_id:2,judge:'presence',images:[frame(4500)],presence:'present',answers:[]});
    assert.equal(store.status().recording,false,'no new clip while low on disk');
    free=100*1024**3;clock.t=6000;store.tick();await store.flush();
    assert.equal(store.status().low_disk,false);assert.equal(store.status().error,null);
    clock.t=6500;store.onFrame(frame(6500));store.noteRead({read_id:3,judge:'presence',images:[frame(6500)],presence:'present',answers:[]});
    assert.equal(store.status().recording,true);
  }finally{await store.close();await rm(dir,{recursive:true,force:true});}
});

test('capture config defaults: 6 GB with native capture, 5 GB without, 3 GB free-space floor',()=>{
  const gb=n=>n*1024**3;
  assert.equal(captureConfig({},'/x').maxBytes,gb(6));assert.equal(captureConfig({},'/x').native,true);
  assert.equal(captureConfig({CAPTURE_NATIVE:'false'},'/x').maxBytes,gb(5));assert.equal(captureConfig({CAPTURE_NATIVE:'false'},'/x').native,false);
  assert.equal(captureConfig({CAPTURE_MAX_GB:'2'},'/x').maxBytes,gb(2));
  assert.equal(captureConfig({},'/x').minFreeBytes,gb(3));assert.equal(captureConfig({CAPTURE_MIN_FREE_GB:'1.5'},'/x').minFreeBytes,gb(1.5));assert.equal(captureConfig({CAPTURE_MIN_FREE_GB:'0'},'/x').minFreeBytes,0);
});

test('replay options: --width and --detail validated; detail is applied to every input_image',()=>{
  assert.equal(parseArgs([]).width,960);assert.equal(parseArgs(['--width','native']).width,'native');assert.equal(parseArgs(['--width','1920']).width,1920);
  assert.equal(parseArgs(['--detail','original']).detail,'original');
  assert.throws(()=>parseArgs(['--width','big']));assert.throws(()=>parseArgs(['--detail','ultra']));
  const req={input:[{role:'user',content:[{type:'input_text',text:'t'},{type:'input_image',image_url:'x'},{type:'input_image',image_url:'y',detail:'low'}]}]};
  const out=applyDetail(req,'high');assert.deepEqual(out.input[0].content.filter(c=>c.type==='input_image').map(c=>c.detail),['high','high']);
  assert.equal(applyDetail(req,null),req);assert.equal(req.input[0].content[2].detail,'low','original request is not mutated');
});

test('replay downscales stored native frames to --width, passes --detail, and records both in run.json',{skip:!hasFfmpeg&&'ffmpeg not installed'},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'hires-'));
  try{
    const jpgPath=join(dir,'native.jpg');
    execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=gray:size=1280x720','-frames:v','1','-q:v','3',jpgPath,'-y']);
    const native=await readFile(jpgPath);assert.deepEqual(jpegSize(native),{width:1280,height:720});
    assert.deepEqual(jpegSize(await resizeJpeg(native,640)),{width:640,height:360});
    assert.equal(await resizeJpeg(native,'native'),native);assert.equal(await resizeJpeg(native,1920),native,'never upscales');
    const caps=join(dir,'caps'),clock={t:0};
    const store=createCaptureStore({dir:caps,now:()=>clock.t,tickMs:3600000,mode:()=>'DATA_CAPTURE',freeBytes:async()=>1e12});
    for(const t of [2000,4000,6000]){clock.t=t;store.noteRead({read_id:t,judge:'presence',images:[{bytes:native,at:t}],presence:'present',answers:[],parsed:{visitor_count:1}});}
    await store.flush();const id=(await store.list()).clips[0].clip_id;await store.close();
    const sent=[];
    const fetchImpl=async(url,init)=>{const body=JSON.parse(init.body);sent.push(body);
      return {ok:true,json:async()=>({answers:(body.questions||[]).map(q=>({type:'choice',name:q.name,choice:q.name==='real_people_count'?'1':q.choices[0].value,confidence:0.95})),usage:{input_tokens:10,output_tokens:2}})};};
    await main(['--dir',caps,'--judges','presence','--width','640','--detail','high','--label','w640','--yes'],{env:{OPENAI_API_KEY:'k'},fetchImpl,log:()=>{}});
    assert.ok(sent.length>=1);
    for(const body of sent){const img=body.input[0].content.find(c=>c.type==='input_image');
      assert.equal(img.detail,'high');
      assert.deepEqual(jpegSize(Buffer.from(img.image_url.split(',')[1],'base64')),{width:640,height:360});}
    const day=(await readdir(caps)).find(n=>/^\d{4}/.test(n)),runs=(await readdir(join(caps,day,id,'replays')));
    const run=JSON.parse(await readFile(join(caps,day,id,'replays',runs[0],'run.json'),'utf8'));
    assert.equal(run.width,640);assert.equal(run.detail,'high');assert.deepEqual(run.source_resolution,{width:1280,height:720});assert.deepEqual(run.sent_resolution,{width:640,height:360});
  }finally{await rm(dir,{recursive:true,force:true});}
});
