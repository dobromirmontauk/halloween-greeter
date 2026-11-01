import {reducePoll,isUnreachable,makeSnapshot,stepDisplay,isHeldView,recentItems,stateView,displayKey,personLine,detectorView,judgeReadView,modeLabel,triggerLabel,sessionHeader,costStrip,costRows,captureView,fmtClock,fmtDuration,fmtTime,fmtUsd,MODES,screamLabel} from './lib.js';
import {scheduleView,RESUME_SCHEDULE} from './schedule.js';

const $=id=>document.getElementById(id);
const fill=(el,...kids)=>el.replaceChildren(...kids.flat(Infinity).filter(k=>k!=null));
const h=(tag,props={},...kids)=>{const el=document.createElement(tag);for(const[k,v]of Object.entries(props)){if(k==='class')el.className=v;else if(k.startsWith('data-')||k.startsWith('aria-'))el.setAttribute(k,v);else el[k]=v;}for(const kid of kids.flat())if(kid!=null)el.append(kid.nodeType?kid:document.createTextNode(String(kid)));return el;};

// Fetch JSON. Returns {ok,status,data}; never throws.
async function call(path,body){
  try{
    const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    let data=null;try{data=await r.json();}catch{}
    return {ok:r.ok,status:r.status,data};
  }catch{return {ok:false,status:0,data:null};}
}

/* ---------- banner ---------- */
// The banner and mode switch render from ONE snapshot (the /api/state response, which carries app_mode and capture).
// /api/mode only feeds the schedule line and is a fallback for older servers. A failed poll never clears anything.
let poll={state:null,fails:0},fbMode=null,fbCapture=null,modeSupported=null,modeInfo=null,display=null,forceUntil=0;
const LIVE_ON=['LIVE_STARTING','LIVE_ACTIVE','MUTED','CLOSING'];
const operatorAction=()=>{forceUntil=Date.now()+3000;};

