import {randomUUID} from 'crypto';
import type {LlmRequest,LlmResult,ProviderClient,ProviderMessage,ToolCallRequest} from './types.js';
import {toolSpecToOpenAi} from './types.js';

export function ollamaHost(value=process.env.OLLAMA_HOST??'http://127.0.0.1:11434'):string {
    let raw=value.trim();if(raw.startsWith(':'))raw='localhost'+raw;
    if(!/^https?:\/\//i.test(raw)) raw='http://'+raw;
    let url:URL;try{url=new URL(raw);}catch{throw new Error('Invalid Ollama host; use http://localhost:11434');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Ollama host must be an HTTP(S) URL without embedded credentials');
    if(url.hostname==='0.0.0.0'||url.hostname==='*')url.hostname='127.0.0.1';
    if(url.hostname==='[::]')url.hostname='[::1]';
    url.pathname=url.pathname.replace(/\/(?:v1|api)\/?$/,'').replace(/\/$/,'');url.search='';url.hash='';
    return url.toString().replace(/\/$/,'');
}
export interface OllamaDiscovery {base:string;models:string[]}
export async function discoverOllama(host?:string,signal?:AbortSignal):Promise<OllamaDiscovery> {
    const base=ollamaHost(host);
    try {
        const response=await fetch(base+'/api/tags',{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000)});
        if(!response.ok)throw new Error(`HTTP ${response.status}`);
        const data=await response.json() as {models?:Array<{name?:string;model?:string}>};
        if(!Array.isArray(data.models)) throw new Error('Unexpected model list');
        return {base,models:[...new Set(data.models.map(model=>model.name??model.model).filter((name):name is string=>typeof name==='string'))]};
    }catch(error){if(signal?.aborted)throw error;throw new Error(`Cannot connect to Ollama at ${base}: ${(error as Error).message}. Start Ollama or run ollama serve; check OLLAMA_HOST.`);}
}
function preferred(models:string[]):string {
    const score=(name:string)=>(/cloud/i.test(name)?-100:0)+(/coder|code/i.test(name)?50:/qwen3\.5/i.test(name)?40:/qwen/i.test(name)?30:0)-(/[:_-]0\.\d+b/i.test(name)?20:0);
    return [...models].sort((a,b)=>score(b)-score(a))[0];
}
function wireMessages(messages:ProviderMessage[]) {
    return messages.map(message=>message.role==='tool'?{role:'tool',tool_name:message.name,content:message.content}:{role:message.role,content:message.content,...(message.toolCalls?.length?{tool_calls:message.toolCalls.map(call=>({function:{name:call.name,arguments:JSON.parse(call.args)}}))}:{})});
}
export function nativeOllamaClient(options:{host?:string;model?:string}={}):ProviderClient {
    let models:string[]=[];let selected=options.model??'';let ready:Promise<void>|null=null;let base=ollamaHost(options.host);let nativeTools=true;let thinking=false;
    const initialize=async()=>{
        if(!ready)ready=(async()=>{
            const discovery=await discoverOllama(options.host);base=discovery.base;models=discovery.models;
            if(!models.length)throw new Error(`Ollama is reachable at ${base}, but no models are installed. Install a model with ollama pull <model>.`);
            if(selected&&!models.includes(selected)) {
                if(models.includes(selected+':latest')) selected+=':latest';
                else throw new Error(`Ollama model "${selected}" is not installed. Available: ${models.join(', ')}`);
            }
            if(!selected)selected=preferred(models);
            let response:Response|undefined;
            try {response=await fetch(base+'/api/show',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:selected}),signal:AbortSignal.timeout(5000)});}catch{/* Capability metadata is optional on older servers. */}
            if(response?.ok) {const info=await response.json() as {capabilities?:string[]};if(info.capabilities){nativeTools=info.capabilities.includes('tools');thinking=info.capabilities.includes('thinking');}}
            else if(response) {
                const detail=(await response.text()).slice(0,1000);
                if(/no such file|read GGUF metadata|model .*not found/i.test(detail))throw new Error(`Ollama model "${selected}" is listed but its model files are missing or incomplete. Repair it with: ollama pull ${selected}`);
                if(response.status!==404)throw new Error(`Ollama cannot inspect model "${selected}" (HTTP ${response.status}): ${detail.slice(0,250)}`);
            }
        })().catch(error=>{ready=null;throw error;});
        await ready;
    };
    const perform=async(req:LlmRequest,stream:boolean,onDelta:(text:string|null,record:unknown)=>void):Promise<LlmResult>=>{
        await initialize();req.signal?.throwIfAborted();
        const headers={'content-type':'application/json'};
        const system=!nativeTools&&req.tools?.length?req.system+'\nUse {"action":{"tool":"name","args":{}}} to execute tools or {"done":true,"summary":"answer"} when finished. Tool schemas: '+JSON.stringify(req.tools.map(tool=>({name:tool.name,description:tool.description,parameters:tool.parameters}))):req.system;
        const payload={model:selected,messages:[...(system?[{role:'system',content:system}]:[]),...(nativeTools?wireMessages(req.messages.filter(message=>message.role!=='system')):req.messages.filter(message=>message.role!=='system').map(message=>({role:message.role==='tool'?'user':message.role,content:message.role==='tool'?`Tool ${message.name} result:\n${message.content}`:message.content+(message.toolCalls?.length?`\nActions: ${JSON.stringify(message.toolCalls)}`:'')})))],stream,options:{num_predict:req.maxTokens??2200,temperature:req.temperature??0.1},...(thinking?{think:false}:{}),...(nativeTools&&req.tools?.length?{tools:toolSpecToOpenAi(req.tools)}:{})};
        let response:Response;
        try {response=await fetch(base+'/api/chat',{method:'POST',headers,body:JSON.stringify(payload),signal:req.signal?AbortSignal.any([req.signal,AbortSignal.timeout(180000)]):AbortSignal.timeout(180000)});}
        catch(error){if(req.signal?.aborted)throw error;throw new Error(`Ollama request failed at ${base}: ${(error as Error).message}`);}
        if(!response.ok){const detail=(await response.text()).slice(0,500);if(nativeTools&&req.tools?.length&&/does not support tools/i.test(detail)){nativeTools=false;return perform(req,stream,onDelta);}throw new Error(`Ollama HTTP ${response.status}: ${detail}`);}
        let text='';let usage:LlmResult['usage'];let done=false;const calls=new Map<string,ToolCallRequest>();
        const consume=(record:any)=>{
            if(record.error)throw new Error(`Ollama: ${String(record.error)}`);
            if(typeof record.message?.content==='string'){text+=record.message.content;if(stream&&record.message.content)onDelta(record.message.content,null);}
            for(const [index,call] of (record.message?.tool_calls??[]).entries()) {
                if(typeof call.function?.name!=='string')continue;
                const key=String(call.id??call.function.index??index);
                calls.set(key,{id:call.id??calls.get(key)?.id??randomUUID(),name:call.function.name,args:typeof call.function.arguments==='string'?call.function.arguments:JSON.stringify(call.function.arguments??{})});
            }
            if(record.done){done=true;if(typeof record.prompt_eval_count==='number'&&typeof record.eval_count==='number')usage={input:record.prompt_eval_count,output:record.eval_count};}
        };
        if(!stream)consume(await response.json());
        else {
            if(!response.body)throw new Error('Ollama returned no response stream');
            const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
            try {
                while(true){const chunk=await reader.read();buffer+=chunk.done?decoder.decode():decoder.decode(chunk.value,{stream:true});let end=buffer.indexOf('\n');while(end!==-1){const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);if(line)consume(JSON.parse(line));end=buffer.indexOf('\n');}if(chunk.done)break;}
                if(buffer.trim())consume(JSON.parse(buffer));
            }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
        }
        if(!done)throw new Error('Ollama stream ended before completion; the response is incomplete');
        onDelta(null,'done');return {text,toolCalls:[...calls.values()],usage};
    };
    return {name:'ollama',streaming:true,get toolProtocol(){return nativeTools?'native':'text';},get models(){return models;},defaultModel:()=>selected||'auto (installed model)',hasKey:()=>true,initialize,complete:req=>perform(req,false,()=>{}),stream:(req,onDelta)=>perform(req,true,onDelta)};
}
