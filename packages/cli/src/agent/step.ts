import {randomUUID} from 'crypto';
import type {Event} from '../protocol/types.js';
import type {LlmRequest,LlmResult,ProviderClient} from '../providers/types.js';
import {assistantTextStream} from '../providers/text-stream.js';
import {estimateTokens} from '../tokens/estimator.js';
import {parseAgentReply} from './protocol.js';

/** Shared sampling boundary for foreground turns and named/DAG workers. */
export async function sampleStep(options:{client:ProviderClient;request:LlmRequest;emit:(event:Event)=>void;streamId?:string;agent?:string}):Promise<LlmResult> {
    const streamId=options.streamId??randomUUID();
    const publish=(text:string|null)=>options.emit({kind:'delta',text,streamId,...(options.agent?{toolLabel:options.agent}:{})});
    publish(null);
    const reveal=assistantTextStream(publish);
    let result:LlmResult;
    try { result=await options.client.stream(options.request,text=>{if(text)reveal(text);}); }
    catch (error) {
        if (!options.request.signal?.aborted && (error as Error).name === 'TimeoutError')
            throw new Error(`${options.client.name} model ${options.client.defaultModel()} timed out. Try another model or provider.`);
        throw error;
    }
    options.request.signal?.throwIfAborted();
    if(!result.toolCalls.length) {
        const reply=parseAgentReply(result.text);
        if(reply.kind==='action'&&reply.action)result.toolCalls=[{id:randomUUID(),name:reply.action.tool,args:JSON.stringify(reply.action.args)}];
    }
    if(!result.usage)result.usage={input:estimateTokens(JSON.stringify({system:options.request.system,messages:options.request.messages,tools:options.request.tools})),output:estimateTokens(result.text),estimated:true};
    return result;
}
