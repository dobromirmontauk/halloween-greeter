// Person-detector overlay for the live video: a canvas laid over #live-video's fixed-aspect frame box. pointer-events:none and
// absolutely positioned, so it can never shift layout. Boxes carry zone + score; static props are dashed grey; zones are outlined.
// Shared detector feed: one SSE + zones, drawn on every target (the live video and the Detector panel's frame).
import {drawArrow} from './box-arrow.js';
import {keepBox,weakShown,weakToggle,labelOf} from './box-filter.js';
let zones=[],result=null,receivedAt=0,es=null,retry=null;
const targets=[],drawAll=()=>targets.forEach(t=>t());
function attach(video,box,withToggle){
  if(!video||!box)return;
  const canvas=document.createElement('canvas');
  canvas.setAttribute('aria-hidden','true');
  Object.assign(canvas.style,{position:'absolute',left:'0',top:'0',width:'100%',height:'100%',pointerEvents:'none'});
  box.appendChild(canvas);
  const toggle=withToggle?document.createElement('button'):document.createElement('span');
  toggle.type='button';toggle.textContent='Boxes';toggle.title='Show or hide the person detector overlay';
  Object.assign(toggle.style,{position:'absolute',right:'6px',top:'6px',padding:'2px 8px',font:'12px system-ui,sans-serif',opacity:'0.75',zIndex:'2'});
  if(withToggle){box.appendChild(toggle);const wt=weakToggle(draw);Object.assign(wt.style,{position:'absolute',right:'6px',top:'32px',padding:'2px 6px',font:'12px system-ui,sans-serif',background:'rgba(0,0,0,.45)',color:'#fff',zIndex:'2'});box.appendChild(wt);}
  let on=true;try{on=localStorage.getItem('detector-overlay')!=='off';}catch{}
  const COLORS={porch:'#ff9f43',path:'#3ddc84',sidewalk:'#4dabf7',other:'#e9ecef',ignore:'#ff6b6b'};
  // The <img> uses object-fit:contain, so map normalized coordinates into the displayed picture rectangle.
  function picRect(w,h){
    const nw=video.naturalWidth||16,nh=video.naturalHeight||9,s=Math.min(w/nw,h/nh),pw=nw*s,ph=nh*s;
    return {x:(w-pw)/2,y:(h-ph)/2,w:pw,h:ph};
  }
  function draw(){
    const dpr=window.devicePixelRatio||1,w=box.clientWidth,h=box.clientHeight;
    if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}
    const g=canvas.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,w,h);
    toggle.style.opacity=on?'0.9':'0.5';
    if(!on||video.hidden)return;
    const r=picRect(w,h),px=x=>r.x+x*r.w,py=y=>r.y+y*r.h;
    g.lineWidth=1.5;g.font='12px system-ui,sans-serif';g.textBaseline='top';
    for(const z of zones){
      if(!z.points?.length)continue;
      g.beginPath();z.points.forEach(([x,y],i)=>i?g.lineTo(px(x),py(y)):g.moveTo(px(x),py(y)));g.closePath();
      g.fillStyle=(COLORS[z.kind]||'#fff')+(z.kind==='ignore'?'22':'18');g.fill();
      g.setLineDash(z.kind==='ignore'?[2,4]:[]);g.strokeStyle=(COLORS[z.kind]||'#fff')+'aa';g.stroke();
      g.fillStyle=(COLORS[z.kind]||'#fff');g.fillText(z.kind==='ignore'?'ignore: '+z.name:z.kind,px(z.points[0][0])+3,py(z.points[0][1])+3);
    }
    const label=(b,text,color,dashed)=>{
      const x=px(b[0]),y=py(b[1]),bw=(b[2]-b[0])*r.w,bh=(b[3]-b[1])*r.h;
      g.setLineDash(dashed?[6,4]:[]);g.lineWidth=2;g.strokeStyle=color;g.strokeRect(x,y,bw,bh);
      const tw=g.measureText(text).width+8,ty=Math.max(r.y,y-16);
      g.setLineDash([]);g.fillStyle=color;g.fillRect(x,ty,tw,16);g.fillStyle=dashed?'#222':'#111';g.fillText(text,x+4,ty+2);
    };
    const fresh=result&&performance.now()-receivedAt<3000?result:null; // hide boxes when the feed goes quiet
    for(const p of fresh?.persons||[]){label(p.bbox,`${p.zone} ${p.score.toFixed(2)}`,COLORS[p.zone]||COLORS.other,false);drawArrow(g,p.bbox,p.v,p.dir,r);}
    for(const p of fresh?.band||[])if(keepBox({...p,src:'band'},weakShown()))label(p.bbox,labelOf({...p,src:'band'}),'#4dd0e1',true);
    for(const p of weakShown()?fresh?.suppressed||[]:[])label(p.bbox,`prop? ${p.score.toFixed(2)}`,'#9aa0a6',true);
  }
  toggle.onclick=()=>{on=!on;try{localStorage.setItem('detector-overlay',on?'on':'off');}catch{}draw();};
  new ResizeObserver(draw).observe(box);
  video.addEventListener('load',draw);
  targets.push(draw);draw();
}
async function loadZones(){try{const r=await fetch('/api/detector/zones');if(r.ok)zones=(await r.json()).zones||[];}catch{}drawAll();}
function connect(){
  clearTimeout(retry);es?.close();
  es=new EventSource('/api/detector/events');
  es.onmessage=e=>{try{result=JSON.parse(e.data);}catch{return;}receivedAt=performance.now();requestAnimationFrame(drawAll);};
  es.onerror=()=>{es.close();result=null;drawAll();retry=setTimeout(connect,3000);};
}
const live=document.getElementById('live-video'),det=document.getElementById('det-frame');
attach(live,live?.parentElement,true);attach(det,det?.parentElement,false);
if(live||det){loadZones();setInterval(loadZones,30000);setInterval(drawAll,1000);connect();}