function renderBanner(){
  const now=Date.now(),unreachable=isUnreachable(poll);
  if(!poll.state&&!unreachable)return; // still connecting: leave the neutral boot banner alone
  let cur;
  if(unreachable)cur={key:'UNREACHABLE',hold:false,appMode:display?.shown.appMode??null,snap:display?.shown.snap??null,view:stateView(null,{unreachable:true})};
  else{
    const snap=makeSnapshot(poll.state,{mode:fbMode,capture:fbCapture});
    const view=stateView(poll.state,{mode:snap.appMode,capture:snap.capture});
    cur={key:displayKey(view),hold:isHeldView(view),appMode:snap.appMode,snap,view};
  }
  display=stepDisplay(display,cur,now,now<forceUntil);
  paintBanner(display.shown,display.history);
}
function paintBanner({view,snap},history){
  const state=snap?.state??null,appMode=snap?.appMode??null;
  fill($('recent'),...recentItems(history).flatMap((x,i)=>[i?h('span',{class:'sep',textContent:'·'}):null,h('span',{class:'ev'},h('time',{textContent:x.time}),' '+x.label)]));
  const banner=$('banner');
  banner.dataset.tone=view.tone;banner.dataset.recording=String(!!view.recording);
  $('state-text').textContent=view.label;
  const grp=$('state-group'),slot=view.key==='WATCHING'||view.key==='CAPTURING';
  grp.hidden=!slot;grp.dataset.group=(view.group||'').toLowerCase();grp.textContent=view.groupLabel||'';
  $('state-detail').textContent=view.detail?(view.key==='LIVE_ACTIVE'||view.key==='CAPTURING'||view.key==='DEBUG_SPEAKING'||view.key==='ERROR'?'— ':'· ')+view.detail:'';
  $('state-clock').textContent=view.clock||'';
  const steps=$('steps');steps.hidden=!view.steps;
  if(view.steps)fill(steps,...view.steps.map(s=>h('li',{class:s.status,textContent:s.label,'aria-current':s.status==='current'?'step':'false'})));
  const on=state?.greeter,mode=appMode??(on?'ON':'OFF');
  $('meta-greeter').textContent=state?(appMode==='DATA_CAPTURE'?'CAPTURE':on?'ON':'OFF'):'–';
  $('meta-mode').textContent=state?modeLabel(state):'–';
  $('meta-trigger').textContent=state?triggerLabel(state):'–';
  $('meta-people').textContent=Number.isFinite(state?.visitor_count)?state.visitor_count:'–';
  for(const b of document.querySelectorAll('#mode-switch button')){
    b.setAttribute('aria-checked',String(b.dataset.mode===mode));
    b.disabled=b.dataset.mode==='DATA_CAPTURE'&&modeSupported===false;
  }
  $('scream-status').textContent=screamLabel(state?.scream);
  {const on=Boolean(state?.heckling),b=$('heckling');b.setAttribute('aria-checked',String(on));b.textContent=on?'On':'Off';}
  const live=state&&LIVE_ON.includes(state.app_state)&&appMode!=='DATA_CAPTURE';
  $('mute').textContent=state?.app_state==='MUTED'?'Unmute':'Mute';
  $('mute').disabled=!live;$('end-session').disabled=!live;
  const sv=modeSupported?scheduleView(modeInfo):null;
  $('sched').hidden=!sv;$('daybar').hidden=!sv?.segments.length;
  if(sv){
    $('sched-text').textContent=sv.text;$('resume-schedule').hidden=!(sv.manual&&sv.resumeMode);
    if(sv.segments.length)fill($('daybar'),...sv.segments.map(g=>h('i',{title:g.label,'data-mode':g.mode,style:`left:${g.left}%;width:${g.width}%`})),h('b',{style:`left:${sv.nowPct}%`,title:'Now'}));
  }
  document.title=(view.talkNow?'● ':'')+'The Banjo Porch';
}
function showActionError(message){const el=$('action-error');el.textContent=message||'';el.hidden=!message;}
async function pollState(){
  const r=await call('/api/state');
  poll=reducePoll(poll,r);
  renderBanner();
}
async function pollMode(){
  const r=await call('/api/mode');
  if(r.status===404){modeSupported=false;fbMode=null;fbCapture=null;modeInfo=null;}
  else if(r.ok){modeSupported=true;fbMode=r.data?.mode??fbMode;fbCapture=r.data?.capture??fbCapture;modeInfo=r.data;}
  renderBanner();
}
for(const b of document.querySelectorAll('#mode-switch button'))b.onclick=async()=>{
  operatorAction();showActionError('');
  const mode=b.dataset.mode;let r;
  if(modeSupported)r=await call('/api/mode',{mode});
  else if(mode==='DATA_CAPTURE')return;
  else r=await call(mode==='ON'?'/api/audio/start':'/api/audio/stop',{});
  if(!r.ok)showActionError(r.data?.error||'Could not change mode');
  await Promise.all([pollState(),pollMode()]);
};
$('resume-schedule').onclick=async()=>{operatorAction();showActionError('');const r=await call('/api/mode',RESUME_SCHEDULE);if(!r.ok)showActionError(r.data?.error||'Could not resume schedule');await pollMode();};
$('heckling').onclick=async()=>{operatorAction();showActionError('');const on=$('heckling').getAttribute('aria-checked')==='true';const r=await call('/api/heckling',{heckling:on?'off':'on'});if(!r.ok)showActionError(r.data?.error||'Could not change heckling');pollState();};
$('mute').onclick=async()=>{operatorAction();showActionError('');const r=await call('/api/audio/mute',{});if(!r.ok)showActionError(r.data?.error||'Could not change mute');pollState();};
$('end-session').onclick=async()=>{operatorAction();showActionError('');const r=await call('/api/audio/end-session',{});if(!r.ok)showActionError(r.data?.error||'Could not stop session');pollState();pollSessions();};

