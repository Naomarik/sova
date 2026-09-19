// Opt-in end-to-end tool wiring (no parent model request).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { jiti } from '../../subagents/tests/runtime.mjs';
if (!process.argv.includes('--live')) throw Error('Pass --live to authorize real Claude requests.');
const { registerSubagents } = await jiti.import(new URL('../../subagents/index.ts',import.meta.url).pathname);
const { registerClaudeCode } = await jiti.import(new URL('../index.ts',import.meta.url).pathname);
const tools=new Map(),hooks=new Map(),listeners=new Map();
const pi={events:{on(name,fn){const s=listeners.get(name)??new Set();s.add(fn);listeners.set(name,s);return()=>s.delete(fn)},emit(name,data){for(const fn of listeners.get(name)??[])fn(data)}},registerTool(t){tools.set(t.name,t)},registerCommand(){},registerShortcut(){},on(name,fn){const list=hooks.get(name)??[];list.push(fn);hooks.set(name,list)},appendEntry(){},getActiveTools(){return[]},sendMessage(){}};
const ctx={cwd:mkdtempSync(path.join(tmpdir(),'pi-claude-manager-')),mode:'print',hasUI:false,sessionManager:{getEntries(){return[]}},modelRegistry:{find(){throw Error('Claude must not consult Pi registry')}}};
registerClaudeCode(pi);registerSubagents(pi);
const call=(name,args={})=>tools.get(name).execute('live',args,undefined,()=>{},ctx);
try{
 for(const fn of hooks.get('session_start')??[])await fn({},ctx);
 const spawned=await call('agent_spawn',{backend:'claude-code',name:'wired',tools:[],effort:'low',wake:false,prompt:'Reply only WIRED.',backendOptions:{maxBudgetUsd:1}});
 const id=spawned.details.spawned[0].id;
 assert.equal(spawned.details.spawned[0].backend,'claude-code');
 await call('agent_wait',{ids:[id],timeoutSeconds:90});
 const listed=await call('agent_list');assert.equal(listed.details.agents[0].taskOutcome,'success');
 const transcript=await call('agent_transcript',{id});assert.match(transcript.content[0].text,/WIRED/);
 await call('agent_kill',{id});
 assert.equal((await call('agent_list')).details.agents[0].processAlive,false);
 console.log('PASS: real Claude through registered agent_spawn/wait/list/transcript/kill tools.');
}finally{for(const fn of hooks.get('session_shutdown')??[])await fn({},ctx);}
