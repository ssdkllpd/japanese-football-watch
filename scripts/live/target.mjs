import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const ROOT=fileURLToPath(new URL('../../',import.meta.url));
export function loadLiveTarget(root=ROOT) {
  const value=JSON.parse(fs.readFileSync(path.join(root,'config/live-worker-target.json'),'utf8'));
  if(value.schemaVersion!=='jfw-live-worker/1'||value.workerName!=='jfw-football-live-acquisition'||value.databaseName!=='jfw-football-live'
    ||typeof value.acquisitionEnabled!=='boolean'||Object.keys(value).length!==6||value.acquisitionMode!=='github'
    ||(value.databaseId!==null&&!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.databaseId))) throw new Error('Invalid live target');
  if(value.acquisitionEnabled&&!value.databaseId) throw new Error('Live acquisition needs the reviewed database ID');
  return value;
}
export function renderLiveTarget(target,output,root=ROOT) {
  if(!target.databaseId) throw new Error('Live database must be provisioned');
  const core=JSON.parse(fs.readFileSync(path.join(root,'config/public-worker-target.json'),'utf8'));
  const main=path.relative(path.dirname(output),path.join(root,'live-worker/index.mjs')).split(path.sep).join('/');
  const config=`name = "${target.workerName}"
main = ${JSON.stringify(main)}
compatibility_date = "2026-10-08"
workers_dev = false
[vars]
LIVE_ACQUISITION_ENABLED = "${target.acquisitionEnabled}"
LIVE_ACQUISITION_MODE = "${target.acquisitionMode}"
LIVE_COMPETITION_IDS = "${core.liveCompetitionIds.join(',')}"
[triggers]
crons = ["* * * * *"]
[[d1_databases]]
binding = "LIVE_DB"
database_name = "${target.databaseName}"
database_id = "${target.databaseId}"
[[d1_databases]]
binding = "FOOTBALL_DB"
database_name = "${core.d1DatabaseName}"
database_id = "${core.d1DatabaseId}"
[observability]
enabled = true
`;
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,config);
}
