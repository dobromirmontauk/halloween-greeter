// Improvised welcomes/goodbyes: build a compact BRIEF (facts + one random comedic angle + avoid-recent), never a script.
// Angle themes are seeded from JOKES.md; the model writes the actual words.
export const WELCOME_ANGLES=[
 {id:'crew',theme:'the skeleton crew out here as your coworkers, short-staffed and questionable management'},
 {id:'renovation',theme:'the renovation: the house has good bones, the table saw and the fellow on the ladder'},
 {id:'candy',theme:'you were left in charge of the candy bowl, a curious choice given how you died'},
 {id:'banjo',theme:'your banjo playing, which you say keeps the spirits away'},
 {id:'nightshift',theme:'the night shift: haunting is steady work with no overtime and terrible hours'},
 {id:'weather',theme:"tonight's weather and how a chill suits a ghost fine"},
 {id:'dead',theme:'being dead a while, so your references are dated'},
 {id:'neighborhood',theme:'the neighborhood after dark, parking and rent compared to haunting it'},
 {id:'lateness',theme:'how the evening is going so far: the stream of visitors, how long you have been on the porch'},
 {id:'manners',theme:'a porch-etiquette rule you just invented'},
 {id:'bones',theme:'bones and backbone puns, kept gentle'},
 {id:'quiet',theme:'how nice it is to have living company after a long quiet stretch'}
];
export const GOODBYE_ANGLES=[
 {id:'backtodead',theme:'getting back to being dead, with a short commute'},
 {id:'leavecandy',theme:'leave a little candy for the next group, gently'},
 {id:'banjo',theme:'going back to banjo practice, which the neighbors tolerate'},
 {id:'nightshift',theme:'clocking off the night shift, which ghosts never really do'},
 {id:'crew',theme:'the skeleton crew needing supervision'},
 {id:'weather',theme:'heading in out of the chill, or what the chill does to old bones'},
 {id:'nextyear',theme:'see you next Halloween, same porch, same dead fellow'},
 {id:'bedtime',theme:"a ghost's bedtime, which is whenever the sun comes up"}
];
const words=text=>String(text||'').replace(/\s+/g,' ').trim();
const first=(text,n=6)=>words(text).split(/\s+/).slice(0,n).join(' ').replace(/[^\w' ,!?.-]/g,'').trim();
// Costume-cue question pool: rotated via improv avoid-recent (never the same question twice in a row while others are fresh).
export const COSTUME_QUESTIONS=[
 {id:'candy',text:'What is your favorite candy?'},
 {id:'house',text:'What has been your favorite house tonight?'},
 {id:'crew',text:'Did you see our skeleton work crew?'},
 {id:'supposed',text:'What are YOU supposed to be?'},
 {id:'bestcostume',text:'Which costume have you seen tonight that beat everybody else?'}
];
export function createImprov({max=8}={}){
 const briefs=[],openings=[],questions=[];let buffer='',inAssistant=false;
 const flush=()=>{const open=first(buffer);buffer='';inAssistant=false;if(open){openings.push(open);while(openings.length>max)openings.shift();}};
 return {
  noteBrief(id){briefs.push(id);while(briefs.length>max)briefs.shift();},
  // Live transcript events: an opening = first words of each consecutive run of assistant deltas.
  noteTranscript(event){if(!event)return;const text=event.delta??event.text??'';if(event.role==='assistant'){if(!inAssistant){inAssistant=true;buffer='';}if(words(buffer).split(/\s+/).length<8)buffer+=String(text);}else if(event.role==='user'&&inAssistant)flush();},
  noteQuestion(id){questions.push(id);while(questions.length>max)questions.shift();},
  recentQuestions(){return [...questions];},
  recentAngles(){return [...briefs];},
  recentOpenings(){const all=[...openings];if(inAssistant&&words(buffer).split(/\s+/).length>=3)all.push(first(buffer));return all.slice(-max);}
 };
}
const pick=(pool,recent,rng)=>{const fresh=pool.filter(a=>!recent.includes(a.id));const from=fresh.length?fresh:pool;return from[Math.min(from.length-1,Math.floor(rng()*from.length))];};
const partyLine=(size,state)=>{const n=Number.isInteger(size)&&size>0?size:null;return (n===null?'A group of guests':n===1?'One guest':`A group of ${n} guests`)+(state==='PATH'?' just stepped onto the path':' has arrived');};
const eveningPart=hour=>!Number.isFinite(hour)?null:hour>=21||hour<5?'late in the evening':hour>=19?'mid-evening':hour>=17?'early evening, near dusk':null;
const avoid=(label,items)=>items.length?` Avoid ${label}: ${items.map(x=>`"${x}"`).join(', ')}.`:'';
const themesOf=(pool,ids)=>ids.map(id=>pool.find(a=>a.id===id)?.theme.split(',')[0].split(':')[0]).filter(Boolean);
export function welcomeBrief({partySize=null,groupState='PATH',hour=NaN,costumeLabels=[],rng=Math.random,improv=null,barked=false}={}){
 const recentAngles=(improv?.recentAngles()||[]).filter(id=>!id.startsWith('g:')),openings=improv?.recentOpenings()||[];
 const angle=pick(WELCOME_ANGLES,recentAngles,rng);improv?.noteBrief(angle.id);
 const when=eveningPart(hour),costumes=(costumeLabels||[]).filter(Boolean).slice(0,2);
 const known=`${partyLine(partySize,groupState)}${when?`; it is ${when}`:''}.${costumes.length?` Confident costume read: ${costumes.join(', ')}.`:''}`;
 const prompt=`Welcome brief. ${known} Improvise ONE short in-character welcome: 1-2 sentences, about 6 seconds spoken, child-friendly.${barked?' You already called out to them from the sidewalk like a barker; this is the warm, personal close-up hello, not another call-out.':''} Comedic angle: ${angle.theme}. Use it loosely in your own fresh words; do not recite joke-bank lines. ${costumes.length?'You may nod to the costume once. ':'Do not mention costumes, clothing or appearance. '}Do not identify anyone. "Happy Halloween!" is fine but must not open every greeting; vary your opening.${avoid('these recent openings',openings)}${avoid('these recent angles',themesOf(WELCOME_ANGLES,recentAngles))} End with one easy question for the guests, then WAIT for their reply. Do not ask about costumes yet.`;
 return {prompt,angle:angle.id};
}
export function goodbyeBrief({rng=Math.random,improv=null}={}){
 const recent=(improv?.recentAngles()||[]).filter(id=>id.startsWith('g:')).map(id=>id.slice(2)),openings=improv?.recentOpenings()||[];
 const angle=pick(GOODBYE_ANGLES,recent,rng);improv?.noteBrief('g:'+angle.id);
 const prompt=`Goodbye brief. Improvise ONE short in-character farewell: one sentence, about 4 seconds, child-friendly. Comedic angle: ${angle.theme}. Your own fresh words, then stop and ask no new question.${avoid('these recent openings',openings)}${avoid('these recent angles',themesOf(GOODBYE_ANGLES,recent))}`;
 return {prompt,angle:angle.id};
}
export function costumeQuestion({rng=Math.random,improv=null}={}){
 const recent=(improv?.recentQuestions?.()||[]).slice(-Math.max(1,COSTUME_QUESTIONS.length-2));
 const q=pick(COSTUME_QUESTIONS,recent,rng);improv?.noteQuestion?.(q.id);return q;
}
// Barker call-out for a group that has just reached the sidewalk (events mode, once per group). The model improvises the words.
export function barkerBrief({partySize=null,rng=Math.random,improv=null}={}){
 const openings=improv?.recentOpenings()||[];
 const who=Number.isInteger(partySize)&&partySize>1?'A group is':'Someone is';
 const prompt=`Barker brief. ${who} walking along the sidewalk. Call out like an old-time circus barker to draw them toward the porch: loud, theatrical, inviting, one short burst of one or two sentences, child-friendly. Mention the candy, curiosities or your skeleton work crew in your own fresh words. Do not ask a question, do not mention costumes, clothing or appearance, and do not identify anyone. Do not badger them if they keep walking.${avoid('these recent openings',openings)}`;
 return {prompt};
}
// A fresh angle for generic (non-costume-specific) lines elsewhere, tracked with the welcome angles.
export function angleBrief({rng=Math.random,improv=null}={}){
 const recent=(improv?.recentAngles()||[]).filter(id=>!id.startsWith('g:'));const angle=pick(WELCOME_ANGLES,recent,rng);improv?.noteBrief(angle.id);return angle;
}

// Mixed arriving/leaving (a Live session is already open). Facts + a fresh angle + avoid-recent, like the welcome/goodbye briefs; the model improvises the words.
const plural=(n,one,many)=>n===1?one:many;
export function newcomersBrief({newcomers=1,rng=Math.random,improv=null}={}){
 const recentAngles=(improv?.recentAngles()||[]).filter(id=>!id.startsWith('g:')),openings=improv?.recentOpenings()||[];
 const angle=pick(WELCOME_ANGLES,recentAngles,rng);improv?.noteBrief(angle.id);
 const who=newcomers===1?'One more guest has':`${newcomers} more guests have`;
 const prompt=`Newcomers brief. ${who} just walked up while you are mid-conversation. Treat them as a new group: their costumes and answers are unknown; do not reuse anything the earlier guests said. Improvise ONE short in-character welcome: one or two sentences, about 5 seconds, child-friendly. Comedic angle: ${angle.theme}. Your own fresh words, then ask the newcomers one easy question and WAIT for the reply. Do not ask about costumes yet.${avoid('these recent openings',openings)}${avoid('these recent angles',themesOf(WELCOME_ANGLES,recentAngles))}`;
 return {prompt,angle:angle.id};
}
export function departuresBrief({departures=1,rng=Math.random,improv=null}={}){
 const recent=(improv?.recentAngles()||[]).filter(id=>id.startsWith('g:')).map(id=>id.slice(2)),openings=improv?.recentOpenings()||[];
 const angle=pick(GOODBYE_ANGLES,recent,rng);improv?.noteBrief('g:'+angle.id);
 const who=departures===1?'One guest is':`${departures} guests are`;
 const prompt=`Departures brief. ${who} heading out, but other guests are still here. Improvise ONE short in-character goodbye to those leaving: one sentence, about 3 seconds, child-friendly. Comedic angle: ${angle.theme}. Your own fresh words. Do not say goodbye to the guests who stay, ask no new question, and keep the conversation with them open.${avoid('these recent openings',openings)}${avoid('these recent angles',themesOf(GOODBYE_ANGLES,recent))}`;
 return {prompt,angle:angle.id};
}
export function mixedBrief({newcomers=1,departures=1,rng=Math.random,improv=null}={}){
 const recentAngles=(improv?.recentAngles()||[]).filter(id=>!id.startsWith('g:')),openings=improv?.recentOpenings()||[];
 const angle=pick(WELCOME_ANGLES,recentAngles,rng);improv?.noteBrief(angle.id);
 const out=departures===1?'One guest is':`${departures} guests are`,inn=newcomers===1?'one new guest is':`${newcomers} new guests are`;
 const prompt=`Mixed brief. Some guests are heading out while new ones arrive: ${out} leaving and ${inn} arriving. Improvise ONE short in-character line, two sentences at most, about 6 seconds: say goodbye to the leavers and welcome the newcomers in the same breath, then ask the newcomers one easy question and WAIT for the reply. Treat the newcomers as a new group: their costumes and answers are unknown; do not reuse anything the earlier guests said. Comedic angle: ${angle.theme}. Your own fresh words, child-friendly. Do not ask about costumes yet.${avoid('these recent openings',openings)}${avoid('these recent angles',themesOf(WELCOME_ANGLES,recentAngles))}`;
 return {prompt,angle:angle.id};
}
