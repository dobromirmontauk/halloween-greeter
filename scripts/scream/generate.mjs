#!/usr/bin/env node
// Renders the sidewalk-scream clips (src/presence/scream.mjs plays them) with OpenAI TTS. Never the Live voice.
// Each clip = three TTS calls in one voice, each with its own acting direction, joined with short gaps into one 24 kHz mono WAV:
//   1. a terrified scream   2. a laugh (it was all a joke)   3. "Happy Halloween! Come get some candy!"
//
//   node scripts/scream/generate.mjs [--out data/screams] [--count 4] [--model gpt-4o-mini-tts] [--voices ash,coral,ballad,verse] [--force]
//   on the device:  cd ~/halloween-source/halloween-greeter && node scripts/scream/generate.mjs
// OPENAI_API_KEY comes from the environment, else from .env / OPENAI_ENV_FILE in this directory. Cost: about 3 short TTS calls per clip (cents).
// Existing clips are kept unless --force; the server picks up new files without a restart.
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..','..');
const RATE=24000; // OpenAI `pcm` output: 24 kHz, 16-bit signed little-endian, mono

const SCREAMS=['AAAAAAAAHHHHHHHHH!','AAAAHHH! AAAAAAAAAHHHHHHH!','Aaaah, no no no NO! AAAAAAAAHHHHH!','EEEEEEAAAAAAAHHHHHHH!'];
const LAUGHS=['Ha ha ha ha ha ha! Hahaha!','Hahahaha... heh heh heh, ha ha!','Ahahaha! Ha ha ha ha!','Heh... hahaha, HA HA HA!'];
const LINE='Happy Halloween! Come get some candy!';
const DIRECTION={
 scream:'You just saw something horrifying in the dark. Scream in blind, total terror at the top of your lungs, raw and breathless, voice cracking. A real scream, not words, not acting cute.',
 laugh:'The fright was a prank. Burst into a big, genuine, delighted belly laugh, a bit breathless from the scream.',
 line:'Still laughing a little, warm, loud and excited, calling out to trick-or-treaters on the sidewalk from the porch.'
};
const GAP_MS={scream:300,laugh:150};

function args(argv){
 const o={out:'data/screams',count:4,model:'gpt-4o-mini-tts',voices:['ash','coral','ballad','verse'],force:false};
 for(let i=0;i<argv.length;i++){const a=argv[i],v=()=>argv[++i];
  if(a==='--out')o.out=v();else if(a==='--count')o.count=Math.max(1,Number(v())||1);else if(a==='--model')o.model=v();
  else if(a==='--voices')o.voices=v().split(',').map(s=>s.trim()).filter(Boolean);else if(a==='--force')o.force=true;
  else throw new Error('unknown argument '+a);}
 return o;
}
async function envKey(){
 if(process.env.OPENAI_API_KEY)return process.env.OPENAI_API_KEY;
 const files=[join(root,'.env')];
 const read=async f=>{try{return await readFile(f,'utf8');}catch{return '';}};
 const pick=(text,name)=>text.match(new RegExp('^'+name+'=(.*)$','m'))?.[1]?.trim().replace(/^["']|["']$/g,'');
 const env=await read(files[0]);const extra=pick(env,'OPENAI_ENV_FILE');
 return pick(env,'OPENAI_API_KEY')||(extra?pick(await read(extra),'OPENAI_API_KEY'):null);
}
async function speak({key,model,voice,input,instructions}){
 const r=await fetch('https://api.openai.com/v1/audio/speech',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
  body:JSON.stringify({model,voice,input,instructions,response_format:'pcm'})});
 if(!r.ok)throw new Error(`TTS ${r.status}: ${(await r.text()).slice(0,300)}`);
 return Buffer.from(await r.arrayBuffer());
}
const silence=ms=>Buffer.alloc(Math.round(RATE*ms/1000)*2);
export function wav(pcm){
 const h=Buffer.alloc(44);
 h.write('RIFF',0);h.writeUInt32LE(36+pcm.length,4);h.write('WAVE',8);h.write('fmt ',12);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);
 h.writeUInt32LE(RATE,24);h.writeUInt32LE(RATE*2,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);
 return Buffer.concat([h,pcm]);
}
async function main(){
 const o=args(process.argv.slice(2));const key=await envKey();
 if(!key)throw new Error('OPENAI_API_KEY not found (environment, .env or OPENAI_ENV_FILE)');
 const dir=resolve(root,o.out);await mkdir(dir,{recursive:true});
 for(let i=0;i<o.count;i++){
  const voice=o.voices[i%o.voices.length],file=join(dir,`scream-${String(i+1).padStart(2,'0')}-${voice}.wav`);
  if(!o.force&&await access(file).then(()=>true,()=>false)){console.log('keep  '+file);continue;}
  const parts=[
   await speak({key,model:o.model,voice,input:SCREAMS[i%SCREAMS.length],instructions:DIRECTION.scream}),silence(GAP_MS.scream),
   await speak({key,model:o.model,voice,input:LAUGHS[i%LAUGHS.length],instructions:DIRECTION.laugh}),silence(GAP_MS.laugh),
   await speak({key,model:o.model,voice,input:LINE,instructions:DIRECTION.line}),silence(200)];
  const pcm=Buffer.concat(parts);
  await writeFile(file,wav(pcm));
  console.log(`wrote ${file} (${(pcm.length/2/RATE).toFixed(1)} s)`);
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exit(1);});
