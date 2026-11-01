// Visit clips player: list, MP4, annotated timeline (state / people / motion / costume / events) and detector boxes.
// One time mapping (visit-time.js makeClock) ties video currentTime to capture wall time for the boxes, playhead, state label and seeking.
import {makeClock,contentRect,boxesAt,snapToFrame,stateAt,countAt,costumeAt,eventsOf,speechOf,speechLabel,countSegments,seriesOf,dirSegments,costumeSegments,motionSegments,fitLabels,isCounted} from './visit-time.js';
import {drawArrow,DIR_COLORS} from './box-arrow.js';
import {keepBox,weakShown,weakToggle,labelOf} from './box-filter.js';
import {fmtClock,turnsOfMeta,turnsOfRun,turnSegments,runRow,audioPlan,needsConfirm,confirmText} from './visit-runs.js';
const $=id=>document.getElementById(id);
const v=$('v'),canvas=$('c'),nowtxt=$('nowtxt'),info=$('info'),list=$('list'),del=$('del');
const T={state:$('t-state'),people:$('t-people'),dir:$('t-dir'),costume:$('t-costume'),events:$('t-events'),speech:$('t-speech'),vis:$('t-vis'),mic:$('t-mic'),asst:$('t-asst'),tx:$('t-tx')};
const COLORS={porch:'#ff9f43',path:'#3ddc84',sidewalk:'#4dabf7',other:'#e9ecef',ignore:'#ff6b6b'};
let selected=[],runs=[],audioSel='none',audioRun='';
let raw=null,meta=null,replay=null,view='replay',current=null,clock=null,axis=1,events=[],heads=[];
const modeBtn=$('mode');
{const wt=weakToggle();wt.style.marginLeft='8px';$('info').after(wt);}
const mctx=document.createElement('canvas').getContext('2d');mctx.font='12px system-ui,sans-serif';
const measure=t=>mctx.measureText(t).width;
// Effective data: the replayed tracker's timelines/boxes by default, as recorded on request (or when the replay is unavailable).
const effective=()=>view==='replay'&&replay?{...raw,timeline:replay.timeline,counts:replay.counts,detections:replay.detections,initial_state:replay.initial_state}:raw;
const fmt=ms=>{const s=Math.round(ms/1000);return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');};
const mb=b=>(b/1048576).toFixed(1)+' MB';
const pct=t=>Math.min(100,Math.max(0,t/axis*100))+'%';
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};

