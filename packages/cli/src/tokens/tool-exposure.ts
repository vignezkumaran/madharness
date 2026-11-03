import type {Tool} from '../tools/types.js';
const deferred=new WeakSet<Tool>();
const discovered=new WeakMap<Tool,number>();
let sequence=0;
/** MAD-specific on-demand schema budgeting; runtime tools remain registered. */
export function registerExposure(tool:Tool):void {if(tool.spec.exposure==='deferred')deferred.add(tool);}
export function exposeTool(tool:Tool):void {
    if(!deferred.has(tool))return;
    discovered.set(tool,++sequence);
    tool.spec={...tool.spec,exposure:'direct'};
}
export function visibleTools(tools:Tool[],maxDiscovered=5,charBudget=6000):Tool[] {
    const direct=tools.filter(tool=>!deferred.has(tool)&&tool.spec.exposure==='direct');
    const candidates=tools.filter(tool=>deferred.has(tool)&&discovered.has(tool)).sort((a,b)=>discovered.get(b)!-discovered.get(a)!);
    let chars=0;const selected:Tool[]=[];
    for(const tool of candidates) {
        if(selected.length>=maxDiscovered)break;
        const size=JSON.stringify(tool.spec.parameters).length+tool.spec.name.length+tool.spec.description.length;
        if(selected.length&&chars+size>charBudget)continue;
        selected.push(tool);chars+=size;
    }
    return [...direct,...selected];
}
export function resetExposure(tools:Tool[]):void {
    for(const tool of tools)if(deferred.has(tool)){discovered.delete(tool);tool.spec={...tool.spec,exposure:'deferred'};}
}
export function undiscoveredTools(tools:Tool[]):Tool[] {
    const visible=new Set(visibleTools(tools));
    return tools.filter(tool=>deferred.has(tool)&&!visible.has(tool));
}
