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
