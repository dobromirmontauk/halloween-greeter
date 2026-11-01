// Which detector boxes the overlays draw. Weak boxes below SIDEWALK_PRESENCE_SCORE and boxes the static suppressor rejected (parked car) do nothing for presence, so they are hidden unless the debug toggle is on.
export const WEAK_KEY='show-weak-boxes',WEAK_SCORE=0.35;
export const TIP_FAR='Far-sidewalk detector (full-resolution top strip). Only keeps the sidewalk state alive; never triggers greetings.';
export function weakShown(){try{return localStorage.getItem(WEAK_KEY)==='on';}catch{return false;}}
export function setWeakShown(on){try{localStorage.setItem(WEAK_KEY,on?'on':'off');}catch{}}
// box: {score, suppressed?, ignored?, weak?, src?}. Counted persons are always kept.
export function keepBox(box,show=false,min=WEAK_SCORE){
  if(show)return true;
  if(box.suppressed||box.ignored)return false;
  if((box.weak||box.src==='band'||box.src==='side')&&!(Number(box.score)>=min))return false;
  return true;
}
export const labelOf=(box,zone)=>box.src==='band'?`far ${Number(box.score).toFixed(2)}`:`${zone||'-'} ${Number(box.score).toFixed(2)}`;
// A small "weak boxes" checkbox with a (?) hover. onChange runs after the stored value is updated.
export function weakToggle(onChange){
  const label=document.createElement('label'),cb=document.createElement('input'),q=document.createElement('span');
  cb.type='checkbox';cb.checked=weakShown();cb.onchange=()=>{setWeakShown(cb.checked);onChange?.();};
  q.textContent='(?)';q.title=TIP_FAR;q.style.cursor='help';
  label.append(cb,' weak boxes ',q);label.className='mut';
  return label;
}