async function load(){
  const r=await fetch('/api/visits',{cache:'no-store'}).then(x=>x.json()).catch(()=>({visits:[]}));
  list.replaceChildren(...r.visits.map(c=>{
    const b=el('button');b.type='button';b.setAttribute('aria-current',String(c.id===current));
    const tag=el('span','tag '+c.max_state,c.max_state);
    const sub=el('span','mut',`${fmt(c.duration_ms)}  ${c.peak_count!=null?c.peak_count+' max  ':''}${c.costumes?.length?c.costumes.join(', ')+'  ':''}${c.video?'':'  encoding'}`);
    sub.style.gridColumn='1 / span 2';
    b.append(el('span',null,new Date(c.start).toLocaleString()),tag,sub);b.onclick=()=>open(c.id);return b;}));
  if(!current&&r.visits[0])open(r.visits[0].id);
}
function seekWall(w){if(!meta)return;v.currentTime=clock.toVideo(w)/1000;}
function marker(parent,t,cls,label,w){
  const b=el('button','mk '+cls,label);b.type='button';b.style.left=pct(t);b.title=`${label}  ${fmt(t)}`;b.dataset.t=String(t);
  b.onclick=e=>{e.stopPropagation();seekWall(t);};parent.appendChild(b);return b;
}
function segment(parent,s,cls,label,bg,show=true){
  const d=el('div','seg '+cls,show?label:'');d.style.left=pct(s.t);d.style.width=`calc(${pct(s.end)} - ${pct(s.t)})`;if(bg)d.style.background=bg;d.dataset.t=String(s.t);d.title=`${label}  ${fmt(s.t)}`;parent.appendChild(d);return d;
}
// Segments with a label only where it fits (hover title always has it); never overlapping text.
function segments(parent,items,cls,bgOf){
  const w=parent.clientWidth||600;
  fitLabels(items,axis,w,measure).forEach(i=>{const d=segment(parent,i,typeof cls==='function'?cls(i):cls,i.label,bgOf?bgOf(i):null,i.show);if(i.title)d.title=`${i.title}  ${fmt(i.t)}`;});
}
// Speech-row markers. Nudges (approach, porch, silence joke) get their own colour and a short label that is shown only where it fits (hover always names it); the rest are small ticks.
function speechMarkers(parent,markers,end){
  const nud=markers.filter(m=>m.kind==='nudge_sent').map((m,i,a)=>({...m,label:m.short,end:a[i+1]?a[i+1].t:end,full:m.label}));
  fitLabels(nud,axis,parent.clientWidth||600,measure,6).forEach(m=>{const k=el('button','mk sp nudge n-'+m.n,m.show?m.short:'');k.type='button';k.style.left=pct(m.t);k.title=`${m.full}  ${fmt(m.t)}`;k.dataset.t=String(m.t);k.dataset.nudge=m.n;k.onclick=e=>{e.stopPropagation();seekWall(m.t);};parent.appendChild(k);});
  markers.filter(m=>m.kind!=='nudge_sent').forEach(m=>{const k=el('button','mk sp '+(m.kind==='first_audio_out'?'first':m.kind==='inform_sent'?'inform':/_sent$/.test(m.kind)?'sent':''),'');k.type='button';k.style.left=pct(m.t);k.title=`${m.label}${m.source&&m.source!=='audio'?' ('+m.source+')':''}  ${fmt(m.t)}`;k.dataset.t=String(m.t);k.onclick=e=>{e.stopPropagation();seekWall(m.t);};parent.appendChild(k);});
}
// Simulated visitor lines (replays): own lane, text on hover and where it fits; each segment ends before the next starts.
function visitorLane(parent,lines,end){
  segments(parent,lines.map((l,i)=>({t:l.t,end:Math.min(l.end,lines[i+1]?lines[i+1].t:end),label:l.text,title:'visitor (simulated): '+l.text})),'vis');
}
function build(){
  const end=Math.max(1,meta.end_ms||0,meta.video_ms||0);axis=end;
  for(const k in T)T[k].replaceChildren();
  // State
  const tl=(meta.timeline||[]).map((e,i,a)=>({t:e.t,end:a[i+1]?a[i+1].t:end,label:e.state,state:e.state}));
  if(!tl.length||tl[0].t>0)tl.unshift({t:0,end:tl[0]?.t??end,label:meta.initial_state||'EMPTY',state:meta.initial_state||'EMPTY'});
  segments(T.state,tl,i=>i.state,i=>`var(--${i.state.toLowerCase()})`);
  // People: debounced count segments over a thin sparkline of raw per-detection counts
  const ser=seriesOf(meta),peak=Math.max(1,...ser.map(p=>p.n));
  if(ser.length){
    const NS='http://www.w3.org/2000/svg',svg=document.createElementNS(NS,'svg');svg.setAttribute('viewBox','0 0 1000 100');svg.setAttribute('preserveAspectRatio','none');
    svg.style.cssText='position:absolute;inset:0;width:100%;height:100%;pointer-events:none;opacity:.55';
    const pts=ser.flatMap((p,i)=>{const x=p.t/end*1000,y=100-p.n/peak*90-4,px=i?(ser[i-1].t/end*1000):x;return i?[`${x},${100-ser[i-1].n/peak*90-4}`,`${x},${y}`]:[`${x},${y}`];});
    const pl=document.createElementNS(NS,'polyline');pl.setAttribute('points',pts.join(' '));pl.setAttribute('fill','none');pl.setAttribute('stroke','#ffd43b');pl.setAttribute('stroke-width','2');pl.setAttribute('vector-effect','non-scaling-stroke');
    svg.appendChild(pl);T.people.appendChild(svg);
  }
  segments(T.people,countSegments(meta).map(c=>({...c,label:String(c.count),title:c.count+(c.count===1?' person':' people')})),'cnt');
  // Motion direction (only when the sidecar has it)
  const ds=dirSegments(meta),ms=motionSegments(meta);for(const id of ['l-dir','t-dir'])$(id).hidden=!(ds.length||ms.length);
  if(ds.length)segments(T.dir,ds.map(d=>({...d,label:d.dir})),i=>i.dir,i=>DIR_COLORS[i.dir]);
  else segments(T.dir,motionSegments(meta,end).map(m=>({...m,title:m.label+(m.conf?' '+m.conf.toFixed(2):'')})),'mot');
  // Costume + motion-judge markers; events (state changes, errors, direction starts)
  segments(T.costume,costumeSegments(meta,end).map(c=>({...c,title:c.label+(c.conf?' '+c.conf.toFixed(2):'')+(c.reads>1?'  ('+c.reads+' reads)':'')})),i=>'cos'+(i.label==='no costume seen'?' none':''));
  // Speech: assistant turns (cyan, text on hover), user speech (lower amber lane), markers for connect / prompt sent / first word. Hidden for clips without speech data.
  const sp=speechOf(meta);for(const id of ['l-speech','t-speech'])$(id).hidden=!sp.has;$('l-speech').textContent=speechLabel(meta);
  if(sp.has){
    segments(T.speech,sp.assistant.map(a=>({...a,label:a.text||'speaking',title:a.text||'assistant speaking'})),'say');
    sp.user.forEach(u=>{const d=segment(T.speech,u,'hear','user',null,false);d.title=`user speaking  ${fmt(u.t)}`;});
    speechMarkers(T.speech,sp.markers,end);
  }
  for(const id of ['l-vis','t-vis'])$(id).hidden=!sp.visitor.length;
  if(sp.visitor.length)visitorLane(T.vis,sp.visitor,end);
  // Audio level lanes (mic / assistant), transcript lane (original), then one Speech + Words row pair per selected run
  const hasAudio=Boolean(meta.audio);for(const id of ['l-mic','t-mic','l-asst','t-asst'])$(id).hidden=!hasAudio;
  if(hasAudio){levels(T.mic,`/api/visits/${current}/levels?track=mic`,'#7bdff2');levels(T.asst,`/api/visits/${current}/levels?track=assistant`,'#8ce3ee');}
  const tt=turnsOfMeta(meta);for(const id of ['l-tx','t-tx'])$(id).hidden=!tt.length;
  if(tt.length)segments(T.tx,turnSegments(tt,end),i=>'tx '+i.role);
  for(const k of Object.keys(T))if(k.startsWith('run')){T[k].remove();delete T[k];}
  document.querySelectorAll('#tl .dyn').forEach(n=>n.remove());
  selected.forEach((r,n)=>{
    const tag=String.fromCharCode(65+n)+' '+r.backend;
    const sp2=speechOf({speech:r.speech||[],end_ms:end,video_ms:end,timeline:meta.timeline});
    const l1=el('span','lab dyn',tag+' speech'),k1=el('div','trk dyn');T['run'+n+'s']=k1;
    const l2=el('span','lab dyn',tag+' words'),k2=el('div','trk dyn');T['run'+n+'w']=k2;
    $('tl').append(l1,k1,l2,k2);k1.addEventListener('click',seekFromEvent);k2.addEventListener('click',seekFromEvent);
    segments(k1,sp2.assistant.map(a=>({...a,label:a.text||'speaking',title:a.text||'assistant speaking'})),'say');
    sp2.user.forEach(u=>{const d=segment(k1,u,'hear','user',null,false);d.title=`visitor speaking  ${fmt(u.t)}`;});
    speechMarkers(k1,sp2.markers,end);
    if(sp2.visitor.length){const l3=el('span','lab dyn',tag+' visitor (sim)'),k3=el('div','trk dyn');T['run'+n+'v']=k3;$('tl').append(l3,k3);k3.addEventListener('click',seekFromEvent);visitorLane(k3,sp2.visitor,end);}
    segments(k2,turnSegments(turnsOfRun(r),end),i=>'tx '+i.role);
  });
  events=eventsOf(meta);
  const ev=events.filter(e=>e.kind==='state'||e.kind==='error');
  fitLabels(ev.map((e,i)=>({...e,end:ev[i+1]?ev[i+1].t:end})),axis,T.events.clientWidth||600,measure).forEach(e=>{const m=marker(T.events,e.t,e.kind,e.show?e.label:'');m.title=`${e.label}  ${fmt(e.t)}`;});
  // video end / tail
  if(meta.video_ms<end){const tail=el('div','tail');tail.style.left=pct(meta.video_ms);tail.style.right='0';tail.title='Video ends; tracker only';T.state.appendChild(tail);}
  heads.forEach(h=>h.remove());heads=Object.values(T).map(t=>{const h=el('span');h.id='';h.style.cssText='position:absolute;top:0;bottom:0;width:2px;background:#fff;pointer-events:none;z-index:3;left:0';h.className='head';t.appendChild(h);return h;});
}
function setView(v){
  view=v;meta=effective();if(clock)build();
  modeBtn.hidden=!replay;modeBtn.textContent=view==='replay'?'Replayed with current tracker (show as recorded)':'As recorded (show replayed with current tracker)';
}
async function open(id){
  current=id;selected=[];runs=[];audioSel='none';audioRun='';raw=await fetch(`/api/visits/${id}/meta`).then(x=>x.json());replay=null;meta=raw;
  clock=makeClock(raw,null);setView(view);
  fetch(`/api/visits/${id}/replay`).then(x=>x.ok?x.json():null).then(r=>{if(current!==id||!r)return;replay=r;setView(view);}).catch(()=>{});
  v.onloadedmetadata=()=>{clock=makeClock(raw,v.duration);};
  v.src=`/api/visits/${id}/video`;setAudio();loadRuns();del.hidden=false;
  info.textContent=`${fmt(raw.video_ms)}   ${raw.end_reason||''}${raw.continued?'   continued':''}`;
  window.__visits={get runs(){return runs;},get selected(){return selected;},get meta(){return meta;},get raw(){return raw;},get clock(){return clock;},wall:()=>clock.toWall(v.currentTime*1000),seek:seekWall};
  load();
}
modeBtn.onclick=()=>setView(view==='replay'?'recorded':'replay');
let rz=0;addEventListener('resize',()=>{clearTimeout(rz);rz=setTimeout(()=>{if(meta&&clock)build();},120);});
function layout(){ // canvas = exactly the video's picture rectangle (object-fit: contain math), bitmap resized every frame it changes
  const bw=v.clientWidth,bh=v.clientHeight,dpr=window.devicePixelRatio||1;
  const r=contentRect(bw,bh,v.videoWidth,v.videoHeight);
  canvas.style.left=r.x+'px';canvas.style.top=r.y+'px';canvas.style.width=r.w+'px';canvas.style.height=r.h+'px';
  const pw=Math.round(r.w*dpr),ph=Math.round(r.h*dpr);
  if(canvas.width!==pw)canvas.width=pw;if(canvas.height!==ph)canvas.height=ph;
  return r;
}
function draw(){
  const r=layout(),w=r.w,h=r.h,dpr=window.devicePixelRatio||1;
  const g=canvas.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,w,h);
  if(!meta||!clock)return;
  const wall=clock.toWall(v.currentTime*1000);
  heads.forEach(x=>x.style.left=`calc(${pct(wall)} - 1px)`);
  const s=stateAt(meta,wall),n=countAt(meta,wall),cos=costumeAt(meta,wall);
  nowtxt.textContent=`${s.state}   ${n} ${n===1?'person':'people'}${cos?'   '+cos:''}   ${fmt(v.currentTime*1000)} / ${fmt((v.duration||0)*1000)}`;
  g.lineWidth=1;g.font='12px system-ui,sans-serif';g.textBaseline='top';
  for(const z of meta.zones||[]){
    if(!z.points?.length)continue;const col=COLORS[z.kind]||'#fff';
    g.beginPath();z.points.forEach(([x,y],i)=>i?g.lineTo(x*w,y*h):g.moveTo(x*w,y*h));g.closePath();
    g.setLineDash(z.kind==='ignore'?[2,4]:[]);g.strokeStyle=col+'55';g.stroke();
  }
  const rect={x:0,y:0,w,h};
  const showWeak=weakShown();
  for(const b of boxesAt(meta.detections,snapToFrame(raw.frame_times,wall,raw.fps||6),300)){
    if(!keepBox(b,showWeak))continue;
    const counted=isCounted(b),col=counted?(COLORS[b.zone]||'#fff'):'#8b929c',[x1,y1,x2,y2]=b.b;
    g.save();g.globalAlpha=counted?1:0.55;g.lineWidth=counted?2:1.5;g.setLineDash(counted?[]:[6,4]);g.strokeStyle=col;g.strokeRect(x1*w,y1*h,(x2-x1)*w,(y2-y1)*h);g.restore();
    const text=labelOf({src:b.src,score:b.s},b.zone),tw=g.measureText(text).width+8,ty=Math.max(0,y1*h-16);
    g.save();g.globalAlpha=counted?1:0.55;g.fillStyle=col;g.fillRect(x1*w,ty,tw,16);g.fillStyle='#111';g.fillText(text,x1*w+4,ty+2);g.restore();
    if(counted)drawArrow(g,b.b,b.v,b.dir,rect);
  }
}
(function loop(){draw();requestAnimationFrame(loop);})();
function seekFromEvent(e){const t=e.currentTarget.getBoundingClientRect();seekWall(Math.min(1,Math.max(0,(e.clientX-t.left)/t.width))*axis);}
for(const k in T)T[k].addEventListener('click',seekFromEvent);
function jump(dir){
  if(!meta)return;const w=clock.toWall(v.currentTime*1000),eps=250;
  const next=dir>0?events.find(e=>e.t>w+eps):[...events].reverse().find(e=>e.t<w-eps);
  seekWall(next?next.t:(dir>0?axis:0));
}
document.addEventListener('keydown',e=>{
  if(e.target.closest?.('input,textarea,select')||e.ctrlKey||e.metaKey||e.altKey)return;
  if(e.key==='ArrowRight'){e.preventDefault();jump(1);}
  else if(e.key==='ArrowLeft'){e.preventDefault();jump(-1);}
  else if(e.key===' '){e.preventDefault();if(v.paused)v.play().catch(()=>{});else v.pause();}
});
del.onclick=async()=>{if(!current||!confirm('Delete this clip?'))return;await fetch(`/api/visits/${current}`,{method:'DELETE'});current=null;meta=null;v.removeAttribute('src');del.hidden=true;load();};
load();setInterval(()=>{if(!document.hidden)load();},15000);