/* ---------- costs ---------- */
let costData=null;
function renderCosts(){
  const strip=costStrip(costData);
  $('costs').hidden=!strip;
  if(!strip)return;
  const el=$('cost-strip');
  fill(el,strip.parts.map(([k,v],i)=>h('span',{},i?'  ·  ':'',k==='now'?v:`${k} ${v}`)),...strip.flags.map(f=>h('span',{class:'flag',textContent:f})));
  const detail=$('cost-detail');
  if(detail.hidden)return;
  const rows=costRows(costData),cell=x=>!x?'–':x.seconds!=null?`${fmtUsd(x.usd)} · ${fmtClock(x.seconds)}`:`${fmtUsd(x.usd)} · ${x.calls??0} calls · ${((x.tokens||0)/1000).toFixed(1)}k tok`;
  const models=[...new Set([...Object.keys(costData.today?.by_model||{}),...Object.keys(costData.since_start?.by_model||{})])];
  fill(detail,
    h('table',{},h('thead',{},h('tr',{},h('th',{textContent:'Category'}),h('th',{textContent:'Today'}),h('th',{textContent:'Since start'}))),
      h('tbody',{},rows.map(r=>h('tr',{},h('td',{textContent:r.name}),h('td',{textContent:cell(r.today)}),h('td',{textContent:cell(r.since_start)}))),
        h('tr',{},h('td',{textContent:'Total'}),h('td',{textContent:fmtUsd(costData.today?.total_usd)}),h('td',{textContent:fmtUsd(costData.since_start?.total_usd)})))),
    models.length?h('p',{class:'cost-models',textContent:models.join(' · ')}):null,
    (costData.pricing||[]).length?h('p',{class:'cost-models',textContent:costData.pricing.map(p=>`${p.model} ${p.price}/${p.unit}${p.verified===false?' (unverified)':''}`).join(' · ')}):null);
}
$('cost-strip').onclick=()=>{const d=$('cost-detail');d.hidden=!d.hidden;$('cost-strip').setAttribute('aria-expanded',String(!d.hidden));renderCosts();};
async function pollCosts(){const r=await call('/api/costs');costData=r.ok?r.data:null;renderCosts();}

/* ---------- video + camera ---------- */
const video=$('live-video');let videoRetry;
video.onload=()=>{$('video-empty').hidden=true;video.hidden=false;$('video-state').textContent='';};
video.onerror=()=>{video.hidden=true;$('video-empty').hidden=false;$('video-state').textContent='reconnecting';clearTimeout(videoRetry);videoRetry=setTimeout(()=>{video.src='/api/video?t='+Date.now();},3000);};
for(const b of document.querySelectorAll('[data-ptz]'))b.onclick=async()=>{
  b.disabled=true;const r=await call('/api/ptz',{action:b.dataset.ptz});b.disabled=false;
  if(!r.ok)$('video-state').textContent=r.data?.error||'Camera control failed';
};

/* ---------- detector (live) ---------- */
let detFrameAt=null,detBusy=false;
async function showDetFrame(at){
  if(detBusy)return;detBusy=true;
  try{
    const r=await fetch('/api/frame');if(!r.ok)return;
    const url=URL.createObjectURL(await r.blob()),pre=new Image();pre.src=url;
    try{await pre.decode();}catch{URL.revokeObjectURL(url);return;}
    const img=$('det-frame'),old=img.src;img.src=url;img.hidden=false;$('det-empty').hidden=true;if(old.startsWith('blob:'))URL.revokeObjectURL(old);
    detFrameAt=at;
  }catch{}finally{detBusy=false;}
}
function renderDetector(v){
  if(!v){fill($('det-stats'));$('det-time').textContent='–';return;}
  $('det-time').textContent=fmtTime(v.capturedAt);
  const row=(k,val,cls)=>h('div',{class:cls||''},h('dt',{textContent:k}),h('dd',{textContent:String(val)}));
  fill($('det-stats'),row('state',v.group,'grp'),row('sidewalk',v.zones.sidewalk),row('path',v.zones.path),row('porch',v.zones.porch),row('ignored',v.zones.ignored),
    v.other?row('other',v.other):null,row('top score',v.topScore==null?'–':v.topScore.toFixed(2)),row('detector ms',v.ms??'–'),row('source',v.source??'–'),row('captured',fmtTime(v.capturedAt)));
  if(v.capturedAt!==detFrameAt)showDetFrame(v.capturedAt);
}
async function pollDetector(){
  const r=await call('/api/detector/status');
  if(r.ok)try{renderDetector(detectorView(r.data));}catch(e){console.error(e);}
}

