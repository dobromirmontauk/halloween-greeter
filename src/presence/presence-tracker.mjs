// Time-debounced group state from detector frames (~4 fps). Pure: inject times, zones and persons; no I/O.
//  - ByteTrack-lite (pure motion, no appearance/ReID): each track carries an alpha-beta (constant-velocity) filter on its box centre and size, predicted to the real frame time. Stage 1 matches high-score boxes (>= DETECTOR_PRESENCE_SCORE) to all tracks, stage 2 matches low-score boxes (0.2-0.5) to the still-unmatched confirmed tracks only (low boxes never start a track and never count). Assignment is the Hungarian algorithm on cost = (1-IoU(predicted,box)) + foot distance, gated by IoU>=0.3 or foot distance<=0.15 (0.1 for low boxes).
//  - Lifecycle: a track is tentative until seen in 2 of its last 3 frames, then confirmed; an unseen track is held for holdMs (bridges occlusion). Only confirmed tracks feed motion vectors, the greeted set and crowd events.
//  - Zone-border hysteresis (path and porch): a track enters one only once its foot is >= margin inside the polygon, and leaves only once it is >= margin outside.
//  - Asymmetric state machine EMPTY / SIDEWALK / PATH: enter SIDEWALK after enterSidewalkMs, enter PATH after enterPathMs, PATH->SIDEWALK after pathExitMs without anybody on path/porch,
//    ->EMPTY after exitMs with nobody at all. People outside every zone ("other") hold the state and never start or end anything.
//  - Count: debounced. The group count is the number of persons present in >= COUNT_FRAC (60%) of the raw per-frame detections over the last COUNT_WINDOW_MS, never the live track count (a held or re-spawned track can not add to it).
//  - Motion: every emitted person box gets track (stable id), v=[dx,dy] (filtered-foot displacement over the track's last MOTION_FRAMES frames, null under 2 frames) and dir arriving|leaving|present: leaving = foot up the image (toward the street) by LEAVE_MIN_DY 0.03 over the window with |dy|>|dx|, not while staying in the porch; arriving = mirror; lateral = present; a flip needs DIR_HOLD_MS 1000 (leaving) / ARRIVE_HOLD_MS 300 (arriving). leaveGroup = everybody on path/porch leaving, or PATH->SIDEWALK just after a leaving track.
// Env (read by createPresenceTracker via trackerOptions): GROUP_ENTER_MS_SIDEWALK=1000 GROUP_ENTER_MS_PATH=750 GROUP_EXIT_MS=3000 GROUP_PATH_EXIT_MS=1500 TRACK_HOLD_MS=1000 ZONE_MARGIN=0.02 COUNT_WINDOW_MS=1500 MOTION_MIN_DELTA=0.02 DEPART_MS=750
//  - Crowd (mixed arriving/leaving): setLive(true) (the welcome fired) marks every track on path/porch greeted. While live, a confirmed path/porch track that is arriving and was never greeted is a newcomer (reported once, then greeted); a greeted confirmed path/porch track that is leaving while others remain is a departure (reported once). takeCrowd() returns and clears the pending counts. When everybody is leaving nothing is reported here: the normal LEAVING goodbye handles it.
const AREA=['porch','path']; // priority order
export function trackerOptions(env=process.env){
 const num=(k,d,min=0)=>{const v=env[k];return v!==undefined&&v!==''&&Number.isFinite(Number(v))?Math.max(min,Number(v)):d;};
 return {enterSidewalkMs:num('GROUP_ENTER_MS_SIDEWALK',1000),enterPathMs:num('GROUP_ENTER_MS_PATH',750),exitMs:num('GROUP_EXIT_MS',3000),pathExitMs:num('GROUP_PATH_EXIT_MS',1500),holdMs:num('TRACK_HOLD_MS',1000),margin:num('ZONE_MARGIN',0.02),countWindowMs:num('COUNT_WINDOW_MS',1500),departMs:num('DEPART_MS',750),motionMinDelta:num('MOTION_MIN_DELTA',0.02),leaveMinDy:num('LEAVE_MIN_DY',0.03),dirHoldMs:num('DIR_HOLD_MS',1000),arriveHoldMs:num('ARRIVE_HOLD_MS',300),exitLatchMs:num('LEAVE_EXIT_LATCH_MS',3000)};
}
const inPoly=([x,y],pts)=>{let inside=false;for(let i=0,j=pts.length-1;i<pts.length;j=i++){const [xi,yi]=pts[i],[xj,yj]=pts[j];if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)inside=!inside;}return inside;};
const segDist=([px,py],[ax,ay],[bx,by])=>{const dx=bx-ax,dy=by-ay,l=dx*dx+dy*dy,t=l?Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/l)):0;return Math.hypot(px-(ax+t*dx),py-(ay+t*dy));};
// Signed distance from a point to a polygon: positive inside, negative outside.
export function signedDistance(p,pts){let d=Infinity;for(let i=0,j=pts.length-1;i<pts.length;j=i++)d=Math.min(d,segDist(p,pts[j],pts[i]));return inPoly(p,pts)?d:-d;}
const iou=(a,b)=>{const w=Math.min(a[2],b[2])-Math.max(a[0],b[0]),h=Math.min(a[3],b[3])-Math.max(a[1],b[1]);if(w<=0||h<=0)return 0;const i=w*h;return i/((a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-i);};
const foot=b=>[(b[0]+b[2])/2,b[3]];

// Hungarian algorithm (Kuhn-Munkres, O(n^2 m)) for a rectangular cost matrix; returns [[row,col],...] minimising total cost (every row of the smaller side is assigned).
export function hungarian(cost){
 const n=cost.length;if(!n)return [];const m=cost[0].length;if(!m)return [];
 const T=n>m,a=T?cost[0].map((_,j)=>cost.map(r=>r[j])):cost,R=a.length,C=a[0].length; // R <= C
 const u=new Array(R+1).fill(0),v=new Array(C+1).fill(0),p=new Array(C+1).fill(0),way=new Array(C+1).fill(0);
 for(let i=1;i<=R;i++){
  p[0]=i;let j0=0;const minv=new Array(C+1).fill(Infinity),used=new Array(C+1).fill(false);
  do{
   used[j0]=true;const i0=p[j0];let delta=Infinity,j1=0;
   for(let j=1;j<=C;j++)if(!used[j]){const cur=a[i0-1][j-1]-u[i0]-v[j];if(cur<minv[j]){minv[j]=cur;way[j]=j0;}if(minv[j]<delta){delta=minv[j];j1=j;}}
   for(let j=0;j<=C;j++){if(used[j]){u[p[j]]+=delta;v[j]-=delta;}else minv[j]-=delta;}
   j0=j1;
  }while(p[j0]!==0);
  do{const j1=way[j0];p[j0]=p[j1];j0=j1;}while(j0);
 }
 const out=[];for(let j=1;j<=C;j++)if(p[j])out.push(T?[j-1,p[j]-1]:[p[j]-1,j-1]);
 return out;
}

export function createPresenceTracker(opts={}){
 const o={...trackerOptions({}),...opts};
 let sideSeen=-Infinity,tracks=[],nextId=1,state='EMPTY',stateLoc='none',lastCount=0,frames=[],live=false,pendN=0,pendD=0,departSince=null,exitAt=-Infinity;
 const COUNT_FRAC=0.6,MATCH_DIST=0.15,LOW_DIST=0.1,MATCH_IOU=0.3,FOOT_W=1.5,MOTION_FRAMES=4,ALPHA=0.8,BETA=0.4,BIG=1e4,MAX_V=1.5,INHERIT_DIST=0.12;
 const since={sidewalk:null,path:null,none:null,offPath:null};
 // Alpha-beta (constant-velocity) filter on the box centre; size is smoothed with the same alpha. dt comes from the real frame timestamps.
 const boxOf=tr=>[tr.cx-tr.w/2,tr.cy-tr.h/2,tr.cx+tr.w/2,tr.cy+tr.h/2];
 const dtOf=(tr,t)=>Math.max(0,Math.min(2,(t-tr.t)/1000));
 const predBox=(tr,t)=>{const dt=dtOf(tr,t),cx=tr.cx+tr.vx*dt,cy=tr.cy+tr.vy*dt;return [cx-tr.w/2,cy-tr.h/2,cx+tr.w/2,cy+tr.h/2];};
 function filterUpdate(tr,box,t){
  const dt=dtOf(tr,t),z={cx:(box[0]+box[2])/2,cy:(box[1]+box[3])/2,w:box[2]-box[0],h:box[3]-box[1]};
  const px=tr.cx+tr.vx*dt,py=tr.cy+tr.vy*dt,rx=z.cx-px,ry=z.cy-py;
  tr.cx=px+ALPHA*rx;tr.cy=py+ALPHA*ry;
  if(dt>=0.05){tr.vx=Math.max(-MAX_V,Math.min(MAX_V,tr.vx+BETA*rx/dt));tr.vy=Math.max(-MAX_V,Math.min(MAX_V,tr.vy+BETA*ry/dt));}
  tr.w+=ALPHA*(z.w-tr.w);tr.h+=ALPHA*(z.h-tr.h);tr.t=t;tr.bbox=boxOf(tr);
 }
 // Zone of a tracked foot with border hysteresis for path/porch. Non-area zones use plain containment.
 function zoneOf(tr,zones){
  const f=foot(tr.bbox),by=Object.fromEntries(AREA.map(k=>[k,zones.filter(z=>z.kind===k)]));
  const depth=k=>Math.max(-Infinity,...by[k].map(z=>signedDistance(f,z.points)));
  for(const k of AREA)if(by[k].length&&depth(k)>=o.margin)return k; // clearly inside: enters (porch beats path)
  if(AREA.includes(tr.zone)&&by[tr.zone].length&&depth(tr.zone)>-o.margin)return tr.zone; // not clearly outside: stays
  for(const z of zones)if(z.kind==='sidewalk'&&inPoly(f,z.points))return 'sidewalk';
  for(const k of AREA)if(by[k].length&&depth(k)>=0)return 'sidewalk'; // shallow inside path/porch from outside: still the sidewalk side
  return 'other';
 }
 const r3=v=>Math.round(v*1000)/1000;
 // Only confirmed tracks get a motion vector: v from the filtered foot over the last MOTION_FRAMES frames. dir is about the street, not the porch centre: leaving = foot moving UP the image (toward the sidewalk) by >= leaveMinDy with |dy|>|dx| and not while staying inside the porch; arriving = the mirror (down, vertical dominant); lateral or tiny motion = present. A change of dir needs the new raw dir to persist (dirHoldMs for leaving, arriveHoldMs for arriving) so standing jitter and a brief wobble never flip it.
 function rawDir(tr){
  const a=tr.hist[0],b=tr.hist.at(-1),dx=b[0]-a[0],dy=b[1]-a[1];
  if(Math.abs(dy)<=Math.abs(dx))return 'present';
  if(dy<=-o.leaveMinDy)return tr.zone==='porch'?'present':'leaving';
  if(dy>=o.leaveMinDy)return 'arriving';
  return 'present';
 }
 function motionOf(tr,t){
  if(!tr.confirmed||tr.hist.length<2){tr.v=null;tr.dir='present';tr.dirCand=null;return;}
  const a=tr.hist[0],b=tr.hist.at(-1);
  tr.v=[r3(b[0]-a[0]),r3(b[1]-a[1])];
  const raw=rawDir(tr);
  if(raw===tr.dir){tr.dirCand=null;return;}
  if(tr.dirCand!==raw){tr.dirCand=raw;tr.dirSince=t;}
  const hold=raw==='arriving'?o.arriveHoldMs:o.dirHoldMs;
  if(t-tr.dirSince>=hold){tr.dir=raw;tr.dirCand=null;if(raw==='leaving')tr.leaveAt=t;}
 }
 // k = the largest count that at least COUNT_FRAC of the windowed frames reach.
 function windowCount(t,n){
  frames.push({t,n});frames=frames.filter(f=>t-f.t<=o.countWindowMs);
  const ns=frames.map(f=>f.n).sort((x,y)=>y-x);
  return ns[Math.ceil(COUNT_FRAC*ns.length)-1]||0;
 }
 // One assignment stage: boxes vs the given track indices, against the predicted boxes. Returns [[boxIdx,trackIdx],...].
 function match(boxes,trackIdx,preds,distGate){
  if(!boxes.length||!trackIdx.length)return [];
  const cost=boxes.map(b=>trackIdx.map(k=>{
   const pb=preds[k],v=iou(b,pb),fa=foot(b),fb=foot(pb),d=Math.hypot(fa[0]-fb[0],fa[1]-fb[1]);
   return v>=MATCH_IOU||d<=distGate?(1-v)+FOOT_W*d:BIG;
  }));
  return hungarian(cost).filter(([i,j])=>cost[i][j]<BIG).map(([i,j])=>[i,trackIdx[j]]);
 }
 // side: weak boxes (>= SIDEWALK_PRESENCE_SCORE, < presence score) already filtered to a foot in the sidewalk zone. They only keep the instant kind at 'sidewalk' (holdMs after the last one) when nothing stronger is there; they never create tracks, counts, PATH or crowd events.
 function update(persons,t,zones=[],low=[],side=[]){
  if(side.length)sideSeen=t;
  const preds=tracks.map(tr=>predBox(tr,t)),seenNow=new Set(),owner=new Array(persons.length).fill(null);
  // Stage 1: high-score boxes vs every track (confirmed, tentative and held).
  const m1=match(persons.map(p=>p.bbox),tracks.map((_,k)=>k),preds,MATCH_DIST),usedBox=new Set();
  for(const [i,k] of m1){usedBox.add(i);seenNow.add(k);owner[i]=tracks[k];}
  // Stage 2: low-score boxes vs the still-unmatched confirmed tracks. They only keep a track alive; they never start one and never count.
  const rest=tracks.map((_,k)=>k).filter(k=>!seenNow.has(k)&&tracks[k].confirmed),lowHit=new Map();
  for(const [i,k] of match(low.map(l=>l.bbox),rest,preds,LOW_DIST)){seenNow.add(k);lowHit.set(k,low[i].bbox);}
  for(const [i,k] of m1)filterUpdate(tracks[k],persons[i].bbox,t);
  for(const [k,b] of lowHit)filterUpdate(tracks[k],b,t);
  tracks.forEach((tr,k)=>{
   tr.hits.push(seenNow.has(k));while(tr.hits.length>3)tr.hits.shift();
   if(seenNow.has(k)){tr.seen=t;if(!tr.confirmed&&tr.hits.filter(Boolean).length>=2)tr.confirmed=true;tr.hist.push(foot(tr.bbox));while(tr.hist.length>MOTION_FRAMES)tr.hist.shift();}
  });
  // Unmatched high-score boxes start tentative tracks. A box right where a greeted track is currently unseen (held) is that person re-appearing: it inherits greeted.
  const heldGreeted=tracks.filter((tr,k)=>!seenNow.has(k)&&tr.greeted);
  persons.forEach((p,i)=>{
   if(usedBox.has(i))return;
   const f=foot(p.bbox),near=heldGreeted.find(h=>{const g=foot(h.bbox);return Math.hypot(g[0]-f[0],g[1]-f[1])<=INHERIT_DIST;});
   const tr={id:nextId++,cx:(p.bbox[0]+p.bbox[2])/2,cy:(p.bbox[1]+p.bbox[3])/2,w:p.bbox[2]-p.bbox[0],h:p.bbox[3]-p.bbox[1],vx:0,vy:0,t,bbox:p.bbox,seen:t,zone:null,hist:[f],hits:[true],confirmed:false,greeted:Boolean(near),departed:Boolean(near?.departed),v:null,dir:'present'};
   if(near)heldGreeted.splice(heldGreeted.indexOf(near),1);
   tracks.push(tr);owner[i]=tr;
  });
  tracks=tracks.filter(tr=>t-tr.seen<=o.holdMs);
  for(const tr of tracks)if(tr.seen===t)motionOf(tr,t);
  persons.forEach((p,i)=>{const tr=owner[i];p.track=tr.id;p.v=tr.v;p.dir=tr.dir;});
  for(const tr of tracks){tr.zone=zoneOf(tr,zones);if(tr.dir==='leaving')tr.leaveAt=t;}
  const zs=tracks.map(tr=>tr.zone);
  const sideHeld=t-sideSeen<=o.holdMs;
  const kind=zs.some(z=>AREA.includes(z))?'path':zs.includes('sidewalk')||sideHeld?'sidewalk':tracks.length?'other':'none';
  const instLoc=zs.includes('porch')?'porch':zs.includes('path')?'path':zs.includes('sidewalk')||sideHeld?'sidewalk':tracks.length?'other':'none';
  const mark=(key,on)=>{if(!on)since[key]=null;else since[key]??=t;};
  mark('sidewalk',kind==='sidewalk');mark('path',kind==='path');mark('none',kind==='none');mark('offPath',kind!=='path');
  const held=key=>since[key]!=null?t-since[key]:-1;
  const k=windowCount(t,persons.length);
  if(k>0)lastCount=k;
  const prevState=state;
  if(state!=='PATH'&&held('path')>=o.enterPathMs){state='PATH';}
  else if(state==='EMPTY'&&held('sidewalk')>=o.enterSidewalkMs){state='SIDEWALK';}
  else if(state==='PATH'&&kind==='sidewalk'&&held('offPath')>=o.pathExitMs){state='SIDEWALK';}
  if(state!=='EMPTY'&&held('none')>=o.exitMs){state='EMPTY';lastCount=0;}
  // Walked back out: the group left PATH/porch for the sidewalk and somebody was heading up the image just before. Crossing the porch or stepping onto the lawn never gets here.
  if(prevState==='PATH'&&state==='SIDEWALK'&&tracks.some(tr=>tr.leaveAt!==undefined&&t-tr.leaveAt<=o.exitLatchMs))exitAt=t;
  if(state==='PATH')exitAt=-Infinity;
  stateLoc=state==='EMPTY'?'none':state==='PATH'?(instLoc==='porch'?'porch':'path'):'sidewalk';
  // Reported group: debounced state, location and count (count held while the state outlasts the detections).
  const count=k||(state!=='EMPTY'?Math.max(1,lastCount):0);
  // Motion buckets from the confirmed tracks on path/porch (longest history first, at most `count` of them: a duplicate track never adds a person). null when nobody is there.
  const confArea=tracks.filter(tr=>tr.confirmed&&AREA.includes(tr.zone));
  const area=[...confArea].sort((a,b)=>b.hist.length-a.hist.length).slice(0,Math.max(count,0));
  const motion=area.length?{arriving:area.filter(tr=>tr.dir==='arriving').length,present:area.filter(tr=>tr.dir==='present').length,leaving:area.filter(tr=>tr.dir==='leaving').length,persons:area.map(tr=>({track:tr.id,v:tr.v,dir:tr.dir,zone:tr.zone,greeted:tr.greeted}))}:null;
  // Crowd: newcomers (arriving, never greeted) and departures (greeted, leaving, others remain) accumulate until takeCrowd().
  if(live){
   for(const tr of confArea)if(tr.dir==='arriving'&&!tr.greeted){tr.greeted=true;pendN++;}
   const leaving=confArea.filter(tr=>tr.greeted&&tr.dir==='leaving'),fresh=leaving.filter(tr=>!tr.departed);
   // Departures need to stand for DEPART_MS (leavers rarely all turn at the same frame: a staggered 'everybody leaves' must not look like 'some leave').
   if(fresh.length&&confArea.length>leaving.length){departSince??=t;if(t-departSince>=o.departMs){for(const tr of fresh)tr.departed=true;pendD+=fresh.length;departSince=null;}}else departSince=null;
  }
  // Group-level goodbye: everybody confirmed on path/porch is leaving by the street rule, or the group just walked back out to the sidewalk.
  const leaveGroup=(area.length>0&&area.every(tr=>tr.dir==='leaving'))||t-exitAt<=o.exitLatchMs;
  const crowd={live,newcomers:pendN,departures:pendD,area:confArea.length,greeted:confArea.filter(tr=>tr.greeted).length,remaining:confArea.filter(tr=>!(tr.greeted&&tr.dir==='leaving')).length};
  return {state,count,location:count&&state==='EMPTY'?'pending':stateLoc,instant:{kind,location:instLoc,count:tracks.length,confirmed:tracks.filter(tr=>tr.confirmed).length},tracks:tracks.length,motion,crowd,leaveGroup};
 }
 // The welcome fired (on): everybody on path/porch right now, confirmed or not, is greeted. Off: forget it all so the next party starts fresh.
 function setLive(on){
  live=Boolean(on);pendN=pendD=0;departSince=null;
  for(const tr of tracks){tr.greeted=live&&AREA.includes(tr.zone);tr.departed=false;}
  return tracks.filter(tr=>tr.greeted).length;
 }
 function takeCrowd(){const c={newcomers:pendN,departures:pendD};pendN=pendD=0;return c;}
 return {update,setLive,takeCrowd,reset(){sideSeen=-Infinity;tracks=[];frames=[];state='EMPTY';stateLoc='none';lastCount=0;live=false;exitAt=-Infinity;pendN=pendD=0;for(const k of Object.keys(since))since[k]=null;},state:()=>state,options:o};
}
