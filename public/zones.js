// Minimal zone editor: click to add polygon points over the latest camera frame, Finish polygon, then Save zones.
// Coordinates are normalized to the picture (0..1). Saved via POST /api/detector/zones (origin-checked, validated on the server).
const $=id=>document.getElementById(id),img=$('zn-img'),canvas=$('zn-canvas'),msg=$('zn-msg');
const COLORS={porch:'#ff9f43',path:'#3ddc84',sidewalk:'#4dabf7',ignore:'#ff6b6b'};
let zones=[],draft=[];
const say=t=>{msg.textContent=t;};
function pic(){ // displayed picture rect inside the 16:9 stage (object-fit:contain)
  const w=canvas.clientWidth,h=canvas.clientHeight,nw=img.naturalWidth||16,nh=img.naturalHeight||9,s=Math.min(w/nw,h/nh);
  return {x:(w-nw*s)/2,y:(h-nh*s)/2,w:nw*s,h:nh*s,cw:w,ch:h};
}
function draw(){
  const dpr=window.devicePixelRatio||1,r=pic();
  canvas.width=Math.round(r.cw*dpr);canvas.height=Math.round(r.ch*dpr);
  const g=canvas.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.font='12px system-ui,sans-serif';
  const X=x=>r.x+x*r.w,Y=y=>r.y+y*r.h;
  const path=(pts,close)=>{g.beginPath();pts.forEach(([x,y],i)=>i?g.lineTo(X(x),Y(y)):g.moveTo(X(x),Y(y)));if(close)g.closePath();};
  for(const z of zones){const c=COLORS[z.kind];path(z.points,true);g.fillStyle=c+'30';g.fill();g.strokeStyle=c;g.lineWidth=2;g.stroke();g.fillStyle=c;g.fillText(`${z.kind}: ${z.name}`,X(z.points[0][0])+4,Y(z.points[0][1])+14);}
  if(draft.length){const c=COLORS[$('zn-kind').value];path(draft,false);g.strokeStyle=c;g.lineWidth=2;g.setLineDash([5,4]);g.stroke();g.setLineDash([]);g.fillStyle=c;for(const [x,y] of draft){g.fillRect(X(x)-3,Y(y)-3,6,6);}}
}
function renderList(){
  const ul=$('zn-list');ul.replaceChildren();
  zones.forEach((z,i)=>{const li=document.createElement('li'),s=document.createElement('span'),b=document.createElement('button');
    s.textContent=`${z.kind}: ${z.name} (${z.points.length} points)`;b.type='button';b.textContent='Delete';b.onclick=()=>{zones.splice(i,1);renderList();draw();};li.append(s,b);ul.append(li);});
}
canvas.addEventListener('pointerdown',e=>{
  const b=canvas.getBoundingClientRect(),r=pic(),x=(e.clientX-b.left-r.x)/r.w,y=(e.clientY-b.top-r.y)/r.h;
  if(x<0||x>1||y<0||y>1)return;
  draft.push([Math.round(x*10000)/10000,Math.round(y*10000)/10000]);draw();
});
$('zn-undo').onclick=()=>{draft.pop();draw();};
$('zn-close').onclick=()=>{
  if(draft.length<3)return say('Need at least 3 points.');
  const kind=$('zn-kind').value,name=$('zn-name').value.trim()||kind;
  zones.push({name,kind,points:draft});draft=[];$('zn-name').value='';renderList();draw();say('');
};
$('zn-kind').onchange=draw;
$('zn-frame').onclick=()=>{img.src='/api/frame?fresh=1&t='+Date.now();};
async function load(){
  try{const r=await fetch('/api/detector/zones'),d=await r.json();zones=(d.zones||[]).map(z=>({...z,points:z.points.map(p=>[...p])}));say(`Loaded (${d.source}).`);}catch{say('Could not load zones.');}
  renderList();draw();
}
$('zn-reload').onclick=load;
$('zn-save').onclick=async()=>{
  try{
    const r=await fetch('/api/detector/zones',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({zones})}),d=await r.json();
    say(r.ok?`Saved ${d.zones.length} zones.`:(d.error||'Save failed.'));
  }catch{say('Save failed.');}
};
img.onload=draw;img.onerror=()=>say('No camera frame yet. Start observing, then press New frame.');
window.addEventListener('resize',draw);
img.src='/api/frame?t='+Date.now();load();
