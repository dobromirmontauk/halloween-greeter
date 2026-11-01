import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from '../server.mjs';

test('live preview and analysis select frames from the same camera stream without starting extra RTSP readers',async()=>{
  let starts=0,snapshots=0,stopped=false,subscriber;
  let current={bytes:Buffer.from([255,216,1,255,217]),at:Date.now()};
  const stream={start:()=>{starts++;},snapshot:async()=>{snapshots++;return current;},latest:()=>current,subscribe:fn=>{subscriber=fn;return()=>{subscriber=null;};},stop:()=>{stopped=true;},status:()=>({state:'streaming',frames:2})};
  const server=createServer({env:{CAMERA_URL:'rtsp://private:secret@camera/stream2',OPENAI_API_KEY:'test'},cameraStreamImpl:stream,fetchImpl:async()=>({ok:true,json:async()=>({answers:[{type:'choice',name:'real_people_count',choice:'0',confidence:1},{type:'choice',name:'camera_action',choice:'stop',confidence:1},{type:'choice',name:'next_capture_ms',choice:'10000',confidence:1}]})})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`,abort=new AbortController();
  try{
    const status=await(await fetch(base+'/api/status')).json();assert.equal(status.live_video,true);
    const video=await fetch(base+'/api/video',{signal:abort.signal});assert.match(video.headers.get('Content-Type'),/multipart\/x-mixed-replace/);
    const reader=video.body.getReader();const first=Buffer.from((await reader.read()).value);assert.ok(first.includes(current.bytes));
    current={bytes:Buffer.from([255,216,2,255,217]),at:Date.now()+1};subscriber(current);
    const scene=await fetch(base+'/api/scene',{method:'POST',headers:{Origin:base},body:'{}'});assert.equal(scene.status,200);
    const snapshot=await fetch(base+'/api/frame');assert.deepEqual(Buffer.from(await snapshot.arrayBuffer()),current.bytes);
    assert.equal(starts,1);assert.equal(snapshots,2);
    const second=Buffer.from((await reader.read()).value);assert.ok(second.includes(current.bytes));
    assert.equal(JSON.stringify(status).includes('secret'),false);
  }finally{abort.abort();await server.stopAutomation();await new Promise(resolve=>server.close(resolve));}
  assert.equal(stopped,true);
});
