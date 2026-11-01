import {aiText,aiSummaryLine,scoreText} from './review-keys.js';
import {keyAction,isTypingTarget,moveIndex,tabLabel,progressLine,createSession,reduce,preloadUrls,hudLines,humanValue} from './review-keys.js';
// Three views (?tier=borderline|people|no_people); all page state lives in the URL query.
const LIMIT=12,SAMPLE=12,TIERS=['borderline','people','no_people'];
const COUNTS=['0','1','2','3','4_5','6_plus'],MOTION=['arriving','present','leaving','not_visible','uncertain'];
const PLACE=['sidewalk','path','porch','not_visible','uncertain'],CLOSEST=['sidewalk','path','porch','none','uncertain'];
const FIELDS=[['real_people_count','People',COUNTS],['closest_person_location','Closest person',CLOSEST],
 ...[1,2,3].flatMap(n=>[[`person_${n}_motion`,`Person ${n} motion`,MOTION],[`person_${n}_location`,`Person ${n} location`,PLACE]])];
const $=id=>document.getElementById(id);
const el=(tag,props={},...kids)=>{const e=document.createElement(tag);Object.assign(e,props);for(const k of kids)e.append(k);return e;};
const params=new URLSearchParams(location.search);
const state={tier:TIERS.includes(params.get('tier'))?params.get('tier'):'borderline',offset:Number(params.get('offset'))||0,labeled:params.get('labeled')==='all'?'all':'no',
 source:params.get('source')||'',from:params.get('from')||'',to:params.get('to')||'',high:params.get('high'),low:params.get('low'),sample:Number(params.get('sample'))||0,seed:params.get('seed')||'',view:params.get('view')==='grid'?'grid':'fs',ai:params.get('ai')||'',hva:params.get('human_vs_ai')||'',cause:params.get('false_positive_cause')||'',sort:params.get('sort')||'',prov:params.get('provisional')==='1',visits:params.get('visits')==null?null:params.get('visits')==='1'};
const visitsOn=()=>state.visits??state.tier==='borderline';
let items=[],cur=0,data=null,sess=null,flashTimer=null;

function query(over={}){
 const s={...state,...over},p=new URLSearchParams({tier:s.tier});
 if(s.offset)p.set('offset',s.offset);if(s.labeled==='all')p.set('labeled','all');
 for(const k of ['source','from','to','high','low','seed'])if(s[k]!==''&&s[k]!=null)p.set(k,s[k]);
 if(s.sample)p.set('sample',s.sample);
 if(s.view==='grid')p.set('view','grid');
 if(s.ai)p.set('ai',s.ai);if(s.hva)p.set('human_vs_ai',s.hva);if(s.cause)p.set('false_positive_cause',s.cause);if(s.sort)p.set('sort',s.sort);if(s.prov)p.set('provisional','1');
 if(s.visits!=null)p.set('visits',s.visits?'1':'0');
 return p;
}
const sync=()=>history.replaceState(null,'','?'+query());
const apiQuery=()=>{const p=query();p.delete('view');p.set('visits',visitsOn()?'1':'0');if(state.view==='fs'){p.set('limit',2000);p.delete('offset');}else p.set('limit',LIMIT);if(state.labeled==='no')p.set('labeled','no');return p;};
const pct=v=>v==null?'-':(v*100).toFixed(1)+'%';

async function label(read,body){
 if(!read)return false;
 const res=await fetch('/api/review/read-label',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:read.key,...body})});
 if(!res.ok){alert((await res.json()).error||'Save failed');return false;}
 return true;
}
const imgUrl=(r,prev)=>'/api/review/read-image?key='+encodeURIComponent(r.key)+(prev?'&prev='+(r.source==='capture'?r.prev_index:1):'');
const topText=r=>(r.top||[]).map(t=>`${t.choice} ${Math.round(t.confidence*100)}%`).join(' · ')||'-';