/* ---------- last Judge read ---------- */
let lastJudgeId=null,lastJudge=null;
function renderJudge(){
  const v=judgeReadView(lastJudge);
  $('judge-none').hidden=Boolean(v);$('judge-body').hidden=!v;
  if(!v){$('read-time').textContent='–';return;}
  $('read-time').textContent=fmtTime(v.captured_at)+' · '+v.age;
  if(v.read_id!==lastJudgeId){
    lastJudgeId=v.read_id;
    fill($('frame-pair'),...v.frames.map(f=>h('figure',{},h('img',{alt:f.label+' frame',src:`/api/judge/frame/last/${f.key}?r=${encodeURIComponent(v.read_id)}`}),h('figcaption',{textContent:f.label}))));
  }
  fill($('read-meta'),...v.groups.filter(g=>g.inference_ms!=null).map(g=>h('span',{textContent:`${g.judge} ${g.inference_ms} ms`})));
  fill($('judge-groups'),...v.groups.map(g=>h('div',{class:'group'},
    h('h3',{},h('span',{textContent:g.judge}),h('span',{class:'ms',textContent:g.inference_ms!=null?g.inference_ms+' ms':''})),
    g.error?h('div',{class:'err',textContent:String(g.error)}):null,
    ...g.rows.map(a=>h('div',{class:'ans'+(a.accepted?'':' dim'),title:a.accepted?'':'Below cutoff'},
      h('span',{class:'name',textContent:a.label}),
      h('span',{class:'tops'},...a.top.flatMap((t,i)=>[i?h('span',{class:'sep',textContent:' · '}):null,h('span',{class:t.winner?'top win':'top'},`${t.choice} ${t.pct==null?'–':t.pct+'%'}`)])))))));
  fill($('persons'),...v.persons.map((p,i)=>h('span',{textContent:personLine(p,i)})));
}
async function pollJudge(){
  const r=await call('/api/judge/status');
  if(r.ok)try{lastJudge=r.data?.last_judge_read??null;renderJudge();}catch(e){console.error(e);}
}

