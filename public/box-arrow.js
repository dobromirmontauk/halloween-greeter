// Movement arrow for a detector box. Fields (optional; absent on old clips/servers -> draws nothing): v=[dx,dy] normalized foot-point displacement
// over the track's last 4 frames, dir='arriving'|'leaving'|'present'. Arrow starts at the foot point (bottom-center), ~4x v, min visible length when moving.
export const DIR_COLORS={arriving:'#3ddc84',leaving:'#ff9f43',present:'#9aa0a6'};
const SCALE=4,MIN_PX=18,MAX_PX=80; // long arrows from fast walkers swept across the picture: capped
// Pure: arrow geometry in pixels, or null. rect={x,y,w,h} of the picture; b=[x1,y1,x2,y2] normalized.
export function arrowOf(b,v,dir,rect){
  if(!b||b.length<4||!['arriving','leaving','present'].includes(dir))return null;
  const fx=rect.x+(b[0]+b[2])/2*rect.w,fy=rect.y+b[3]*rect.h;
  if(dir==='present'||!Array.isArray(v)||v.length<2||!v.every(Number.isFinite))return {x:fx,y:fy,tx:fx,ty:fy,dir,dot:true};
  let dx=v[0]*SCALE*rect.w,dy=v[1]*SCALE*rect.h;const len=Math.hypot(dx,dy);
  if(len>MAX_PX){dx*=MAX_PX/len;dy*=MAX_PX/len;}
  if(len<MIN_PX){if(len<1e-6){dx=0;dy=dir==='arriving'?MIN_PX:-MIN_PX;}else{dx*=MIN_PX/len;dy*=MIN_PX/len;}}
  return {x:fx,y:fy,tx:fx+dx,ty:fy+dy,dir,dot:false};
}
export function drawArrow(g,b,v,dir,rect){
  const a=arrowOf(b,v,dir,rect);if(!a)return;
  const col=DIR_COLORS[dir];g.save();g.setLineDash([]);g.strokeStyle=col;g.fillStyle=col;g.lineWidth=2.5;
  g.beginPath();g.arc(a.x,a.y,3,0,Math.PI*2);g.fill();
  if(!a.dot){
    g.beginPath();g.moveTo(a.x,a.y);g.lineTo(a.tx,a.ty);g.stroke();
    const ang=Math.atan2(a.ty-a.y,a.tx-a.x),h=8;g.beginPath();g.moveTo(a.tx,a.ty);
    g.lineTo(a.tx-h*Math.cos(ang-0.45),a.ty-h*Math.sin(ang-0.45));g.lineTo(a.tx-h*Math.cos(ang+0.45),a.ty-h*Math.sin(ang+0.45));g.closePath();g.fill();
  }
  g.font='10px system-ui,sans-serif';g.textBaseline='top';g.fillText(dir,a.x+6,a.y+3);g.restore();
}
