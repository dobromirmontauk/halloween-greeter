import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

// detector/tiling.py is pure Python (no OpenCV): exercised through python3.
const dir=resolve(dirname(fileURLToPath(import.meta.url)),'..','detector');
const have=spawnSync('python3',['-c','1']).status===0;
const py=code=>{const r=spawnSync('python3',['-I','-c',`import sys,json;sys.path.insert(0,${JSON.stringify(dir)});import tiling as t\n${code}`],{encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);return JSON.parse(r.stdout);};

test('plan_tiles covers the top band edge to edge with overlap',{skip:!have},()=>{
 const tiles=py('print(json.dumps(t.plan_tiles(2560,1440)))');
 assert.equal(tiles.length,5);
 assert.deepEqual(tiles[0],[0,0,640,640]);assert.equal(tiles.at(-1)[2],2560,'last tile flush with the right edge');
 for(let i=1;i<tiles.length;i++)assert.ok(tiles[i][0]<tiles[i-1][2],'neighbouring tiles overlap');
 assert.ok(tiles.every(x=>x[1]===0&&x[3]>=0.4*1440*0+576),'one row anchored at the top covers y 0..0.40');
});

test('tile_to_full normalizes tile-relative boxes to the full frame',{skip:!have},()=>{
 const r=py("print(json.dumps(t.tile_to_full([{'bbox':[0.5,0.5,1,1],'score':0.5}],(480,0,1120,576),2560,1440)))");
 assert.deepEqual(r[0].bbox,[0.3125,0.2,0.4375,0.4]);
});

test('merge_boxes: NMS drops duplicates and contained fragments, keeps distinct people',{skip:!have},()=>{
 const r=py(`print(json.dumps(t.merge_boxes([
  {'bbox':[0.40,0.05,0.44,0.18],'score':0.6},
  {'bbox':[0.401,0.05,0.441,0.181],'score':0.5},
  {'bbox':[0.405,0.10,0.435,0.18],'score':0.4},
  {'bbox':[0.70,0.05,0.74,0.18],'score':0.45}])))`);
 assert.deepEqual(r.map(b=>b.score),[0.6,0.45]);
});

test('edge_clipped: only crop edges that are not image edges count',{skip:!have},()=>{
 const r=py(`print(json.dumps([t.edge_clipped({'bbox':[0.5,0.0,1.0,0.5]},(480,0,1120,576),2560,1440),
  t.edge_clipped({'bbox':[0.0,0.0,0.5,0.5]},(0,0,640,640),2560,1440),
  t.edge_clipped({'bbox':[0.2,0.2,0.5,0.5]},(480,0,1120,576),2560,1440)]))`);
 assert.deepEqual(r,[true,false,false]);
});
