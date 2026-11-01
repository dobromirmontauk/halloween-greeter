// Sidecar client: line-delimited JSON, restart with backoff, fatal start errors disable it. Fake children only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createSidecarClient} from '../src/lib/sidecar.mjs';

function fakeChild(){
 const c=new EventEmitter();c.stdin=new PassThrough();c.stdout=new PassThrough();c.killed=false;c.kill=()=>{c.killed=true;setImmediate(()=>c.emit('exit',0));};return c;
}

test('sidecar client: line-delimited JSON round trip, restart with backoff, fatal start error disables',async()=>{
 const kids=[];const states=[];
 const client=createSidecarClient({command:'x',args:[],env:{},spawnImpl:()=>{const c=fakeChild();kids.push(c);return c;},restartBaseMs:5,onState:s=>states.push(s)});
 client.start();assert.equal(client.status().state,'starting');
 kids[0].stdout.write('{"id":null,"ok":true,"ready":true}\n');await new Promise(r=>setTimeout(r,5));assert.equal(client.status().state,'ready');
 kids[0].stdin.on('data',d=>{const req=JSON.parse(d.toString().trim());kids[0].stdout.write(JSON.stringify({id:req.id,ok:true,echo:req.cmd})+'\n');});
 assert.equal((await client.call('status')).echo,'status');
 kids[0].emit('exit',1);await new Promise(r=>setTimeout(r,30));
 assert.equal(kids.length,2,'restarted');assert.ok(states.includes('restarting'));
 kids[1].stdout.write('{"id":null,"ok":false,"fatal":true,"error":"model missing"}\n');await new Promise(r=>setTimeout(r,5));
 assert.equal(client.status().state,'disabled');assert.match(client.status().error,/model missing/);
 await assert.rejects(client.call('status'));
 client.stop();
});

test('sidecar client: a Python that cannot start disables the greeter instead of crashing the app',async()=>{
 const client=createSidecarClient({command:'nope',args:[],env:{},spawnImpl:()=>{const c=fakeChild();setImmediate(()=>c.emit('error',new Error('ENOENT')));return c;}});
 client.start();await new Promise(r=>setTimeout(r,10));assert.equal(client.status().state,'disabled');
});
