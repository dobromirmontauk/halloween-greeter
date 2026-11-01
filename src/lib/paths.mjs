import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
// Project root (the directory holding server.mjs, prompts/, public/, detector/, data/).
export const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..','..');
