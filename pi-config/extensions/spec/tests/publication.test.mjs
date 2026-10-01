// Publication integrity regressions: all mutations and injected failures stay in disposable fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../core/sova-spec-draft.mjs');
const CORE = resolve(dirname(CLI), 'sova-spec.mjs');
const sha = x => createHash('sha256').update(x).digest('hex');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'NODE_OPTIONS'));
const write = (r, p, s) => { fs.mkdirSync(dirname(join(r,p)), {recursive:true}); fs.writeFileSync(join(r,p), typeof s === 'string' ? s : JSON.stringify(s,null,2)+'\n'); };
const read = (r,p) => fs.readFileSync(join(r,p),'utf8');
const metadata = r => JSON.parse(read(r,'.sova/spec/drafts/d/draft.json'));
const codes = j => [...(j.findings ?? []), ...(j.refusals ?? [])].map(x => x.code);
function run(r,args,extra={},tool=CLI) {
  const p=spawnSync(process.execPath,[tool,...args,'--root',r,'--json'],{cwd:r,encoding:'utf8',env:{...env,HOME:join(r,'home'),XDG_CONFIG_HOME:join(r,'home'),...extra},timeout:30000});
  if (p.status === 86) return {crashed:true};
  assert.ifError(p.error);
  const j=JSON.parse(p.stdout); assert.equal(j.exit,p.status,p.stderr); return j;
}
function git(r,...args) {
  const p=spawnSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','-c','init.defaultBranch=main','-C',r,...args],{encoding:'utf8',env:{...env,HOME:join(r,'home'),XDG_CONFIG_HOME:join(r,'home')}});
  assert.equal(p.status,0,p.stderr);return p.stdout.trim();
}
function fixture(t,{mapped=true,gitRepo=false,note=false,pair=false}={}) {
  const r=fs.mkdtempSync(join(tmpdir(),'spec-publication-'));
  t.after(()=>fs.rmSync(r,{recursive:true,force:true}));
  write(r,'.sova/spec/manifest.json',{formatVersion:1,boundary:{include:['src']},claims:{'§a/top':{kind:note?'note':'behavior',authority:'accepted',requires:[],...(mapped?{code:['src/a.txt']}: {})}}});
  write(r,'.sova/spec/claims/a/top.md','# §a/top\n\nOld.\n'); write(r,'src/a.txt','code\n');
  if(pair){const m=JSON.parse(read(r,'.sova/spec/manifest.json'));m.claims['§b/top']={...m.claims['§a/top']};write(r,'.sova/spec/manifest.json',m);write(r,'.sova/spec/claims/b/top.md','# §b/top\n\nOld.\n');}
  write(r,'.gitignore','.sova/spec/drafts/\n');
  if(gitRepo){git(r,'init','-q');git(r,'add','.');git(r,'commit','-qm','base');}
  assert.equal(run(r,['new','d','--write']).exit,0);
  write(r,'.sova/spec/drafts/d/spec/claims/a/top.md','# §a/top\n\nNew.\n');
  // Two current targets make crashes between claim and manifest writes observable.
  const m=JSON.parse(read(r,'.sova/spec/drafts/d/spec/manifest.json'));m.claims['§a/top'].evidence='verified';write(r,'.sova/spec/drafts/d/spec/manifest.json',m);
  if(pair)write(r,'.sova/spec/drafts/d/spec/claims/b/top.md','# §b/top\n\nNew.\n');
  return r;
}
const evidence=(r,more=[])=>run(r,['evidence','d','--id','§a/top','--by','fixture','--verification','fixture bytes inspected',...more,'--write']);
const promote=(r,more=[])=>run(r,['promote','d','--id','§a/top',...more]);
const current=r=>['manifest.json','claims/a/top.md'].map(p=>read(r,`.sova/spec/${p}`));
function injector(r,body) {
  const p=join(r,'inject.mjs');fs.writeFileSync(p,`import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module'; const rename=fs.rename; let fired=false; fs.rename=async function(a,b){ ${body} };syncBuiltinESMExports();`);return {NODE_OPTIONS:`--import=${p}`};
}

