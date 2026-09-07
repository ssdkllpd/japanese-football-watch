'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const root = path.resolve(__dirname,'..');
test('both published entry files have the same five text-only primary destinations',()=>{
 const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
 assert.equal(html,fs.readFileSync(path.join(root,'app-v2.html'),'utf8'));
 const doc=new JSDOM(html).window.document;
 assert.deepEqual([...doc.querySelectorAll('.bottom-nav button')].map(el=>el.textContent),['試合','リーグ','フォロー中','日本人','その他']);
 assert.deepEqual([...doc.querySelectorAll('.desktop-rail [data-page]')].map(el=>el.dataset.page),['matches','leagues','following','japanese','more']);
 assert.equal(JSON.parse(fs.readFileSync(path.join(root,'manifest.webmanifest'))).name,'Football Companion');
 for(const script of doc.scripts) assert.ok(fs.existsSync(path.join(root,script.getAttribute('src'))));
});
test('legacy entry remains available with its original title',()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(root,'legacy.html'),'utf8'));
 assert.equal(dom.window.document.title,'海外日本人ウォッチ（旧画面）');
});

test('narrow-screen CSS retains the 320px guard, readable rows and touch targets',t=>{
 const dom=new JSDOM('<!doctype html><head></head><body></body>');
 t.after(()=>dom.window.close());
 const style=dom.window.document.createElement('style');
 style.textContent=fs.readFileSync(path.join(root,'app-v2-wireframe.css'),'utf8');
 dom.window.document.head.append(style);
 const rules=[...style.sheet.cssRules];
 const narrow=rules.find(rule=>rule.conditionText==='(max-width: 359px)');
 assert.ok(narrow,'the 320px layout must have its narrow-screen media contract');
 const declaration=(items,selector,property)=>items.filter(rule=>rule.selectorText?.split(',').map(s=>s.trim()).includes(selector))
  .map(rule=>rule.style.getPropertyValue(property)).filter(Boolean).at(-1);
 const compact=[...narrow.cssRules];
 assert.equal(declaration(compact,'.app-main','padding-inline'),'8px');
 assert.equal(declaration(compact,'.fixture-row','grid-template-columns'),'46px minmax(0, 1fr) 44px');
 assert.equal(declaration(compact,'.profile-grid','grid-template-columns'),'1fr');
 for(const selector of ['.follow-button','.chip','.back-button','.detail-tab','.season-select'])assert.equal(declaration(rules,selector,'min-height'),'44px');
 for(const selector of ['.fixture-row','.team-name','.entity-name','.lineup-person','.rating-row'])assert.equal(declaration(rules,selector,'font-size'),'15px');
 assert.equal(declaration(rules,'.detail-tabs','overflow-x'),'auto');
 assert.equal(declaration(rules,'.detail-tab','flex'),'0 0 auto');
});
