// AI labels for reads (Claude, Gemini, ...). Stored separately from human labels (ai_labels.jsonl, 0600) so human labels stay ground truth.
// Record: {key, labeler, people_present: yes|no|unsure, count?, notes?, false_positive_cause?, labeled_at}. Latest record per key per labeler wins.
export const MAX_AI_LABELS=2000;
export const AI_PEOPLE=['yes','no','unsure'];
const LABELER_RE=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,CAUSE_RE=/^[a-z0-9_]{1,40}$/;
const bad=message=>Object.assign(new Error(message),{status:400});

// Validates one record; parseKey returns a truthy value for a valid review key. Throws status 400.
export function sanitizeAiLabel(rec,{parseKey,now=Date.now}={}){
 if(!rec||typeof rec!=='object'||Array.isArray(rec))throw bad('Invalid AI label.');
 if(!parseKey(rec.key))throw bad('Invalid read key.');
 if(typeof rec.labeler!=='string'||!LABELER_RE.test(rec.labeler))throw bad('Invalid labeler.');
 if(!AI_PEOPLE.includes(rec.people_present))throw bad('Invalid people_present.');
 const out={key:rec.key,labeler:rec.labeler,people_present:rec.people_present};
 if(rec.count!=null&&rec.count!==''){
  const c=typeof rec.count==='number'?rec.count:String(rec.count);
  if(typeof c==='number'?!(Number.isInteger(c)&&c>=0&&c<=99):!/^[0-9a-z_]{1,8}$/.test(c))throw bad('Invalid count.');
  out.count=c;
 }
 if(rec.notes!=null)out.notes=String(rec.notes).slice(0,500);
 if(rec.false_positive_cause!=null&&rec.false_positive_cause!==''){
  if(typeof rec.false_positive_cause!=='string'||!CAUSE_RE.test(rec.false_positive_cause))throw bad('Invalid false_positive_cause.');
  out.false_positive_cause=rec.false_positive_cause;
 }
 const t=rec.labeled_at==null?NaN:Date.parse(rec.labeled_at);
 out.labeled_at=new Date(Number.isFinite(t)?t:now()).toISOString();
 return out;
}
// Body: JSON array, or NDJSON (one object per line). Returns raw records; throws 400 past the cap.
export function parseAiBody(text,{max=MAX_AI_LABELS}={}){
 const t=String(text||'').trim();let recs;
 if(!t)throw bad('Empty body.');
 try{
  if(t.startsWith('['))recs=JSON.parse(t);
  else recs=t.split('\n').filter(l=>l.trim()).map(l=>JSON.parse(l));
 }catch{throw bad('Invalid JSON.');}
 if(!Array.isArray(recs))throw bad('Expected an array.');
 if(recs.length>max)throw bad(`Too many labels (max ${max}).`);
 return recs;
}
// Lines (file order = time order) -> Map key -> {labeler: record}. A later record for the same key+labeler replaces the earlier one.
export function latestAiLabels(lines){
 const m=new Map();
 for(const l of lines){
  if(!l||typeof l.key!=='string'||typeof l.labeler!=='string')continue;
  let e=m.get(l.key);if(!e){e={};m.set(l.key,e);}
  e[l.labeler]=l;
 }
 return m;
}
const slim=r=>({people_present:r.people_present,...(r.count!=null?{count:r.count}:{}),...(r.notes?{notes:r.notes}:{}),...(r.false_positive_cause?{false_positive_cause:r.false_positive_cause}:{}),labeled_at:r.labeled_at});
export const aiView=e=>e?Object.fromEntries(Object.entries(e).map(([n,r])=>[n,slim(r)])):null;

const decisive=ai=>Object.values(ai||{}).map(r=>r.people_present).filter(p=>p==='yes'||p==='no');
// 'yes'|'no' when every decisive AI label agrees, 'mixed' when they conflict, null when none.
export function aiConsensus(ai){const d=decisive(ai);if(!d.length)return null;return d.every(x=>x===d[0])?d[0]:'mixed';}
// Disagreement with the Judge: any decisive AI label differs from the Judge winner ("0" = no people) or from the tier (people/no_people).
// v needs {winner, uncertain, tier, ai_labels}.
export function aiDisagrees(v){
 const d=decisive(v.ai_labels);if(!d.length)return false;
 const judge=v.winner==null||v.winner==='uncertain'||v.uncertain?null:(v.winner!=='0'?'yes':'no');
 const tier=v.tier==='people'?'yes':v.tier==='no_people'?'no':null;
 return d.some(p=>(judge!=null&&p!==judge)||(tier!=null&&p!==tier));
}
// 'agree'|'disagree'|'none' (no decisive AI label; includes unsure-only).
export const aiState=v=>!decisive(v.ai_labels).length?'none':aiDisagrees(v)?'disagree':'agree';
// Human label vs AI: 'agree'|'disagree'|null (no yes/no human label or no decisive AI label).
export function humanVsAi(v){
 const h=v.people_label;if(h!=='yes'&&h!=='no')return null;
 const d=decisive(v.ai_labels);if(!d.length)return null;
 return d.every(p=>p===h)?'agree':'disagree';
}
export const causesOf=ai=>[...new Set(Object.values(ai||{}).map(r=>r.false_positive_cause).filter(c=>c&&c!=='none'))];
// Summary for a set of views: {total, with_ai, no, yes, mixed, unsure, causes:{cause:n}}.
export function aiSummary(views){
 const s={total:views.length,with_ai:0,no:0,yes:0,mixed:0,causes:{}};
 for(const v of views){
  if(!v.ai_labels)continue;s.with_ai++;
  const c=aiConsensus(v.ai_labels);if(c)s[c]++;
  for(const cause of causesOf(v.ai_labels))s.causes[cause]=(s.causes[cause]||0)+1;
 }
 return s;
}