test('receipt write failure rolls back both current documents and ledger', t=>{
  const r=fixture(t);assert.equal(evidence(r,['--snapshot']).exit,0);
  const before=current(r),ledger=read(r,'.sova/spec/drafts/d/draft.json');
  const fault=injector(r,`if(b===${JSON.stringify(join(r,'.sova/spec/drafts/d/draft.json'))}){const e=new Error('receipt denied');e.code='EACCES';throw e;}return rename(a,b);`);
  const j=run(r,['promote','d','--id','§a/top','--write'],fault);
  assert.notEqual(j.exit,0); assert.deepEqual(current(r),before,'no publication without receipt');
  assert.equal(read(r,'.sova/spec/drafts/d/draft.json'),ledger,'receipt ledger stays prior');
  assert.equal(run(r,['recover']).pending,false,'clean rollback leaves no orphan transaction');
});

for(const suffix of ['claims/a/top.md','manifest.json','drafts/d/draft.json']) {
  test(`crash immediately after ${suffix} replacement is journaled and recovery is idempotent`,t=>{
    const r=fixture(t);assert.equal(evidence(r,['--snapshot']).exit,0);
    const before=current(r),ledger=read(r,'.sova/spec/drafts/d/draft.json');
    const fault=injector(r,`await rename(a,b);if(b===${JSON.stringify(join(r,'.sova/spec',suffix))})process.exit(86);`);
    assert.equal(run(r,['promote','d','--id','§a/top','--write'],fault).crashed,true);
    const pending=run(r,['recover']);assert.equal(pending.pending,true,'failure remains explicit');
    assert.equal(run(r,['recover','--write']).exit,0);
    assert.deepEqual(current(r),before);assert.equal(read(r,'.sova/spec/drafts/d/draft.json'),ledger);
    assert.equal(run(r,['recover','--write']).pending,false);
    assert.equal(promote(r,['--write']).exit,0);assert.equal(metadata(r).promotions.length,1,'retry records exactly once');
    assert.match(current(r)[1],/New/); assert.equal(run(r,['recover']).pending,false);
  });
}

test('throw after a successful replacement rolls that replacement back too',t=>{
  const r=fixture(t);assert.equal(evidence(r,['--snapshot']).exit,0);const before=current(r);
  const fault=injector(r,`await rename(a,b);if(!fired && b===${JSON.stringify(join(r,'.sova/spec/claims/a/top.md'))}){fired=true;throw new Error('post-rename failure');}`);
  const j=run(r,['promote','d','--id','§a/top','--write'],fault);assert.notEqual(j.exit,0);
  assert.deepEqual(current(r),before);assert.equal(metadata(r).promotions.length,0);
  assert.equal(run(r,['recover']).pending,false);
});

test('failed rollback leaves an explicit pending journal that uninjured recovery restores',t=>{
  const r=fixture(t);assert.equal(evidence(r,['--snapshot']).exit,0);const before=current(r),ledger=read(r,'.sova/spec/drafts/d/draft.json');
  const target=JSON.stringify(join(r,'.sova/spec/claims/a/top.md'));
  const fault=injector(r,`if(b===${target}){if(fired){const e=new Error('rollback denied');e.code='EACCES';throw e;}fired=true;await rename(a,b);throw new Error('after write');}return rename(a,b);`);
  const j=run(r,['promote','d','--id','§a/top','--write'],fault);assert.ok(codes(j).includes('rollback-failed'));assert.equal(j.pending,true);
  assert.match(current(r)[1],/New/);assert.equal(metadata(r).promotions.length,0);assert.equal(run(r,['recover']).pending,true);
  assert.equal(run(r,['recover','--write']).exit,0);assert.deepEqual(current(r),before);assert.equal(read(r,'.sova/spec/drafts/d/draft.json'),ledger);
  assert.equal(run(r,['recover','--write']).pending,false);
});

