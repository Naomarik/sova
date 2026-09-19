// Opt-in live test: real Claude requests, only sleep commands and a private scratch file.
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { jiti } from '../../subagents/tests/runtime.mjs';
if (!process.argv.includes('--live')) throw Error('Pass --live to authorize real Claude requests.');
const { ClaudeRunner } = await jiti.import(new URL('../runner.ts', import.meta.url).pathname);
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(test, label, ms=90000) { const end=Date.now()+ms;while(Date.now()<end){if(test())return;await delay(30)}throw Error(`${label} timed out`); }
const cwd=mkdtempSync(path.join(tmpdir(),'pi-claude-controls-'));
const base={id:'controls',groupId:'controls',name:'controls',cwd,model:'sonnet',effort:'low',maxBudgetUsd:1};
const events=[];
const callbacks={onChange(){},onExit(){},onSettled(r){events.push({outcome:r.taskOutcome,output:r.finalOutput(),settled:r.isSettled()})}};
const runner=new ClaudeRunner({...base,tools:['Bash'],allowedTools:['Bash(sleep *)'],task:'Run exactly `sleep 4` in Bash, not in background, then reply FIRST.'},callbacks);
try{
 await until(()=>runner.transcript.some(t=>t.kind==='tool'),'first tool');
 const queued=await runner.steer('Do not use tools. Reply only FOLLOWUP.',undefined,'followUp');assert.equal(queued.ok,true);
 await until(()=>runner.isSettled(),'host queue drain');assert.equal(runner.taskOutcome,'success',runner.error);assert.match(runner.finalOutput(),/FOLLOWUP/);
 assert.equal(events.length, 1, 'only the idle worker should notify after queue drain');
 assert.equal(events[0].outcome, 'success');
 assert.ok(runner.transcript.some(t => t.kind === 'tool' && t.text.includes('sleep 4')), 'first task history retained');
 const start=await runner.steer('Run exactly `sleep 20` in Bash, not in background, then reply FINISHED.');assert.equal(start.ok,true,start.reason);
 await until(()=>runner.transcript.some(t=>t.kind==='tool'&&t.text.includes('sleep 20')),'long tool');await delay(3500);
 const redirected=await runner.steer('Do not use tools. Reply only REDIRECTED.',undefined,'redirect');assert.equal(redirected.ok,true,redirected.reason);
 await until(()=>runner.isSettled(),'redirect result');assert.equal(runner.taskOutcome,'success',runner.error);assert.match(runner.finalOutput(),/REDIRECTED/);
 console.log('PASS: host follow-up queue, active interrupt/redirect, and post-interrupt reuse.');
}finally{await runner.dispose();}
const target=path.join(cwd,'denied.txt');let permissions=0;
const denied=new ClaudeRunner({...base,id:'denied',tools:['Write'],permissionMode:'manual',task:`Use Write to create ${target} containing TEST. If denied, do not retry.`,onPermission:async()=>{permissions++;return {behavior:'deny',message:'Denied by live test; do not retry.'}}},callbacks);
try{await until(()=>denied.isSettled(),'permission denial');assert.ok(permissions>0);assert.equal(existsSync(target),false);assert.ok(denied.permissionDenials.length);console.log('PASS: host permission denial prevents file mutation.');}finally{await denied.dispose();}
