// Headless check of /visits.html against a synthetic fixture (never real camera frames): boxes align with a known moving rectangle painted into
// the video at 3 seek points, clicking markers seeks to wall time, arrows draw. Usage: node scripts/visit-eval/ui-check.mjs [playwright-core dir] [screenshot dir]
// Needs ffmpeg and playwright-core with Chrome (channel 'chrome'). Not part of `npm test`.
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {ffmpegEncode} from '../../src/visits/visit-recorder.mjs';
import {createServer} from '../../server.mjs';

const pwDir=process.argv[2]||'playwright-core';
const shots=process.argv[3]||mkdtempSync(join(tmpdir(),'visit-ui-shots-'));mkdirSync(shots,{recursive:true});
const {chromium}=createRequire(import.meta.url)(pwDir);
const tmp=mkdtempSync(join(tmpdir(),'visit-ui-')),id='20261026-120000-abc123',dir=join(tmp,'visits',id);mkdirSync(join(dir,'frames'),{recursive:true});
const A=[0.55,0.15,0.63,0.62],B=[0.2,0.3,0.3,0.8],W=640,H=360;
const frame=(name,[x1,y1,x2,y2])=>execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i',`color=c=gray:s=${W}x${H}`,'-vf',`drawbox=x=${Math.round(x1*W)}:y=${Math.round(y1*H)}:w=${Math.round((x2-x1)*W)}:h=${Math.round((y2-y1)*H)}:color=red:t=fill`,'-frames:v','1',join(dir,'frames',name)]);
frame('a.jpg',A);frame('b.jpg',B);
const times=[0,100,300,1500,3000,4800,5000,5200,6000,8000,9500]; // irregular on purpose
const frames=times.map((t,i)=>({name:t<5000?'a.jpg':'b.jpg',t}));
const lst=frames; // ffmpegEncode reads frames/<name>; repeated names are fine for concat
await ffmpegEncode({dir,frames:lst,fps:6,crf:28});
const videoMs=9500+167,dets=[];
for(let t=0;t<=9600;t+=500){const b=t<4900?A:B;dets.push({at:1e12+t,t,boxes:[{b,s:0.9,zone:'sidewalk',v:t<4900?[0.02,0.01]:[-0.02,0],dir:t<4900?'arriving':'leaving',track:1},{b:[0.8,0.1,0.9,0.3],s:0.3,zone:'other',weak:true}]});}
writeFileSync(join(dir,'visit.json'),JSON.stringify({version:1,id,started_at:new Date().toISOString(),start_ms:1e12,end_ms:11000,video_ms:videoMs,frame_count:times.length,frame_times:times,fps:6,end_reason:'post_roll',max_state:'PATH',max_persons:2,
  initial_state:'EMPTY',timeline:[{t:0,state:'EMPTY',count:0},{t:500,state:'SIDEWALK',count:1},{t:5000,state:'PATH',count:2},{t:10000,state:'EMPTY',count:0}],detections:dets,
  judge_reads:[{t:6000,read_id:1,judges:{costume:{answers:[{name:'costume_1',choice:'witch',confidence:0.92,accepted:true}]},motion:{answers:[{name:'m',choice:'arriving',confidence:0.8,accepted:true}]}}},{t:8000,judges:{costume:{error:'timeout',answers:[]}}}],
  zones:[{name:'walk',kind:'sidewalk',points:[[0,0.5],[1,0.5],[1,0.7],[0,0.7]]}],video:'video.mp4',encode:{timing:'real'}}));
rmSync(join(dir,'frames'),{recursive:true,force:true});