function details(r){
 const lab=r.label||{},f=el('div',{className:'rv-form'}),inputs={};
 for(const[name,title,values]of FIELDS){const s=el('select');s.append(el('option',{value:'',textContent:'-'}));for(const v of values)s.append(el('option',{value:v,textContent:v,selected:lab[name]===v}));inputs[name]=s;f.append(el('label',{textContent:title},s));}
 const notes=el('input',{value:lab.notes||''});f.append(el('label',{textContent:'Notes'},notes));
 const save=el('button',{textContent:'Save details'});
 save.onclick=async()=>{const b={};for(const k in inputs)if(inputs[k].value)b[k]=inputs[k].value;if(notes.value)b.notes=notes.value;if(await label(r,b))load();};
 return el('details',{},el('summary',{textContent:'Details'}),f,el('div',{className:'rv-actions'},save));
}
function card(r,i){
 const meta=el('div',{className:'rv-meta'},el('span',{textContent:new Date(r.captured_at).toLocaleString()}),el('span',{textContent:r.source}),
  el('span',{textContent:'detector '+(r.detector_count??'-')}),el('span',{textContent:r.detector_disagree?'detector disagrees':'',className:'rv-bad'}),el('span',{textContent:r.uncertain?'uncertain':''}),
  el('span',{textContent:r.labeled?'labeled '+(r.people_label||''):''}),el('span',{textContent:aiText(r.ai_labels),className:r.ai_disagree?'rv-bad':''}));
 const imgs=el('div',{className:'rv-imgs'},...(r.has_prev?[el('img',{src:imgUrl(r,true),loading:'lazy',alt:'earlier frame'})]:[]),el('img',{src:imgUrl(r),loading:'lazy',alt:'current frame'}));
 const btn=(t,v)=>{const b=el('button',{textContent:t});b.onclick=async()=>{cur=i;if(await label(r,{people_present:v}))load();};return b;};
 const score=el('div',{className:'rv-big',textContent:scoreText(r)});
 const c=el('div',{className:'rv-item'+(i===cur?' cur':'')},imgs,el('div',{className:'rv-body'},meta,score,el('div',{className:'rv-meta',textContent:r.presence_source==='detector'?'':'top 3: '+topText(r)}),
  el('div',{className:'rv-actions'},btn('People (p)','yes'),btn('No people (n)','no'),btn('Unsure (u)','unsure')),details(r)));
 c.dataset.i=i;return c;
}
function finder(f){
 const box=el('details',{open:true},el('summary',{textContent:'Threshold finder'+(f.provisional?` (provisional: ${f.provisional} of ${f.labeled} labels from AI)`:'')}));
 const note=f.meaningful?`best cutoff ${f.best} (current ${f.current_cutoff})`:`${f.labeled} labeled, ${f.needed} more needed (n >= ${f.min_labels}); best so far ${f.best??'-'}`;
 box.append(el('div',{className:'rv-meta',textContent:note}));
 const t=el('table',{className:'rv-table'});t.append(el('tr',{},...['Cutoff','Precision','Recall','Accuracy','FP','FN'].map(h=>el('th',{textContent:h}))));
 for(const r of f.table)t.append(el('tr',{className:r.cutoff===f.best?'rv-best':''},...[r.cutoff.toFixed(2),pct(r.precision),pct(r.recall),pct(r.accuracy),r.fp,r.fn].map(v=>el('td',{textContent:String(v)}))));
 box.append(t);return box;
}
function peopleGrid(){
 const grid=el('div',{className:'rv-grid'});
 items.forEach(r=>{
  const b=el('button',{className:'rv-thumb',title:'Click to flip to No people'},el('img',{src:imgUrl(r),loading:'lazy',alt:'read'}),el('span',{textContent:r.presence_source==='detector'?'det '+(r.detector_count??'-'):r.p_people==null?'-':r.p_people.toFixed(2)}));
  let flipped=false;
  b.onclick=async()=>{flipped=!flipped;b.classList.toggle('flip',flipped);b.dataset.flip=flipped?'no':'yes';};
  b.dataset.flip='yes';b.dataset.key=r.key;grid.append(b);
 });
 const ok=el('button',{textContent:'Confirm shown'});
 ok.onclick=async()=>{for(const b of grid.children){const r=items.find(x=>x.key===b.dataset.key);if(r&&!(await label(r,{people_present:b.dataset.flip})))return;}load();};
 $('extra').replaceChildren(ok);
 return grid;
}

