// DOM-free logic for the Review page: key mapping, the full-screen session state machine, preload order, HUD text, tab and progress text.
export const KEY_LABELS={y:'yes',p:'yes',n:'no',u:'unsure'};
// Returns an action or null. typing=true when focus is in a form field.
// Actions: {type:'label',value,visit?} | {type:'move',delta} | undo | accept | toggle | pair | exit
export function keyAction(ev,{typing=false}={}){
 if(typing||!ev||ev.ctrlKey||ev.metaKey||ev.altKey)return null;
 const k=String(ev.key||'').toLowerCase();
 if(k in KEY_LABELS)return {type:'label',value:KEY_LABELS[k],...(ev.shiftKey?{visit:true}:{})};
 if(k==='j'||k==='arrowright')return {type:'move',delta:1};
 if(k==='k'||k==='arrowleft')return {type:'move',delta:-1};
 if(k==='z')return {type:'undo'};
 if(k==='a')return {type:'accept'};
 if(k===' '||k==='spacebar')return {type:'toggle'};
 if(k==='s')return {type:'pair'};
 if(k==='escape')return {type:'exit'};
 return null;
}
export const isTypingTarget=t=>Boolean(t)&&(['INPUT','SELECT','TEXTAREA'].includes(t.tagName)||t.isContentEditable===true);
export const moveIndex=(i,delta,len)=>len<=0?0:Math.min(len-1,Math.max(0,i+delta));
export const TIER_TITLES={borderline:'Borderline',people:'People',no_people:'No people'};
export const tabLabel=(tier,counts)=>{const n=counts?.[tier]?.unlabeled??0;return tier==='borderline'?`Borderline (${n} unlabeled)`:`${TIER_TITLES[tier]} (${n})`;};
export const progressLine=(counts,tier)=>{const c=counts?.[tier]||{total:0,labeled:0};return `labeled ${c.labeled} / ${c.total}`;};

// ---- full-screen session: one read at a time ----
export const createSession=items=>({items,cur:0,view:'now',pair:false,labels:{},history:[]});
export const humanValue=(s,it)=>it?(it.key in s.labels?s.labels[it.key]:(it.people_label??null)):null;
// AI label to accept: all AI labelers must agree on a yes/no/unsure; returns {value,labeler} (Claude preferred) or null.
export function acceptValue(ai){
 const rows=Object.entries(ai||{}).filter(([,r])=>['yes','no','unsure'].includes(r?.people_present));
 if(!rows.length||new Set(rows.map(([,r])=>r.people_present)).size!==1)return null;
 const pick=rows.find(([n])=>/claude/i.test(n))||rows[0];
 return {value:pick[1].people_present,labeler:pick[0]};
}
// Applies one action. Mutates s; returns {saves:[{key,value|null,labeler?}],flash,exit,ended}. value null = clear the label.
export function reduce(s,a){
 const it=s.items[s.cur],out={saves:[],flash:null,exit:false,ended:false},before=s.cur;
 const advance=()=>{s.cur=moveIndex(s.cur,1,s.items.length);s.view='now';if(s.cur===before)out.ended=true;};
 if(a.type==='move'){s.cur=moveIndex(s.cur,a.delta,s.items.length);s.view='now';}
 else if(a.type==='toggle'){if(it?.has_prev)s.view=s.view==='now'?'prev':'now';}
 else if(a.type==='pair'){s.pair=!s.pair;}
 else if(a.type==='exit')out.exit=true;
 else if((a.type==='label'||a.type==='accept')&&it){
  let value=a.value,labeler;
  if(a.type==='accept'){const acc=acceptValue(it.ai_labels);if(!acc){out.flash='no agreed AI label';return out;}value=acc.value;labeler=acc.labeler;}
  const keys=a.visit&&it.visit_keys?.length?it.visit_keys:[it.key];
  s.history.push({idx:s.cur,prior:keys.map(k=>({key:k,value:k in s.labels?s.labels[k]:(k===it.key?it.people_label??null:null)}))});
  for(const k of keys){s.labels[k]=value;out.saves.push({key:k,value,...(labeler?{labeler:'accepted:'+labeler}:{})});}
  out.flash=value+(keys.length>1?` x${keys.length}`:'');
  advance();
 }else if(a.type==='undo'){
  const h=s.history.pop();
  if(!h){out.flash='nothing to undo';return out;}
  for(const p of h.prior){s.labels[p.key]=p.value;out.saves.push({key:p.key,value:p.value});}
  s.cur=h.idx;s.view='now';out.flash='undone';
 }
 return out;
}
// Image urls to warm after index cur (instant advance), nearest first.
export const preloadUrls=(items,cur,urlFn,n=3)=>items.slice(cur+1,cur+1+n).map(r=>urlFn(r,false));

const pctText=v=>v==null?'-':Math.round(v*100)+'%';
const cap=w=>w.charAt(0).toUpperCase()+w.slice(1);
export const aiText=ai=>Object.entries(ai||{}).map(([n,r])=>`${cap(n.split('-')[0])}: ${r.people_present}`).join(' · ');
// Summary strip per tab: "AI says no people on 312 / 609 borderline", top causes.
export function aiSummaryLine(s,tier){
 if(!s||!s.with_ai)return '';
 const causes=Object.entries(s.causes||{}).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([c,n])=>`${c} ${n}`);
 return [`AI says no people on ${s.no} / ${s.total} ${(TIER_TITLES[tier]||tier).toLowerCase()}`,s.yes?`people on ${s.yes}`:'',s.mixed?`mixed ${s.mixed}`:'',...causes].filter(Boolean).join(' · ');
}
// Score text for a read: a Judge read shows p_people; a detector read shows its count and zone, never a Judge probability.
export const scoreText=it=>it?.presence_source==='detector'?`detector ${it.detector_count??'-'}${it.detector_location&&it.detector_location!=='none'?' · '+it.detector_location:''}`:`p_people ${it?.p_people==null?'-':it.p_people.toFixed(3)}`;
// HUD lines (labels and values only).
export function hudLines(it,{pos,total,tier}){
 if(!it)return [];
 const lines=[`${TIER_TITLES[tier]||tier} ${pos} / ${total}`,
  scoreText(it),
  ...(it.presence_source==='detector'?[]:[`Judge ${it.winner??'-'} ${pctText(it.confidence)}`,`detector ${it.detector_count??'-'}`])];
 const ai=aiText(it.ai_labels);if(ai)lines.push(ai);
 if(it.visit_size>1)lines.push(`visit ${it.visit_size}`);
 lines.push(new Date(it.captured_at).toLocaleTimeString());
 return lines;
}
