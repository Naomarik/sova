import { spawn } from "node:child_process";
import fs from "node:fs";
const mode=process.argv[2]; // "replace" | "append"
const sp=fs.readFileSync("/tmp/bigsp.txt","utf8");
const flag = mode==="replace" ? ["--system-prompt",sp] : ["--append-system-prompt",sp];
const p=spawn("/home/user/.local/bin/claude",["-p","--input-format","stream-json","--output-format","stream-json","--verbose",
 "--model","haiku",...flag,"--setting-sources","","--strict-mcp-config","--tools","",
 "--permission-mode","manual","--permission-prompts","none","--no-session-persistence"],
 {cwd:"/tmp",stdio:["pipe","pipe","pipe"]});
const w=(t)=>p.stdin.write(JSON.stringify({type:"user",message:{role:"user",content:[{type:"text",text:t}]}})+"\n");
const prompts=["Reply with just: one","Reply with just: two","Reply with just: three"];
let buf="",turn=0;
p.stderr.on("data",d=>console.log("STDERR",String(d).slice(0,200)));
p.stdout.on("data",d=>{buf+=d;let i;while((i=buf.indexOf("\n"))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);if(!l.trim())continue;
 let e;try{e=JSON.parse(l)}catch{continue}
 if(e.type==="result"){const u=e.usage;turn++;
  console.log(`${mode} TURN ${turn}: input=${u.input_tokens} cache_creation=${u.cache_creation_input_tokens} cache_read=${u.cache_read_input_tokens} out=${u.output_tokens} cost=${e.total_cost_usd}`);
  if(turn<prompts.length)w(prompts[turn]); else p.stdin.end();}
}});
p.on("close",()=>process.exit(0));
w(prompts[0]);