// ---- full screen: one read at a time ----
const fsEl=()=>$('fs');
function fsRender(){
 const it=sess.items[sess.cur];
 $('fsimgs').replaceChildren();
 if(!it){$('fshud').textContent='No reads';return;}
 const both=it.has_prev&&sess.pair;
 const show=[];if(both)show.push(imgUrl(it,true));show.push(imgUrl(it,it.has_prev&&sess.view==='prev'&&!both));
 for(const u of show)$('fsimgs').append(el('img',{src:u,alt:'frame'}));
 const h=humanValue(sess,it),lines=hudLines(it,{pos:sess.cur+1,total:sess.items.length,tier:state.tier});
 if(h)lines.push('You: '+h);
 if(it.has_prev)lines.push(both?'prev | now':sess.view);
 $('fshud').replaceChildren(...lines.map(t=>el('div',{textContent:t})));
 for(const u of preloadUrls(sess.items,sess.cur,imgUrl)){const i=new Image();i.src=u;}
}
function flash(t){
 const f=$('fsflash');f.textContent=t;f.classList.add('on');clearTimeout(flashTimer);
 flashTimer=setTimeout(()=>f.classList.remove('on'),600);
}
function fsOpen(){state.view='fs';sync();load();}
function fsExit(){state.view='grid';fsEl().hidden=true;sync();load();}
function fsAct(a){
 if(!sess)return;
 const out=reduce(sess,a);
 for(const sv of out.saves)label({key:sv.key},sv.value==null?{clear:true}:{people_present:sv.value,...(sv.labeler?{labeler:sv.labeler}:{})}).then(ok=>{if(!ok)flash('save failed');});
 if(out.flash)flash(out.ended?out.flash+' (end)':out.flash);
 if(out.exit)return fsExit();
 fsRender();
}
$('fsyes').onclick=()=>fsAct({type:'label',value:'yes'});
$('fsno').onclick=()=>fsAct({type:'label',value:'no'});
$('fsunsure').onclick=()=>fsAct({type:'label',value:'unsure'});
$('fsprev').onclick=()=>fsAct({type:'move',delta:-1});
$('fsnext').onclick=()=>fsAct({type:'move',delta:1});
$('fsgrid').onclick=()=>fsAct({type:'exit'});
$('gofs').onclick=()=>fsOpen();
{let x0=null,y0=null;const box=fsEl();
 box.addEventListener('touchstart',e=>{x0=e.touches[0].clientX;y0=e.touches[0].clientY;},{passive:true});
 box.addEventListener('touchend',e=>{if(x0==null)return;const dx=e.changedTouches[0].clientX-x0,dy=e.changedTouches[0].clientY-y0;x0=null;
  if(Math.abs(dx)>60&&Math.abs(dx)>2*Math.abs(dy))fsAct({type:'move',delta:dx<0?1:-1});},{passive:true});}
