// Shared fixtures: build a Decisions response for whichever of the three judges the request addresses. No real images.
export const ans=(name,choice,confidence=0.99)=>({type:'choice',name,choice,confidence});
export function judgeAnswer(body,{count='1',people=[{motion:'present',face:'yes'}],location='porch',costumes=[]}={}){
  const names=body.questions.map(q=>q.name);
  if(names.includes('real_people_count'))return {answers:[ans('real_people_count',count),ans('closest_person_location',count==='0'?'none':location)]};
  if(names.includes('person_1_motion'))return {answers:[...people.flatMap((p,i)=>[ans(`person_${i+1}_motion`,p.motion),ans(`person_${i+1}_face_or_mask_visible`,p.face),ans(`person_${i+1}_location`,p.location||location)])]};
  return {answers:costumes.map((c,i)=>ans(`costume_${i+1}`,c))};
}