/* ---------- audio: separate <audio> elements kept in sync with the (muted) video ---------- */
const am=new Audio(),aa=new Audio();am.preload=aa.preload='auto';
const aud=$('aud'),audRun=$('aud-run'),audbox=$('audbox');
function setAudio(){
  const plan=audioPlan(audioSel,current,audioRun||null,Boolean(raw?.audio));
  for(const [a,u] of [[am,plan.mic],[aa,plan.asst]]){if(u){if(!a.src.endsWith(u))a.src=u;}else{a.pause();a.removeAttribute('src');}}
  audbox.hidden=!(raw?.audio||runs.some(r=>r.audio));syncAudio(true);
}
function syncAudio(force){
  for(const a of [am,aa]){
    if(!a.src)continue;
    if(force||Math.abs(a.currentTime-v.currentTime)>0.25)try{a.currentTime=v.currentTime;}catch{}
    a.playbackRate=v.playbackRate;
    if(v.paused||v.ended)a.pause();else if(a.paused)a.play().catch(()=>{});
  }
}
for(const e of ['play','pause','seeked','ratechange'])v.addEventListener(e,()=>syncAudio(e==='seeked'));
v.addEventListener('timeupdate',()=>syncAudio(false));
aud.onchange=()=>{audioSel=aud.value;setAudio();};
audRun.onchange=()=>{audioRun=audRun.value;if(audioSel==='none'||audioSel==='mic'){audioSel='assistant';aud.value='assistant';}setAudio();};
function levels(host,url,color){
  const m=meta;
  fetch(url).then(r=>r.ok?r.json():null).then(j=>{
    if(!j||m!==meta||!host.isConnected)return;
    const NS='http://www.w3.org/2000/svg',n=j.levels.length||1,svg=document.createElementNS(NS,'svg');svg.setAttribute('class','lvl');svg.setAttribute('viewBox',`0 0 ${n} 100`);svg.setAttribute('preserveAspectRatio','none');
    const pts=['0,100',...j.levels.map((x,i)=>`${i},${100-x}`),`${n},100`];
    const pl=document.createElementNS(NS,'polygon');pl.setAttribute('points',pts.join(' '));pl.setAttribute('fill',color);pl.setAttribute('opacity','.75');svg.appendChild(pl);
    host.querySelector('.lvl')?.remove();host.prepend(svg);
  }).catch(()=>{});
}