function render(){
 $('tabs').replaceChildren(...TIERS.map(t=>el('a',{className:'rv-tab'+(t==='borderline'?' primary':'')+(t===state.tier?' on':''),href:'?'+query({tier:t,offset:0,sample:0}),textContent:tabLabel(t,data.counts)})));
 $('progress').textContent=progressLine(data.counts,state.tier);
 $('high').value=data.thresholds.high;$('low').value=data.thresholds.low;$('highv').textContent=data.thresholds.high;$('lowv').textContent=data.thresholds.low;
 $('showlabeled').checked=state.labeled==='all';$('source').value=state.source;$('from').value=state.from;$('to').value=state.to;
 const list=$('list'),fin=$('finder');list.replaceChildren();fin.replaceChildren();$('extra').replaceChildren();
 if(state.tier==='borderline')fin.append(finder(data.finder));
 if(state.tier==='people')list.append(peopleGrid());
 else if(state.tier==='no_people'){
  const d=el('details',{},el('summary',{textContent:`No people (${data.counts.no_people.total}) - spot checks`}));
  const grid=el('div');items.forEach((r,i)=>grid.append(card(r,i)));d.append(grid);list.append(d);
  const more=el('button',{textContent:'Random sample'});more.onclick=()=>{state.sample=SAMPLE;state.seed=String(Date.now());state.offset=0;load();};
  $('extra').replaceChildren(more);
 }else items.forEach((r,i)=>list.append(card(r,i)));
 $('visits').checked=visitsOn();$('prov').checked=state.prov;$('ai').value=state.ai;$('hva').value=state.hva;$('sort').value=state.sort;
 {const c=$('cause'),causes=Object.keys(data.ai_summary?.[state.tier]?.causes||{});if(state.cause&&!causes.includes(state.cause))causes.push(state.cause);
  c.replaceChildren(el('option',{value:'',textContent:'Cause: any'}),el('option',{value:'any',textContent:'Cause: any false positive'}),...causes.map(x=>el('option',{value:x,textContent:x})));c.value=state.cause;}
 $('aisum').textContent=aiSummaryLine(data.ai_summary?.[state.tier],state.tier);
 $('total').textContent=data.total+' shown';
 $('page').textContent=data.sample?'sample':(data.total?state.offset+1:0)+'-'+Math.min(data.total,state.offset+LIMIT);
 $('prev').disabled=Boolean(data.sample)||state.offset<=0;$('next').disabled=Boolean(data.sample)||state.offset+LIMIT>=data.total;
 focusCard();
 if(state.view==='fs'){fsEl().hidden=false;sess=createSession(items);fsRender();}else{fsEl().hidden=true;sess=null;}
}
function focusCard(){
 cur=moveIndex(cur,0,items.length);
 document.querySelectorAll('.rv-item').forEach(c=>c.classList.toggle('cur',Number(c.dataset.i)===cur));
 document.querySelector('.rv-item.cur')?.scrollIntoView({block:'nearest'});
}
async function load(){
 sync();
 const res=await fetch('/api/review/reads?'+apiQuery());
 if(!res.ok){$('list').textContent=(await res.json()).error||'Unavailable';return;}
 data=await res.json();items=data.items;render();
}
document.addEventListener('keydown',ev=>{
 const a=keyAction(ev,{typing:isTypingTarget(ev.target)});if(!a)return;
 if(state.view==='fs'){ev.preventDefault();fsAct(a);return;}
 if(state.tier==='people'||!['label','move'].includes(a.type))return;
 ev.preventDefault();
 if(a.type==='move'){cur=moveIndex(cur,a.delta,items.length);focusCard();}
 else if(items[cur])label(items[cur],{people_present:a.value}).then(ok=>ok&&load());
});
$('prev').onclick=()=>{state.offset=Math.max(0,state.offset-LIMIT);cur=0;load();scrollTo(0,0);};
$('next').onclick=()=>{state.offset+=LIMIT;cur=0;load();scrollTo(0,0);};
for(const [id,k] of [['ai','ai'],['hva','hva'],['cause','cause'],['sort','sort']])$(id).onchange=e=>{state[k]=e.target.value;state.offset=0;load();};
$('prov').onchange=e=>{state.prov=e.target.checked;load();};
$('visits').onchange=e=>{state.visits=e.target.checked;state.offset=0;load();};
$('showlabeled').onchange=e=>{state.labeled=e.target.checked?'all':'no';state.offset=0;load();};
for(const id of ['source','from','to'])$(id).onchange=e=>{state[id]=e.target.value;state.offset=0;load();};
for(const id of ['high','low'])$(id).onchange=e=>{state[id]=e.target.value;state.offset=0;load();};
for(const id of ['high','low'])$(id).oninput=e=>{$(id+'v').textContent=e.target.value;};
load();
