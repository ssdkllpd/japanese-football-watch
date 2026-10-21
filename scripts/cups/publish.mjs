import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {CUP_CATALOG_KEY} from '../../shared/cup-snapshot-contract.mjs';
const dir='.tmp/cups/public',cli='.tmp/cup-tools/node_modules/wrangler/bin/wrangler.js';
if(process.env.R2_BUCKET!=='jfw-football-data'||process.env.GITHUB_REF!=='refs/heads/main')throw new Error('Cup publication target is not main production R2');
const run=args=>execFileSync(process.execPath,[cli,'r2','object',...args,'--remote'],{stdio:'pipe'});
const objects=JSON.parse(fs.readFileSync(`${dir}/uploads.json`,'utf8'));
for(const object of objects){
  run(['put',`${process.env.R2_BUCKET}/${object.key}`,'--file',object.file,'--content-type','application/json']);
  const back=`${dir}/roundtrip.json`;
  run(['get',`${process.env.R2_BUCKET}/${object.key}`,'--file',back]);
  if(createHash('sha256').update(fs.readFileSync(back)).digest('hex')!==object.sha256)throw new Error('Cup R2 roundtrip hash mismatch');
}
run(['put',`${process.env.R2_BUCKET}/${CUP_CATALOG_KEY}`,'--file',`${dir}/catalog.json`,'--content-type','application/json']);
console.log(JSON.stringify({published:true,cups:objects.length,catalogKey:CUP_CATALOG_KEY}));