/* ---------- runs panel: list, pick up to two, start a replay ---------- */
const runlist=$('runlist'),rpStatus=$('rp-status'),xp=$('xp');
async function loadRuns(){
  const id=current;
  const r=await fetch(`/api/visits/${id}/runs`).then(x=>x.ok?x.json():{runs:[]}).catch(()=>({runs:[]}));
  if(id!==current)return;
  runs=r.runs||[];selected=selected.filter(s=>runs.some(x=>x.id===s.id));
  renderRuns();
}
function renderRuns(){
  runlist.replaceChildren(...(runs.length?runs.map(r=>{
    const row=el('div','run'),lab=el('label'),cb=document.createElement('input');cb.type='checkbox';cb.checked=selected.some(s=>s.id===r.id);
    cb.onchange=()=>pick(r.id,cb.checked);lab.append(cb,el('span',null,runRow(r)));row.append(lab);return row;
  }):[el('div','mut','no runs')]));
  const keep=audRun.value;audRun.replaceChildren(el('option',null,'original'),...runs.filter(r=>r.audio).map(r=>{const o=el('option',null,`${r.backend} ${new Date(r.started_at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`);o.value=r.id;return o;}));
  audRun.firstChild.value='';audRun.value=runs.some(r=>r.id===keep)?keep:'';audioRun=audRun.value;
  audbox.hidden=!(raw?.audio||runs.some(r=>r.audio));renderTranscripts();
}
async function pick(id,on){
  if(!on){selected=selected.filter(s=>s.id!==id);}
  else{
    const run=await fetch(`/api/visits/${current}/runs/${id}`).then(x=>x.ok?x.json():null).catch(()=>null);if(!run)return;
    selected=[...selected.filter(s=>s.id!==id),run].slice(-2);
  }
  renderRuns();if(meta&&clock)build();
}
function renderTranscripts(){
  const cols=[{title:'original',turns:turnsOfMeta(raw||{})},...selected.map((r,n)=>({title:String.fromCharCode(65+n)+' '+r.backend,turns:turnsOfRun(r)}))].filter(c=>c.turns.length);
  xp.hidden=!cols.length;
  $('xcols').replaceChildren(...cols.map(c=>{
    const col=el('div','xcol');col.append(el('h4',null,c.title));
    for(const t of c.turns){const b=el('button','turn '+t.role);b.type='button';b.append(el('span','tm',fmtClock(t.t)),el('b',null,t.role==='assistant'?'assistant':'visitor'),document.createTextNode(t.text.trim()));b.onclick=()=>seekWall(t.t);col.append(b);}
    return col;
  }));
}
const rpBackend=$('rp-backend'),rpJudges=$('rp-judges');
function rpSync(){const need=needsConfirm(rpBackend.value,rpJudges.value);$('rp-cl').hidden=!need;$('rp-ct').textContent=confirmText(rpBackend.value,rpJudges.value);if(!need)$('rp-confirm').checked=false;
  if(rpBackend.value==='fake'&&rpJudges.value==='real'){}}