for(const damage of ['foreign receipt','corrupt receipt backup'])test(`recovery of ${damage} refuses before restoring current documents`,t=>{
  const r=fixture(t);assert.equal(evidence(r,['--snapshot']).exit,0);
  const fault=injector(r,`await rename(a,b);if(b===${JSON.stringify(join(r,'.sova/spec/drafts/d/draft.json'))})process.exit(86);`);
  assert.equal(run(r,['promote','d','--id','§a/top','--write'],fault).crashed,true);
  const txn='.sova/spec/drafts/.txn',journal=JSON.parse(read(r,`${txn}/journal.json`)),receipt=journal.targets.find(x=>x.storage==='draft');assert.ok(receipt);
  if(damage==='foreign receipt')write(r,'.sova/spec/drafts/d/draft.json','foreign ledger\n');else write(r,`${txn}/old-${receipt.i}`,'wrong backup\n');
  const published=current(r),ledger=read(r,'.sova/spec/drafts/d/draft.json');
  const j=run(r,['recover','--write']);assert.notEqual(j.exit,0);assert.deepEqual(current(r),published,'refusal precedes all restoration');assert.equal(read(r,'.sova/spec/drafts/d/draft.json'),ledger);
  assert.equal(fs.existsSync(join(r,txn,'journal.json')),true,'pending transaction retained');
});

test('input-free forged evidence is rejected even for an unmapped behavior',t=>{
  const r=fixture(t,{mapped:false});assert.equal(evidence(r,['--snapshot','--path','src/a.txt']).exit,0);
  const d=metadata(r);d.evidence[0].inputs=[];write(r,'.sova/spec/drafts/d/draft.json',d);const before=current(r);
  const j=promote(r,['--write']);assert.ok(codes(j).includes('evidence-stale'));assert.match(j.evidence[0].reasons.join(),/present implementation/);
  assert.deepEqual(current(r),before);assert.equal(metadata(r).promotions.length,0);
});

for(const mode of ['snapshot','commit','doc-only'])for(const damage of ['missing','corrupt']) {
  test(`${mode} evidence refuses ${damage} retained verification log`,t=>{
    const r=fixture(t,{gitRepo:mode==='commit',note:mode==='doc-only'});write(r,'run.log','fixture log\n');
    const ev=evidence(r,[...(mode==='commit'?['--commit','HEAD']:[`--${mode}`]),'--log',join(r,'run.log')]);assert.equal(ev.exit,0);
    const p=join(r,'.sova/spec/drafts/d/evidence/objects',ev.log.sha256);if(damage==='missing')fs.unlinkSync(p);else fs.writeFileSync(p,'wrong log\n');
    const before=current(r),j=promote(r,['--write']);assert.ok(codes(j).includes('evidence-stale'));assert.match(j.evidence[0].reasons.join(),/retained verification log/);
    assert.deepEqual(current(r),before);assert.equal(metadata(r).promotions.length,0);
  });
}

test('symlinked log ancestor is refused before its bytes are opened or retained',t=>{
  const r=fixture(t),outside=fs.mkdtempSync(join(tmpdir(),'spec-log-outside-'));t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  write(outside,'run.log','OUTSIDE DUMMY LOG\n');fs.symlinkSync(outside,join(r,'logs'));
  const p=join(r,'read-probe.mjs'),marker=join(r,'read-marker');
  fs.writeFileSync(p,`import fs from 'node:fs/promises';import sync from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const open=fs.open;fs.open=async function(p,...a){if(String(p)===${JSON.stringify(join(r,'logs/run.log'))})sync.writeFileSync(${JSON.stringify(marker)},'read');return open.call(this,p,...a)};syncBuiltinESMExports();`);
  const j=run(r,['evidence','d','--id','§a/top','--by','fixture','--verification','fixture','--snapshot','--log',join(r,'logs/run.log'),'--write'],{NODE_OPTIONS:`--import=${p}`});
  assert.ok(codes(j).includes('log-refused'));assert.equal(fs.existsSync(marker),false,'ancestor refusal precedes open');
  assert.equal(metadata(r).evidence.length,0);assert.equal(fs.existsSync(join(r,'.sova/spec/drafts/d/evidence')),false);
});

