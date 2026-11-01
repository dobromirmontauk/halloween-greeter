#!/usr/bin/env node
// Score the live debounced state timeline against truth. node scripts/visit-eval/score.mjs --dir data/visits --truth truth.ndjson [--json]
// Truth lines: {"clip":"<id>","t":<ms>,"state":"EMPTY|SIDEWALK|PATH|unsure"}; piecewise constant until the next sample, the last one runs to the clip's end.
import {loadVisits,loadTruth,joinTruth,scoreAll,parseArgs} from './lib.mjs';
import {printReport} from './report.mjs';
const a=parseArgs(process.argv.slice(2));
if(!a.truth){console.error('--truth <file> is required');process.exit(2);}
const clips=joinTruth(loadVisits(a.dir||'data/visits'),loadTruth(a.truth));
const r=scoreAll(clips);
if(a.json)console.log(JSON.stringify(r,null,1));else printReport(r);