rpBackend.onchange=()=>{if(rpBackend.value==='fake')rpJudges.value='fake';else if(rpJudges.value==='fake')rpJudges.value='recorded';rpSync();};rpJudges.onchange=rpSync;rpSync();
$('rp-go').onclick=async()=>{
  if(!current)return;
  const body={backend:rpBackend.value,judges:rpJudges.value,confirm:$('rp-confirm').checked,max_cost_usd:Number($('rp-cost').value)};
  const r=await fetch(`/api/visits/${current}/replay`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json().catch(()=>({}));
  rpStatus.textContent=r.ok?'started':(j.error||'refused');pollReplay();
};
let rpTimer=null;
async function pollReplay(){
  clearTimeout(rpTimer);
  const st=await fetch('/api/replay/status').then(x=>x.json()).catch(()=>({state:'idle'}));
  if(st.state==='running'){const p=st.progress;rpStatus.textContent=`running ${st.backend}`+(p?`  ${fmtClock(p.t_ms)} / ${fmtClock(p.of_ms)}`:'');$('rp-go').disabled=true;rpTimer=setTimeout(pollReplay,1500);}
  else{$('rp-go').disabled=false;if(st.state==='done'){rpStatus.textContent='done';loadRuns();}else if(st.state==='error')rpStatus.textContent=st.error||'failed';else if(st.state==='cancelled')rpStatus.textContent='cancelled';}
}
pollReplay();
