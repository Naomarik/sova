import { spawn } from "node:child_process";
const args=["-p","--input-format","stream-json","--output-format","stream-json","--verbose",
 "--model","haiku","--system-prompt","You are a tool-using assistant.",
 "--setting-sources","","--strict-mcp-config","--tools","",
 "--permission-mode","manual","--permission-prompts","none","--allowedTools","mcp__pi","--no-session-persistence"];
const p=spawn("/home/user/.local/bin/claude",args,{cwd:"/tmp",stdio:["pipe","pipe","pipe"]});
const w=(o)=>p.stdin.write(JSON.stringify(o)+"\n");
let buf="",initDone=false;
p.stderr.on("data",d=>console.log("STDERR:",String(d).slice(0,300)));
// 1. handshake: declare an in-process ("sdk") MCP server named "pi"
w({type:"control_request",request_id:"init-1",request:{subtype:"initialize",sdkMcpServers:["pi"]}});
p.stdout.on("data",d=>{buf+=d;let i;while((i=buf.indexOf("\n"))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);if(!l.trim())continue;
 let e;try{e=JSON.parse(l)}catch{console.log("NONJSON:",l.slice(0,160));continue}
 if(e.type==="control_response"){
   const r=e.response;
   if(r.request_id==="init-1"){console.log("INIT RESPONSE subtype=",r.subtype,"keys=",Object.keys(r.response||{}),"\n  commands?",Array.isArray(r.response?.commands)&&r.response.commands.length,"models?",JSON.stringify((r.response?.models||[]).map(m=>({v:m.value,rm:m.resolvedModel,eff:m.supportedEffortLevels,adapt:m.supportsAdaptiveThinking}))));
     initDone=true;
     w({type:"user",message:{role:"user",content:[{type:"text",text:'Call the pi_secret tool with key "gamma" and report exactly what it returned.'}]}});
   } else console.log("CTRL RESP",JSON.stringify(e).slice(0,200));
 }
 else if(e.type==="control_request"){
   const rq=e.request;
   if(rq.subtype==="mcp_message"){
     const m=rq.message;
     console.log("CLI->HOST mcp_message server=",rq.server_name,"method=",m.method,"id=",m.id);
     let result;
     if(m.method==="initialize")result={protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"pi",version:"1.0"}};
     else if(m.method==="tools/list")result={tools:[{name:"pi_secret",description:"Returns the secret word for a key.",inputSchema:{type:"object",properties:{key:{type:"string"}},required:["key"]}}]};
     else if(m.method==="tools/call"){console.log("  *** HOST EXECUTED TOOL:",JSON.stringify(m.params));result={content:[{type:"text",text:"kiwi-"+(m.params.arguments?.key??"?")}]};}
     else result={};
     const resp=m.id===undefined?undefined:{jsonrpc:"2.0",id:m.id,result};
     w({type:"control_response",response:{subtype:"success",request_id:e.request_id,response:resp?{mcp_response:resp}:{}}});
   } else {console.log("CLI->HOST ctrl",rq.subtype);w({type:"control_response",response:{subtype:"success",request_id:e.request_id,response:{}}});}
 }
 else if(e.type==="system"&&e.subtype==="init")console.log("SYS init tools=",JSON.stringify(e.tools));
 else if(e.type==="assistant"){for(const b of e.message.content||[]){if(b.type==="text")console.log("ASSISTANT:",b.text.slice(0,160));if(b.type==="tool_use")console.log("TOOL_USE:",b.name,JSON.stringify(b.input));}}
 else if(e.type==="user"){for(const b of (Array.isArray(e.message.content)?e.message.content:[]))if(b.type==="tool_result")console.log("TOOL_RESULT:",JSON.stringify(b.content).slice(0,160));}
 else if(e.type==="result"){console.log("RESULT",e.subtype,"is_error",e.is_error,"->",String(e.result).slice(0,160));p.stdin.end();}
}});
p.on("close",c=>console.log("CLOSE",c));
setTimeout(()=>{console.log("TIMEOUT");p.kill()},100000);
