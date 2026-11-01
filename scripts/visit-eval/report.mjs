const f=x=>x==null?'-':String(x);
export function printReport(r,title='Live timeline vs truth'){
  const out=[];const L=s=>out.push(s);
  L(`${title}: ${r.clips} clips, ${r.flaps} flaps`);L('');
  L('state      IoU    prec   recall  pred_s  truth_s');
  for(const [s,v] of Object.entries(r.states))L(`${s.padEnd(10)} ${f(v.iou).padEnd(6)} ${f(v.precision).padEnd(6)} ${f(v.recall).padEnd(7)} ${f(v.pred_s).padEnd(7)} ${f(v.truth_s)}`);
  L('');L('latency (ms, signed: + = late)');
  for(const [s,v] of Object.entries(r.latency))L(`${s.padEnd(9)} entry n=${v.entry_ms.n} mean=${f(v.entry_ms.mean)} median=${f(v.entry_ms.median)} max=${f(v.entry_ms.max)} | exit n=${v.exit_ms.n} mean=${f(v.exit_ms.mean)} median=${f(v.exit_ms.median)} max=${f(v.exit_ms.max)} | missed ${v.missed}`);
  const p=r.path_events;L('');L(`PATH events: truth ${p.truth} pred ${p.pred} exactly-one ${p.exactly_one} missed ${p.missed} fragmented ${p.fragmented} false ${p.false_pred} (on sidewalk-only clips ${p.false_path_on_sidewalk_only}) precision ${f(p.precision)} recall ${f(p.recall)}`);
  L('');L('clip                      known_s flaps IoU(EMPTY/SIDEWALK/PATH)  path truth/pred/exact/false');
  for(const c of r.per_clip)L(`${c.clip.padEnd(25)} ${String(c.known_s).padEnd(7)} ${String(c.flaps).padEnd(5)} ${[c.iou.EMPTY,c.iou.SIDEWALK,c.iou.PATH].map(f).join('/').padEnd(24)} ${c.path_truth}/${c.path_pred}/${c.path_exactly_one}/${c.false_path}`);
  console.log(out.join('\n'));
}
