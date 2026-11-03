import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ollamaHost,discoverOllama,nativeOllamaClient} from '../src/providers/ollama-native.js';

test('Ollama host normalization accepts bare hosts and avoids doubled API prefixes',()=>{
 for(const value of ['localhost:11434','http://localhost:11434/','http://localhost:11434/v1/','http://localhost:11434/api'])assert.equal(ollamaHost(value),'http://localhost:11434');
 assert.equal(ollamaHost('0.0.0.0:11434'),'http://127.0.0.1:11434');assert.equal(ollamaHost('http://[::]:11434'),'http://[::1]:11434');
});
test('Ollama discovers installed models, streams NDJSON and records native usage counts',async()=>{
 const previous=globalThis.fetch;const requests:Array<{url:string;payload:any}>=[];
 globalThis.fetch=async(url,init)=>{
   const address=String(url);const payload=init?.body?JSON.parse(String(init.body)):undefined;requests.push({url:address,payload});
   if(address.endsWith('/api/tags'))return Response.json({models:[{name:'missing-default-is-not-advertised'},{name:'qwen3.5:9b'},{name:'qwen3:0.6b'}]});
   if(address.endsWith('/api/show'))return Response.json({capabilities:['completion','tools','thinking']});
   return new Response([JSON.stringify({message:{role:'assistant',content:'First\n'},done:false}),JSON.stringify({message:{content:'Second'},done:true,prompt_eval_count:15,eval_count:4})].join('\n')+'\n');
 };
 try {
   const client=nativeOllamaClient({host:'localhost:11434/v1'});await client.initialize!();assert.equal(client.defaultModel(),'qwen3.5:9b');
   const chunks:string[]=[];const result=await client.stream({system:'Brief answer.',messages:[{role:'user',content:'test'}],maxTokens:20},text=>{if(text)chunks.push(text);});
   assert.equal(chunks.join(''),'First\nSecond');assert.deepEqual(result.usage,{input:15,output:4});
   const chat=requests.find(request=>request.url.endsWith('/api/chat'))!;assert.equal(chat.payload.think,false);assert.equal(chat.payload.options.num_predict,20);assert.ok(!requests.some(request=>request.url.includes('/v1/v1')));
   await client.initialize!();assert.equal(requests.filter(request=>request.url.endsWith('/api/tags')).length,1);
 }finally{globalThis.fetch=previous;}
});
test('Ollama reports an absent model before attempting inference',async()=>{
 const previous=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({models:[{name:'qwen3.5:9b'}]});};
 try{await assert.rejects(nativeOllamaClient({host:'localhost:11434',model:'llama3.2'}).initialize!(),/not installed.*qwen3.5:9b/);assert.equal(calls,1);}finally{globalThis.fetch=previous;}
});
test('Ollama server errors name the endpoint and recovery action',async()=>{
 const previous=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('ECONNREFUSED');};
 try{await assert.rejects(discoverOllama('localhost:11434'),/Cannot connect to Ollama.*ollama serve/);}finally{globalThis.fetch=previous;}
});
test('Ollama native tool calls and tool results retain names and JSON arguments',async()=>{
 const previous=globalThis.fetch;const bodies:any[]=[];
 globalThis.fetch=async(url,init)=>{
   if(String(url).endsWith('/api/tags'))return Response.json({models:[{name:'coder'}]});
   if(String(url).endsWith('/api/show'))return Response.json({capabilities:['tools']});
   bodies.push(JSON.parse(String(init!.body)));return new Response(JSON.stringify({message:{tool_calls:[{function:{name:'write_file',arguments:{path:'file.txt',content:'test'}}}]},done:true,prompt_eval_count:20,eval_count:5})+'\n');
 };
 try {
   const client=nativeOllamaClient({host:'localhost:11434',model:'coder'});
   const result=await client.stream({system:'Act.',messages:[{role:'assistant',content:'',toolCalls:[{id:'previous',name:'read_file',args:'{"path":"file.txt"}'}]},{role:'tool',name:'read_file',callId:'previous',content:'old text'}]},()=>{});
   assert.equal(result.toolCalls[0].name,'write_file');assert.deepEqual(JSON.parse(result.toolCalls[0].args),{path:'file.txt',content:'test'});assert.equal(bodies[0].messages.at(-1).tool_name,'read_file');
 }finally{globalThis.fetch=previous;}
});
test('models without native tools receive the text action protocol instead of an unsupported tools payload',async()=>{
 const previous=globalThis.fetch;let body:any;
 globalThis.fetch=async(url,init)=>{
   if(String(url).endsWith('/api/tags'))return Response.json({models:[{name:'plain'}]});
   if(String(url).endsWith('/api/show'))return Response.json({capabilities:['completion']});
   body=JSON.parse(String(init!.body));return new Response(JSON.stringify({message:{content:'{"done":true,"summary":"ok"}'},done:true,prompt_eval_count:20,eval_count:5})+'\n');
 };
 try{const client=nativeOllamaClient({host:'localhost:11434'});await client.initialize!();assert.equal(client.toolProtocol,'text');await client.stream({system:'Act.',messages:[],tools:[{name:'read_file',description:'Read',parameters:{type:'object',properties:{}},exposure:'direct',readOnly:true,mutates:false}]},()=>{});assert.equal(body.tools,undefined);assert.match(body.messages[0].content,/action/);}finally{globalThis.fetch=previous;}
});