test('replacement evidence clears only superseded IDs from active orphan warnings',t=>{
  const r=fixture(t,{gitRepo:true});git(r,'switch','-qc','side');write(r,'src/a.txt','side\n');git(r,'commit','-qam','side');
  assert.equal(evidence(r,['--commit','HEAD']).exit,0);git(r,'switch','-q','main');
  assert.equal(evidence(r,['--commit','HEAD']).exit,0);assert.equal(metadata(r).evidence.length,2,'history retained');
  const check=run(r,['check','d']);assert.equal(check.exit,0,JSON.stringify(check.findings));assert.deepEqual(check.evidenceNotAncestor,[]);
  assert.equal(promote(r).evidence[0].state,'valid');
  const census=run(r,['census','--changed'],{},CORE);assert.deepEqual(census.census.orphanedEvidence,[]);
  // A broken latest binding is not satisfied by falling back to older entries.
  const d=metadata(r);d.evidence[1].ids[0].textSha256=sha('wrong');write(r,'.sova/spec/drafts/d/draft.json',d);
  assert.equal(promote(r).evidence[0].state,'stale');
});

test('partial replacement retires only its ID from a multi-ID orphan evidence entry',t=>{
  const r=fixture(t,{gitRepo:true,pair:true});git(r,'switch','-qc','side');write(r,'src/a.txt','side\n');git(r,'commit','-qam','side');
  assert.equal(evidence(r,['--commit','HEAD','--id','§b/top']).exit,0);const old=metadata(r).evidence[0].commit;git(r,'switch','-q','main');assert.equal(evidence(r,['--commit','HEAD']).exit,0);
  const check=run(r,['check','d']);assert.equal(check.exit,1);assert.deepEqual(check.evidenceNotAncestor,[{commit:old,reason:'not-ancestor',ids:['§b/top']}]);
  const census=run(r,['census','--changed'],{},CORE);assert.deepEqual(census.census.orphanedEvidence,[{draft:'d',commit:old,ids:['§b/top']}]);assert.equal(metadata(r).evidence.length,2);
});

test('draft preview preserves incomplete sibling-draft inventory and diagnostics',t=>{
  const r=fixture(t,{gitRepo:true});assert.equal(evidence(r,['--commit','HEAD']).exit,0);write(r,'.sova/spec/drafts/broken/draft.json','{broken');const before=current(r);
  const j=promote(r);assert.equal(j.complete,false);assert.equal(j.draftScan.complete,false);assert.ok(j.draftScan.unread.some(x=>x.draft==='broken'));
  assert.ok(codes(j).includes('landing-draft-unread'));assert.deepEqual(current(r),before);assert.equal(metadata(r).promotions.length,0);
});

test('unused configured Git filters do not block draft inspection and never execute',t=>{
  const r=fixture(t,{gitRepo:true});assert.equal(evidence(r,['--commit','HEAD']).exit,0);const marker=join(r,'UNUSED-FILTER-RAN');
  for(const driver of ['unused','unspecified'])for(const kind of ['clean','process'])git(r,'config',`filter.${driver}.${kind}`,`touch ${marker}`);
  for(const args of [['check','d'],['promote','d','--id','§a/top']]){const j=run(r,args);assert.equal(j.exit,0,JSON.stringify(j));assert.equal(fs.existsSync(marker),false);}
});

for(const driver of ['fixture','set','unset','unspecified'])for(const kind of ['clean','process'])test(`draft inspection refuses selected Git ${driver} ${kind} filter without execution`,t=>{
  const r=fixture(t,{gitRepo:true});assert.equal(evidence(r,['--commit','HEAD']).exit,0);
  write(r,'.gitattributes',`src/a.txt filter=${driver}\n`);git(r,'add','.gitattributes');git(r,'commit','-qm','attributes');
  const marker=join(r,'FILTER-RAN'),filter=join(r,'filter.mjs');fs.writeFileSync(filter,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'ran');process.stdout.write(fs.readFileSync(0));`);
  git(r,'config',`filter.${driver}.${kind}`,`${process.execPath} ${filter}`);write(r,'src/a.txt','dirty\n');
  for(const args of [['check','d'],['promote','d','--id','§a/top']]) {
    const j=run(r,args);assert.ok(codes(j).includes('git-filter-refused'),JSON.stringify(j));assert.equal(fs.existsSync(marker),false,'no configured project command ran');
  }
});