const server=createServer({env:{VISIT_DIR:join(tmp,'visits'),DETECTOR:'off',CAMERA_URL:'rtsp://x/s',OPENAI_API_KEY:'t'}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
let failures=0;const check=(ok,msg)=>{console.log((ok?'ok   ':'FAIL ')+msg);if(!ok)failures++;};
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
try{
  const page=await browser.newPage({viewport:{width:1280,height:900},deviceScaleFactor:2});
  page.on('pageerror',e=>{console.log('pageerror',e.message);failures++;});
  await page.goto(base+'/visits.html');await page.waitForFunction(()=>window.__visits?.meta&&document.getElementById('v').readyState>=2,null,{timeout:15000});
  const probe=async(wallMs)=>{
    await page.evaluate(ms=>{const v=document.getElementById('v');v.pause();v.currentTime=window.__visits.clock.toVideo(ms)/1000;},wallMs);
    await page.waitForFunction(()=>!document.getElementById('v').seeking,null,{timeout:5000});await page.waitForTimeout(400);
    return page.evaluate(()=>{
      const v=document.getElementById('v'),c=document.getElementById('c'),vr=v.getBoundingClientRect(),cr=c.getBoundingClientRect();
      const bounds=(data,w,h,test)=>{let x1=w,y1=h,x2=-1,y2=-1;for(let y=0;y<h;y++)for(let x=0;x<w;x++){if(test(data,(y*w+x)*4)){x1=Math.min(x1,x);x2=Math.max(x2,x);y1=Math.min(y1,y);y2=Math.max(y2,y);}}return x2<0?null:[x1/w,y1/h,(x2+1)/w,(y2+1)/h];};
      const t=document.createElement('canvas');t.width=v.videoWidth;t.height=v.videoHeight;const tg=t.getContext('2d');tg.drawImage(v,0,0);
      const vid=bounds(tg.getImageData(0,0,t.width,t.height).data,t.width,t.height,(d,i)=>d[i]>200&&d[i+1]<60&&d[i+2]<60);
      const g=c.getContext('2d'),img=g.getImageData(0,0,c.width,c.height);
      // counted solid sidewalk box = #4dabf7 stroke; find its bounds (label fill shares the colour, so use the stroke's left/bottom/right extents only)
      const cv=bounds(img.data,c.width,c.height,(d,i)=>d[i+3]>200&&Math.abs(d[i]-0x4d)<12&&Math.abs(d[i+1]-0xab)<12&&Math.abs(d[i+2]-0xf7)<12);
      return {videoBox:vid,drawn:cv,canvasRect:[cr.x-vr.x,cr.y-vr.y,cr.width,cr.height],videoRect:[vr.width,vr.height],vw:v.videoWidth,vh:v.videoHeight,now:document.getElementById('nowtxt').textContent};
    });
  };
  const near=(a,b,tol)=>a&&b&&a.every((x,i)=>Math.abs(x-b[i])<=tol);
  for(const [wall,exp] of [[1000,A],[2800,A],[7000,B]]){
    const r=await probe(wall);
    check(near(r.videoBox,exp,0.03),`wall ${wall}: video paints rect at ${exp} (got ${r.videoBox&&r.videoBox.map(n=>n.toFixed(3))})`);
    const dr=r.drawn&&[r.drawn[0],r.drawn[1],r.drawn[2],r.drawn[3]];
    // drawn bounds include the label above the box; compare x extents and bottom edge strictly, top edge is >= box top - label height
    check(dr&&Math.abs(dr[0]-exp[0])<0.03&&Math.abs(dr[2]-exp[2])<0.03&&Math.abs(dr[3]-exp[3])<0.03,`wall ${wall}: drawn box x/bottom match the video rect (got ${dr&&dr.map(n=>n.toFixed(3))})`);
    check(dr&&dr[1]<=exp[1]+0.03&&dr[1]>exp[1]-0.12,`wall ${wall}: drawn top at box top / label (got ${dr&&dr[1].toFixed(3)})`);
    const cw=r.canvasRect;check(Math.abs(cw[2]/cw[3]-16/9)<0.02&&Math.abs(cw[3]-r.videoRect[1])<2,`canvas is the 16:9 picture rect ${cw.map(n=>n.toFixed(0))} of video ${r.videoRect.map(n=>n.toFixed(0))}`);
    console.log('     now:',r.now);
    await page.screenshot({path:join(shots,`seek-${wall}.png`)});
  }
  // State/label tracks the playhead: at wall 7000 the state is PATH and the label says so with count 2 and the costume
  const r7=await probe(7000);check(/PATH/.test(r7.now)&&/2 people/.test(r7.now)&&/witch 0.92/.test(r7.now),'label shows state, count and costume at the playhead');
  // Playhead position matches wall/axis
  const head=await page.evaluate(()=>{const h=document.querySelector('#t-state .head'),t=document.getElementById('t-state');return (h.getBoundingClientRect().x+1-t.getBoundingClientRect().x)/t.getBoundingClientRect().width;});
  check(Math.abs(head-7000/11000)<0.02,`playhead at ${head.toFixed(3)} of axis (expected ${(7000/11000).toFixed(3)})`);
  // Click the costume marker and an error marker
  await page.click('#t-costume .mk.costume');await page.waitForTimeout(500);
  let w=await page.evaluate(()=>window.__visits.wall());check(Math.abs(w-6000)<350,`clicking costume marker seeks to wall ~6000 (got ${Math.round(w)})`);
  await page.click('#t-events .mk.error');await page.waitForTimeout(500);
  w=await page.evaluate(()=>window.__visits.wall());check(Math.abs(w-8000)<350,`clicking error marker seeks to wall ~8000 (got ${Math.round(w)})`);
  // Keyboard: right jumps to next event (10000 EMPTY), left back
  await page.keyboard.press('ArrowRight');await page.waitForTimeout(500);
  w=await page.evaluate(()=>window.__visits.wall());check(w>8000,`ArrowRight jumps to the next event (wall ${Math.round(w)})`);
  await page.keyboard.press('ArrowLeft');await page.keyboard.press('ArrowLeft');await page.waitForTimeout(500);
  w=await page.evaluate(()=>window.__visits.wall());check(Math.abs(w-6000)<350||Math.abs(w-5000)<350,`ArrowLeft jumps back (wall ${Math.round(w)})`);
  await page.keyboard.press('Space');await page.waitForTimeout(400);
  check(await page.evaluate(()=>!document.getElementById('v').paused),'space plays');
  await page.keyboard.press('Space');check(await page.evaluate(()=>document.getElementById('v').paused),'space pauses');
  // Track click in the people track
  const tb=await page.locator('#t-people').boundingBox();await page.mouse.click(tb.x+tb.width*0.25,tb.y+5);await page.waitForTimeout(500);
  w=await page.evaluate(()=>window.__visits.wall());check(Math.abs(w-0.25*11000)<400,`clicking the people track at 25% seeks to ~${0.25*11000} (got ${Math.round(w)})`);
  // List row summary
  const row=await page.locator('#list button').first().innerText();check(/2 max/.test(row)&&/witch/.test(row),'list row shows peak count and costume: '+row.replace(/\n/g,' | '));
  await page.screenshot({path:join(shots,'final.png'),fullPage:true});
}finally{await browser.close();server.close();rmSync(tmp,{recursive:true,force:true});}
console.log('screenshots in',shots);process.exit(failures?1:0);
