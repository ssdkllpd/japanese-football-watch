'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');

test('actual workflow isolates guard and pointer failures even when a child consumes stdin',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'jfw-shell-r2-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const workflow=fs.readFileSync(path.join(__dirname,'../.github/workflows/api-football-automation.yml'),'utf8');
  const block=workflow.split('- name: Reconcile and publish finalized fixture objects to R2')[1].split('- name: Publish standings objects to R2')[0];
  const script=block.split('run: |\n')[1].split('\n').map(line=>line.startsWith('          ')?line.slice(10):line).join('\n');
  fs.mkdirSync(path.join(root,'bin'),{recursive:true});
  fs.mkdirSync(path.join(root,'.tmp/automation/d1'),{recursive:true});
  const ids=[7001,7002,7003,7004];
  fs.writeFileSync(path.join(root,'.tmp/automation/d1/admin-plan.json'),JSON.stringify({fixtures:ids.map(id=>({fixtureId:`af:fixture:${id}`}))}));
  for(const id of ids) {
    const dir=path.join(root,`.tmp/automation/artifacts/fixtures/${id}`);fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({fixtureId:`af:fixture:${id}`,r2Objects:[{role:'fixture',key:`fx/${id}.json`},{role:'fixture_pointer',key:`ptr/${id}.json`}]}));
    fs.writeFileSync(path.join(dir,'fixture.json'),JSON.stringify({fixture:{competitionId:'af:competition:39',seasonId:'af:season:39:2026',dateJst:'2026-10-03'}}));
    fs.writeFileSync(path.join(dir,'fixture-pointer.json'),'{}');
  }
  fs.writeFileSync(path.join(root,'bin/node'),`#!/usr/bin/env bash
case "$1" in
 *check-automation-fixture-corrections.mjs) [ "$2" = "af:fixture:7002" ] && exit 1; echo '{"latestRevision":0}' ;;
 *reconcile-fixture-revision.js) cp "$3" "$4" ;;
 *) exit 9 ;;
esac
`,{mode:0o755});
  fs.writeFileSync(path.join(root,'bin/npx'),`#!/usr/bin/env bash
cat >/dev/null
echo "$*" >> calls.log
case "$*" in
 *"r2 object get"*) echo 'not found 404'; exit 1 ;;
 *"r2 object put"*"ptr/7003.json"*) exit 1 ;;
 *"r2 object put"*) exit 0 ;;
 *) exit 9 ;;
esac
`,{mode:0o755});
  fs.writeFileSync(path.join(root,'step.sh'),script);
  const result=spawnSync('bash',['-euo','pipefail','step.sh'],{cwd:root,env:{...process.env,PATH:`${root}/bin:${process.env.PATH}`,R2_BUCKET:'offline'},encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stderr);
  const read=file=>fs.readFileSync(path.join(root,'.tmp/automation',file),'utf8').trim().split('\n');
  assert.deepEqual(read('ready-fixtures.txt'),['7001','7004']);
  assert.deepEqual(read('quarantined-fixtures.txt'),['7002','7003']);
  const puts=fs.readFileSync(path.join(root,'calls.log'),'utf8').split('\n').filter(line=>line.includes('r2 object put'));
  assert.equal(puts.length,6,'each healthy fixture has both writes; failed pointer never marks ready');
});