/* ---------- sessions ---------- */
const openIds=new Set(),touched=new Set(),details=new Map(),sigs=new Map();let firstLoad=true,sessionList=[];
function timeline(events){return h('ol',{class:'tl'},events.map(e=>h('li',{class:'t-'+e.type},h('time',{textContent:fmtTime(e.at)}),h('span',{},h('b',{textContent:e.type.replace(/_/g,' ').toLowerCase()}),e.phrase?' '+e.phrase:''))));}
function renderBody(s,d){
  if(s.kind==='capture')return h('div',{class:'sess-body'},h('p',{class:'muted',textContent:[s.frames!=null?s.frames+' frames':null,s.bytes!=null?(s.bytes/1048576).toFixed(1)+' MB':null,s.open?'recording':null].filter(Boolean).join(' · ')||'clip'}));
  if(!d)return h('div',{class:'sess-body'},h('p',{class:'empty',textContent:'Loading'}));
  const strip=d.reads?.length?h('div',{class:'strip'},d.reads.slice(-40).map(r=>h('a',{href:'/review.html',title:fmtTime(r.captured_at)},h('img',{loading:'lazy',alt:'Judged frame',src:'/api/review/image?key='+encodeURIComponent(r.read_key)})))):null;
  return h('div',{class:'sess-body'},
    h('div',{},h('h4',{textContent:'Timeline'}),timeline(d.events||[])),
    h('div',{},h('h4',{textContent:'Transcript'}),d.turns?.length?h('div',{class:'turns'},d.turns.map(t=>h('div',{class:'turn '+t.role},h('b',{textContent:t.role==='assistant'?'Banjo':'Guest'}),t.text))):h('p',{class:'empty',textContent:d.mode==='debug'?'Debug speech, no transcript':'No transcript'})),
    strip);
}
function renderSessions(){
  $('sessions-count').textContent=sessionList.length?String(sessionList.length):'';
  const root=$('sessions');
  if(!sessionList.length){fill(root,h('p',{class:'empty',textContent:'No sessions yet'}));return;}
  const keep=new Set();
  const nodes=sessionList.map(s=>{
    keep.add(s.id);
    const key=s.kind+':'+s.id;
    let sec=root.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if(!sec){sec=h('section',{class:'sess','data-key':key},h('button',{type:'button','aria-expanded':'false'}),h('div',{class:'sess-slot'}));
      sec.firstChild.onclick=()=>{touched.add(key);if(openIds.has(key))openIds.delete(key);else{openIds.add(key);loadDetail(s);}renderSessions();};}
    const isOpen=openIds.has(key);
    sec.classList.toggle('open',isOpen);
    const btn=sec.firstChild;btn.setAttribute('aria-expanded',String(isOpen));
    const head=s.kind==='capture'?{parts:[fmtTime(s.started_at),fmtDuration(s.duration_ms),`${s.frames??0} frames`],open:s.open}:sessionHeader(s);
    const label=head.parts.join('|');
    if(btn.dataset.label!==label+head.open+s.kind){
      btn.dataset.label=label+head.open+s.kind;
      fill(btn,...head.parts.flatMap((p,i)=>[i?h('span',{class:'sep',textContent:'·'}):null,h('span',{class:'h',textContent:p})]),
        s.kind==='capture'?h('span',{class:'tag capture',textContent:'capture'}):s.mode==='debug'?h('span',{class:'tag',textContent:'debug'}):null,head.open?h('span',{class:'tag live-now',textContent:'now'}):null);
    }
    const slot=sec.lastChild;slot.hidden=!isOpen;
    if(isOpen){const sig=JSON.stringify([key,details.get(key)||null,s.frames,s.bytes,s.open]);if(sigs.get(key)!==sig){sigs.set(key,sig);fill(slot,renderBody(s,details.get(key)));}}
    return sec;
  });
  if(root.children.length!==nodes.length||nodes.some((n,i)=>root.children[i]!==n))fill(root,...nodes);
}
async function loadDetail(s){
  if(s.kind==='capture')return;
  const r=await call('/api/sessions/'+encodeURIComponent(s.id));
  if(r.ok){details.set('session:'+s.id,r.data);renderSessions();}
}
async function pollSessions(){
  const [a,b]=await Promise.all([call('/api/sessions'),call('/api/captures')]);
  const list=[];
  if(a.ok&&Array.isArray(a.data))for(const s of a.data)list.push({...s,kind:'session'});
  const clips=b.ok?(Array.isArray(b.data)?b.data:b.data?.clips||[]):[];
  for(const c of clips){const started=c.started_at??c.start??c.created_at,ended=c.ended_at??c.end??null;
    list.push({kind:'capture',id:String(c.id??c.clip_id??started),started_at:started,ended_at:ended,open:ended==null&&c.recording!==false&&c.open!==false,duration_ms:c.duration_ms??((ended??Date.now())-started),frames:c.frames??c.frame_count??null,bytes:c.bytes??null});}
  list.sort((x,y)=>y.started_at-x.started_at);
  sessionList=list;
  if(firstLoad&&list.length){firstLoad=false;const key=list[0].kind+':'+list[0].id;openIds.add(key);loadDetail(list[0]);}
  // The latest session opens by default until the operator touches the list.
  for(const s of list)if(s.kind==='session'&&s.open&&openIds.has('session:'+s.id))loadDetail(s);
  renderSessions();
}

/* ---------- boot ---------- */
(async()=>{
  const r=await call('/api/status');
  if(r.ok&&r.data?.model){$('voice-backend').textContent=(r.data.voice_backend==='gemini'?'Gemini':'GPT-Live')+' · '+r.data.model+(r.data.gemini_mode?' · '+r.data.gemini_mode+(r.data.prompt_sha?' · prompt '+r.data.prompt_sha:''):'')+' ';}
  if(r.ok)$('rec-audio').hidden=!r.data?.visit_audio;
  if(r.ok&&r.data?.deployment_commit){const a=$('build-version');a.hidden=false;a.textContent='Running '+r.data.deployment_commit.slice(0,8);a.href='https://github.com/dobromirmontauk/halloween-greeter/commit/'+r.data.deployment_commit;}
})();
renderBanner();
const every=(fn,ms)=>{const tick=async()=>{try{await fn();}catch(e){console.error(e);}setTimeout(tick,ms);};tick();};
every(pollState,500);every(pollJudge,2000);every(pollDetector,1000);every(pollMode,2000);every(pollCosts,5000);every(pollSessions,2000);
