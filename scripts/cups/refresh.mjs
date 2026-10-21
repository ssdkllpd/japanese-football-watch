import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {prepareCups,writePreparedCups} from './prepare.mjs';
import {assertCupSnapshot,CUP_CATALOG_KEY} from '../../shared/cup-snapshot-contract.mjs';

// A complete season grows as draws are made. Never replace it with a partial reply.
export function assertCupRefresh(previous,next) {
  const byId=new Map(next.objects.map(o=>[o.entry.id,JSON.parse(o.text)]));
  for(const old of previous) {
    const value=assertCupSnapshot(old,old.competition.id,old.season.id),fresh=byId.get(value.competition.id);
    if(!fresh||fresh.season.id!==value.season.id||fresh.generatedAt<value.generatedAt)throw new Error('Cup refresh scope or timestamp regressed');
    const rows=new Map(fresh.fixtures.map(f=>[f.fixtureId,f]));
    for(const f of value.fixtures) {
      const replacement=rows.get(f.fixtureId);
      if(!replacement)throw new Error(`Cup refresh lost a stored fixture: ${f.fixtureId}`);
      if(['home','away'].some(side=>f.teams[side].id!==replacement.teams[side].id))throw new Error('Cup refresh changed fixture identity');
    }
    if(value.standings&&!fresh.standings)throw new Error('Cup refresh lost acquired standings');
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.env.GITHUB_REF!=='refs/heads/main'||process.env.R2_BUCKET!=='jfw-football-data')throw new Error('Cup refresh requires the reviewed main target');
  const cli='.tmp/cup-tools/node_modules/wrangler/bin/wrangler.js',dir='.tmp/cups';
  fs.mkdirSync(dir,{recursive:true});
  const run=(script,args=[])=>execFileSync(process.execPath,[script,...args],{stdio:'inherit'});
  const r2=args=>execFileSync(process.execPath,[cli,'r2','object',...args,'--remote'],{stdio:'pipe'});
  r2(['get',`${process.env.R2_BUCKET}/${CUP_CATALOG_KEY}`,'--file',`${dir}/previous-catalog.json`]);
  const catalog=JSON.parse(fs.readFileSync(`${dir}/previous-catalog.json`,'utf8')),previous=[];
  if(catalog.schemaVersion!=='jfw-cup-catalog/1'||catalog.competitions.length!==14)throw new Error('Previous cup catalog is incomplete');
  for(const entry of catalog.competitions) {
    if(!/^football\/v2\/cups\/snapshots\/[a-f0-9]{64}\.json$/.test(entry.snapshotKey))throw new Error('Invalid previous cup key');
    r2(['get',`${process.env.R2_BUCKET}/${entry.snapshotKey}`,'--file',`${dir}/previous.json`]);
    const raw=fs.readFileSync(`${dir}/previous.json`,'utf8');
    if(createHash('sha256').update(raw).digest('hex')!==entry.snapshotSha256)throw new Error('Previous cup hash differs');
    previous.push(JSON.parse(raw));
  }
  run('scripts/cups/inspect.mjs');
  const raw=fs.readFileSync(`${dir}/snapshot.json`,'utf8'),source=JSON.parse(fs.readFileSync(`${dir}/summary.json`,'utf8'));
  const prepared=prepareCups(raw,{source});
  assertCupRefresh(previous,prepared);
  r2(['put',`${process.env.R2_BUCKET}/${source.snapshotKey}`,'--file',`${dir}/snapshot.json`,'--content-type','application/json']);
  writePreparedCups(prepared);
  run('scripts/cups/publish.mjs');
  run('scripts/cups/bootstrap-catalog.mjs');
  console.log(JSON.stringify({cupRefresh:true,cups:prepared.objects.length,generatedAt:prepared.catalog.generatedAt,quota:source.quota}));
}
