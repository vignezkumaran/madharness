import {discoverOllama} from '../providers/ollama-native.js';
import { useEffect, useRef, useState } from 'react';
import { useApp } from 'ink';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { MadSession } from '../session/session.js';
import { loadConfig } from '../config/loader.js';
import { listSessions } from '../rollout/store.js';
import { listProviders, setKey, detectKey, clearKey, PROVIDERS, importOpenCodeModels, providerAvailable } from '../providers/manager.js';
import type { ProviderName } from '../providers/manager.js';
import type { AgentRole, ReviewDecision, Event, DagNodeInfo } from '../protocol/types.js';
import { distillSource } from '../agent/distill.js';
import { parseMcpAddInput, MCP_PRESETS } from '../mcp/presets.js';
export interface TranscriptEntry {
    id: string;
    kind: 'user' | 'assistant' | 'system' | 'error' | 'tool' | 'agent' | 'bus' | 'diff';
    title?: string;
    content: string;
    meta?: string;
    status?: 'ok' | 'error' | 'running';
    at: number;
}
export interface AgentView {
    id: string;
    role: AgentRole;
    title: string;
    status: string;
    provider?: string;
    tokens?: number;
    tools: string[];
    summary?: string;
    current?: string;
    startedAt?: number;
    endedAt?: number;
}
export type PickerStatus = 'active' | 'connected' | 'offline' | 'idle' | 'running' | 'done' | 'failed' | 'skipped';
export interface PickerItem {
    id: string;
    label: string;
    meta?: string;
    detail?: string;
    status?: PickerStatus;
    action: {
        type: 'provider' | 'model' | 'agent' | 'role' | 'permissions' | 'mcp';
        access?: 'ask' | 'full';
        provider?: string;
        model?: string;
        agentId?: string;
        role?: AgentRole;
        mcpServer?: string;
    };
}
export interface PickerState {
    kind: 'providers' | 'models' | 'agents' | 'permissions' | 'mcp';
    title: string;
    subtitle?: string;
    empty?: string;
    items: PickerItem[];
}
export interface DagView {
    stage: number;
    total: number;
    label: string;
    detail?: string;
    failed?: boolean;
    finished?: boolean;
}
export interface HarnessState {
    entries: TranscriptEntry[];
    agents: Record<string, AgentView>;
    agentOrder: string[];
    agentLog: string[];
    plan?: {
        tasks: DagNodeInfo[];
    };
    busy: boolean;
    turnActive: boolean;
    accessMode: 'ask' | 'full';
    phase: string;
    picker: PickerState | null;
    provider: ProviderName | null;
    model: string;
    awaitingProvider: ProviderName | null;
    awaitingKey: boolean;
    tokens: number;
    turnTokens: number;
    turnTokenBaseline: number;
    usageEstimated: boolean;
    providerUsage: Record<string, number>;
    streaming?: string;
    dag?: DagView;
    history: string[];
    cwd: string;
    branch: string;
    sessionStart: number;
    lastRunMs?: number;
    clearKey: number;
}
export type ApprovalView = Extract<Event, {
    kind: 'approval-requested';
}>;
const roles: AgentRole[] = ['architect', 'coder', 'verifier', 'debugger', 'planner', 'custom'];
export function useHarness(initialAccess?: 'ask' | 'full') {
    const { exit } = useApp();
    const sessionRef = useRef<MadSession>();
    if (!sessionRef.current) {
        sessionRef.current = new MadSession({ workspace: process.cwd(), config: loadConfig().config });
        if (initialAccess)
            sessionRef.current.setAccessMode(initialAccess);
    }
    const session = sessionRef.current;
    const [state, set] = useState<HarnessState>(() => ({ entries: [], agents: {}, agentOrder: [], agentLog: [], busy: false, turnActive: false, accessMode: session.accessMode(), phase: 'Ready', picker: null, provider: session.providerLabel() as ProviderName, model: session.sessionModel(), awaitingProvider: null, awaitingKey: false, tokens: 0, turnTokens: 0, turnTokenBaseline: 0, usageEstimated: false, providerUsage: {}, history: [], cwd: session.workspace, branch: '', sessionStart: Date.now(), clearKey: 0 }));
    const [approvals, setApprovals] = useState<ApprovalView[]>([]);
    const approval = approvals[0];
    const addSystem = (content: string, title = 'MAD') => set(s => ({ ...s, entries: [...s.entries, { id: crypto.randomUUID(), kind: 'system', content, title, at: Date.now() }] }));
    useEffect(() => {
        addSystem('Describe a task or ask a question. /agent <name> [role] creates an agent; /task <name> <task> assigns work; /mcp connects MCP servers (Jira, GitHub); /plan <task> plans; /run executes that plan. /permissions changes access mode. /resume lists saved sessions.');
        let pendingDelta = '';
        let deltaTimer: ReturnType<typeof setTimeout> | undefined;
        const clearDelta = () => {
            if (deltaTimer)
                clearTimeout(deltaTimer);
            deltaTimer = undefined;
            pendingDelta = '';
        };
        const unsubscribe = session.on(event => {
            if (event.kind === 'delta') {
                if(event.toolLabel) {
                    set(s=>{const id=`agent-stream:${event.streamId}`;const existing=s.entries.find(entry=>entry.id===id);const entries=s.entries.filter(entry=>entry.id!==id);if(event.text===null)return {...s,entries};return {...s,entries:[...entries,{id,kind:'assistant',title:event.toolLabel,content:(existing?.content??'')+(event.text??''),at:existing?.at??Date.now()}]};});
                    return;
                }
                if (event.text === null && !event.toolLabel) {
                    clearDelta();
                    set(s => ({ ...s, streaming: undefined, phase: 'Thinking · waiting for model' }));
                    return;
                }
                if (!event.toolLabel && event.text) {
                    pendingDelta += event.text;
                    if (!deltaTimer)
                        deltaTimer = setTimeout(() => { const text = pendingDelta; pendingDelta = ''; deltaTimer = undefined; set(s => ({ ...s, phase: 'Processing response', streaming: (s.streaming ?? '') + text })); }, 50);
                }
                return;
            }
            if ((event.kind === 'message-completed' && !event.agent) || event.kind === 'turn-ended')
                clearDelta();
            if (event.kind === 'approval-requested') {
                setApprovals(a => [...a, event]);
                return;
            }
            if (event.kind === 'approval-resolved') {
                setApprovals(a => a.filter(x => x.id !== event.id));
                return;
            }
            set(s => {
                const next = { ...s };
                const entry = (kind: TranscriptEntry['kind'], content: string, title?: string, status?: TranscriptEntry['status']) => { next.entries = [...next.entries, { id: crypto.randomUUID(), kind, content, title, status, at: Date.now() }]; };
                const log = (text: string) => { next.agentLog = [...next.agentLog, `[${new Date().toLocaleTimeString('en-GB')}] ${text}`].slice(-30); };
                switch (event.kind) {
                    case 'turn-started':
                        next.turnActive = true;
                        next.turnTokenBaseline = s.tokens;
                        next.turnTokens = 0;
                        next.usageEstimated = false;
                        next.phase = 'Preparing task';
                        break;
                    case 'turn-ended':
                        next.turnActive = false;
                        next.streaming = undefined;
                        next.phase = event.ok ? 'Ready' : 'Incomplete';
                        break;
                    case 'message-completed':
                        if(event.agent)next.entries=next.entries.filter(entry=>entry.id!==`agent-stream:${event.agent}`);
                        else next.streaming = undefined;
                        entry(event.agent ? 'agent' : 'assistant', event.text, event.agent);
                        break;
                    case 'error':
                        entry('error', event.message);
                        break;
                    case 'note':
                        next.provider = session.providerLabel() as ProviderName;
                        next.model = session.sessionModel();
                        entry('system', event.text);
                        break;
                    case 'activity':
                        next.phase = event.phase;
                        break;
                    case 'tool-started':
                        if (event.agent) {
                            const agent = next.agents[event.agent];
                            if (agent) next.agents = { ...next.agents, [event.agent]: { ...agent, current: event.brief } };
                            log(`${event.agent}: ${event.brief}`);
                        } else next.phase = `Tool calling · ${event.tool}: ${event.brief}`;
                        entry('tool', event.brief, event.agent ? `${event.agent} · ${event.tool}` : event.tool, 'running');
                        break;
                    case 'tool-completed': {
                        const title = event.agent ? `${event.agent} · ${event.tool}` : event.tool;
                        const content = `${event.brief}${event.detail ? '\n' + event.detail : ''}`;
                        const status = event.ok ? 'ok' : 'error';
                        const pending = [...next.entries].reverse().find(item => item.kind === 'tool' && item.title === title && item.content === event.brief && item.status === 'running');
                        if (!pending) entry('tool', content, title, status);
                        else next.entries = next.entries.map(item => item === pending ? { ...item, content, status } : item);
                        if (event.agent) {
                            const agent = next.agents[event.agent];
                            if (agent) next.agents = { ...next.agents, [event.agent]: { ...agent, current: event.ok ? 'Thinking about result' : 'Tool failed' } };
                            log(`${event.agent}: ${event.ok ? 'finished' : 'failed'} ${event.brief}`);
                        } else next.phase = 'Processing tool result';
                        break;
                    }
                    case 'compacted':
                        entry('system', event.summary, 'Compacted');
                        break;
                    case 'token-usage':
                        next.model = session.sessionModel();
                        next.tokens = event.input + event.output;
                        next.turnTokens = next.tokens - next.turnTokenBaseline;
                        next.usageEstimated = event.estimated ?? false;
                        break;
                    case 'agent-spawned':
                        entry('system', `Created ${event.name} (${event.role}). Assign work with /task ${event.name} <task>.`);
                        next.agents = { ...next.agents, [event.name]: { id: event.name, role: event.role, title: event.name, status: 'idle', tools: [] } };
                        next.agentOrder = [...new Set([...next.agentOrder, event.name])];
                        break;
                    case 'agent-status': {
                        entry('system', event.detail ?? event.status, `${event.name} · ${event.status}`);
                        log(`${event.name} · ${event.status}`);
                        if (!next.turnActive && event.status === 'working') next.phase = `Thinking · ${event.name}`;
                        const agent = next.agents[event.name];
                        if (agent)
                            next.agents = { ...next.agents, [event.name]: { ...agent, status: event.status === 'working' ? 'running' : event.status === 'blocked' ? 'failed' : event.status, summary: event.detail, current: event.status === 'working' ? event.detail : undefined } };
                        break;
                    }
                    case 'agent-communication':
                        log(`${event.from} → ${event.to}: ${event.text}`);
                        entry('bus', `${event.from} → ${event.to}: ${event.text}`, 'Agent handoff');
                        break;
                    case 'dag-created':
                        next.plan = { tasks: event.nodes };
                        next.dag = { stage: 0, total: event.nodes.length, label: event.goal };
                        break;
                    case 'dag-node': {
                        const tasks = (next.plan?.tasks ?? []).filter(n => n.id !== event.node.id).concat(event.node);
                        next.plan = { tasks };
                        next.dag = { stage: tasks.filter(n => ['complete', 'repaired'].includes(n.status)).length, total: tasks.length, label: event.node.title };
                        break;
                    }
                    case 'dag-finished':
                        entry('agent', event.summary, event.ok ? 'Workflow complete' : 'Workflow incomplete', event.ok ? 'ok' : 'error');
                        if (next.dag)
                            next.dag = { ...next.dag, label: event.summary, failed: !event.ok, finished: true };
                        break;
                }
                next.busy = next.turnActive || Object.values(next.agents).some(agent => agent.status === 'running');
                return next;
            });
        });
        return () => { clearDelta(); unsubscribe(); void session.close(); };
    }, [session]);
    const cancel = () => { session.cancel(); setApprovals([]); };
    const inspectAgent = (id:string)=>{const agent=session.agentManager().list().find(a=>a.name===id);addSystem(agent?`${agent.name} · ${agent.role} · ${agent.status}\n${agent.model?`Model: ${agent.model}\n`:''}${agent.taskQueue.length?`Task: ${agent.taskQueue.join('\n')}\n`:''}${agent.detail??'No output yet.'}`:'Agent not found.','Agent details');};
    const inspectRole = (role: AgentRole) => addSystem(`${role}: create with /agent <name> ${role}`);
    const closePicker = () => set(s => ({ ...s, picker: null }));
    const selectPicker = async (item: PickerItem) => {
        closePicker();
        try {
            if (item.action.type === 'permissions' && item.action.access) {
                session.setAccessMode(item.action.access);
                set(s => ({ ...s, accessMode: session.accessMode() }));
            }
            else if (item.action.agentId)
                inspectAgent(item.action.agentId);
            else if (item.action.provider) {
                const prov = item.action.provider as ProviderName;
                if (!providerAvailable(prov)) {
                    set(s => ({ ...s, awaitingProvider: prov, awaitingKey: true }));
                    addSystem(`Paste your ${PROVIDERS.meta[prov]?.label ?? prov} API key below:`, `${PROVIDERS.meta[prov]?.label ?? prov} Login`);
                    return;
                }
                await session.selectProvider(item.action.provider, item.action.model);
                set(s => ({ ...s, provider: item.action.provider as ProviderName, model: session.sessionModel() }));
            }
            else if (item.action.role)
                inspectRole(item.action.role);
            else if (item.action.type === 'mcp' && item.action.mcpServer) {
                const serverName = item.action.mcpServer;
                const tools = await session.listMcpTools(serverName);
                const serverInfo = session.listMcpServers().find(s => s.name === serverName);
                const toolList = tools.map(t => `  • ${t.tool.name}: ${t.tool.description ?? 'No description'}`).join('\n') || '  No tools reported.';
                addSystem(`MCP Server: ${serverName}\nStatus: ${serverInfo?.connected ? 'connected' : 'offline'}\nCommand: ${serverInfo?.config.command} ${(serverInfo?.config.args ?? []).join(' ')}\n\nTools (${tools.length}):\n${toolList}\n\nTo remove: /mcp remove ${serverName}`, `MCP: ${serverName}`);
            }
        }
        catch (error) {
            addSystem((error as Error).message, 'Error');
        }
    };
    const submit = async (raw: string) => {
        const input = raw.trim();
        if (!input)
            return;
        try {
            if (state.awaitingKey || state.awaitingProvider) {
                if (input === '/cancel') {
                    set(s => ({ ...s, awaitingKey: false, awaitingProvider: null }));
                    return;
                }
                const provider = state.awaitingProvider ?? detectKey(input);
                if (!provider)
                    throw new Error('Could not detect provider; use /login <provider>.');
                setKey(provider,input);
                await session.selectProvider(provider);
                set(s=>({...s,provider,model:session.sessionModel(),awaitingKey:false,awaitingProvider:null}));
                addSystem(`Connected ${PROVIDERS.meta[provider]?.label ?? provider}. Model: ${session.sessionModel()}`);
                return;
            }
            const detectedDirect = detectKey(input);
            if (!input.startsWith('/') && detectedDirect && (!input.includes(' ') || input.startsWith('sk-or-') || input.startsWith('sk-ant-') || input.startsWith('gsk_'))) {
                setKey(detectedDirect, input);
                await session.selectProvider(detectedDirect);
                set(s => ({ ...s, provider: detectedDirect, model: session.sessionModel(), awaitingKey: false, awaitingProvider: null }));
                addSystem(`Connected ${PROVIDERS.meta[detectedDirect]?.label ?? detectedDirect} from pasted token. Model: ${session.sessionModel()}`, 'Provider Connected');
                return;
            }
            set(s => ({ ...s, history: [...s.history, input].slice(-200) }));
            if (!input.startsWith('/')) {
                set(s => ({ ...s, entries: [...s.entries, { id: crypto.randomUUID(), kind: 'user', content: input, at: Date.now() }] }));
                session.submit({ kind: 'user-message', text: input, workspace: session.workspace, mode: 'agent' });
                return;
            }
            const [cmd, ...args] = input.slice(1).split(/\s+/);
            const rest = args.join(' ');
            switch (cmd) {
                case 'exit':
                    await session.close();
                    exit();
                    break;
                case 'permissions': {
                    if (rest === 'clear') {
                        session.clearPermissions();
                        addSystem('Saved permission rules cleared.');
                        break;
                    }
                    if (rest === 'ask' || rest === 'full') {
                        session.setAccessMode(rest);
                        set(s => ({ ...s, accessMode: session.accessMode() }));
                        break;
                    }
                    if (rest)
                        throw new Error('Usage: /permissions [ask|full|clear]');
                    set(s => ({ ...s, picker: { kind: 'permissions', title: 'Permissions', subtitle: `Current: ${session.accessMode() === 'full' ? 'Full access' : 'Ask permission'}`, items: [
                                { id: 'ask', label: 'Ask permission', detail: 'Ask before writes, shell commands and MCP actions. File tools stay inside the workspace.', status: session.accessMode() === 'ask' ? 'active' : 'idle', action: { type: 'permissions', access: 'ask' } },
                                { id: 'full', label: 'Full access', detail: 'Run tool actions without approval and allow file paths outside the workspace, for this session.', status: session.accessMode() === 'full' ? 'active' : 'idle', action: { type: 'permissions', access: 'full' } }
                            ] } }));
                    break;
                }
                case 'cwd': {
                    if (!rest) {
                        addSystem(session.workspace);
                        break;
                    }
                    if (session.isBusy() || session.agentManager().list().some(a => a.status === 'working'))
                        throw new Error('Stop active work before switching workspace.');
                    const target = path.resolve(session.workspace, rest);
                    if (!fs.statSync(target).isDirectory())
                        throw new Error('Expected a directory.');
                    await session.close();
                    sessionRef.current = new MadSession({ workspace: target, config: loadConfig({}, target).config });
                    set(s => ({ ...s, cwd: target, agents: {}, agentOrder: [], plan: undefined, dag: undefined }));
                    break;
                }
                case 'help':
                    addSystem('/agent <name> [role] · /task <name> <task> · /mcp [add|list|tools|remove] · /agents [name] · /stop <name> · /plan <task> · /run · /permissions · /dag · /resume [id] · /compact · /clear · /providers · /models · /model <provider> [model] · /login [provider] · /logout <provider> · /status · /diff · /distill <file> · /cancel');
                    break;
                case 'mcp': {
                    const [subcmd, ...subargs] = args;
                    const sub = (subcmd || '').toLowerCase();
                    if (!sub || sub === 'list' || sub === 'status') {
                        const servers = session.listMcpServers();
                        if (servers.length === 0) {
                            addSystem(
                                'No MCP servers configured yet.\n\n' +
                                'Connect services like GitHub, Jira, Git, or custom tools via MCP:\n\n' +
                                '  /mcp add github GITHUB_PERSONAL_ACCESS_TOKEN=<token>\n' +
                                '  /mcp add jira npx -y @atlassian/jira-mcp-server --env JIRA_URL=<url> --env JIRA_EMAIL=<email> --env JIRA_API_TOKEN=<token>\n' +
                                '  /mcp presets (view all copy-paste ready presets)\n' +
                                '  /mcp add <name> <command> [args...] [--env KEY=VAL]',
                                'MCP (Model Context Protocol)'
                            );
                            break;
                        }
                        const lines = servers.map(s => `  ${s.connected ? '●' : '○'} ${s.name}: ${s.config.command} ${(s.config.args ?? []).join(' ')} (${s.connected ? 'connected' : 'offline'} · ${s.toolsCount} tools)`);
                        addSystem(
                            `Configured MCP servers:\n${lines.join('\n')}\n\n` +
                            'Commands:\n' +
                            '  /mcp add <name> <cmd> [args...] [--env KEY=VAL]\n' +
                            '  /mcp tools [server]\n' +
                            '  /mcp remove <name>\n' +
                            '  /mcp presets',
                            'MCP Servers'
                        );
                        set(s => ({
                            ...s,
                            picker: {
                                kind: 'mcp',
                                title: 'MCP Servers',
                                subtitle: 'Select a server to view its tools and configuration.',
                                items: servers.map(srv => ({
                                    id: srv.name,
                                    label: srv.name,
                                    meta: `${srv.connected ? 'connected' : 'offline'} · ${srv.toolsCount} tools`,
                                    detail: `${srv.config.command} ${(srv.config.args ?? []).join(' ')}`,
                                    status: srv.connected ? 'connected' : 'offline',
                                    action: { type: 'mcp', mcpServer: srv.name }
                                }))
                            }
                        }));
                        break;
                    }
                    if (sub === 'presets') {
                        const presetList = Object.values(MCP_PRESETS).map(p =>
                            `• ${p.name.toUpperCase()}: ${p.description}\n  ${p.sampleCommand}${p.envHelp ? `\n  (${p.envHelp})` : ''}`
                        ).join('\n\n');
                        addSystem(`Available MCP presets:\n\n${presetList}`, 'MCP Presets');
                        break;
                    }
                    if (sub === 'tools') {
                        const targetServer = subargs[0];
                        const tools = await session.listMcpTools(targetServer);
                        if (tools.length === 0) {
                            addSystem(targetServer ? `No tools found for MCP server '${targetServer}'.` : 'No MCP tools discovered. Ensure servers are connected.', 'MCP Tools');
                            break;
                        }
                        const list = tools.map(t => `• [${t.server}] ${t.tool.name}: ${t.tool.description ?? 'No description'}`).join('\n');
                        addSystem(`Discovered MCP tools (${tools.length}):\n\n${list}`, 'MCP Tools');
                        break;
                    }
                    if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
                        const target = subargs[0];
                        if (!target) throw new Error('Usage: /mcp remove <server-name>');
                        await session.removeMcpServer(target);
                        addSystem(`Removed MCP server '${target}'.`, 'MCP');
                        break;
                    }
                    if (sub === 'add') {
                        if (subargs.length === 0) {
                            throw new Error('Usage: /mcp add <name> [command] [args...] [--env KEY=VAL]\nType /mcp presets to see examples.');
                        }
                        const parsed = parseMcpAddInput(subargs);
                        addSystem(`Connecting to MCP server '${parsed.name}'...`, 'MCP');
                        const result = await session.addMcpServer(parsed.name, {
                            command: parsed.command,
                            args: parsed.args,
                            env: parsed.env,
                            enabled: true
                        });
                        const toolSummary = result.tools.length > 0
                            ? `\nTools available (${result.toolsCount}): ${result.tools.slice(0, 8).join(', ')}${result.tools.length > 8 ? ` (+${result.tools.length - 8} more)` : ''}`
                            : '\n(No tools reported yet)';
                        addSystem(`Connected MCP server '${parsed.name}'.${toolSummary}\nSaved to project config.`, 'MCP Connected');
                        break;
                    }
                    throw new Error(`Unknown /mcp subcommand: ${sub}. Try: /mcp, /mcp add, /mcp remove, /mcp tools, /mcp presets.`);
                }
                case 'agent': {
                    const [name, role, ...task] = args;
                    if (!name)
                        throw new Error('Usage: /agent <name> [role] [task]');
                    if(!role&&session.agentManager().list().some(agent=>agent.name===name)) {inspectAgent(name);break;}
                    const selected = roles.includes(role as AgentRole) ? role as AgentRole : 'custom';
                    session.submit({ kind: 'spawn-agent', name, role: selected, task: (selected === 'custom' && role !== 'custom' ? args.slice(1) : task).join(' ') || undefined });
                    break;
                }
                case 'task':
                case 'message': {
                    if (!args[0] || args.length < 2)
                        throw new Error('Usage: /task <name> <task>');
                    session.submit({ kind: 'agent-task', name: args[0], task: args.slice(1).join(' ') });
                    break;
                }
                case 'stop':
                    session.submit({ kind: 'stop-agent', name: rest });
                    break;
                case 'agents': {
                    if(rest) {inspectAgent(rest);break;}
                    const agents=session.agentManager().list();
                    set(s=>({...s,picker:{kind:'agents',title:'Agents',subtitle:'Select an agent to inspect its task and output here.',empty:'No agents yet. Use /agent <name> [role].',items:agents.map(agent=>({id:agent.name,label:agent.name,meta:`${agent.role} · ${agent.status}`,detail:agent.detail??'No output yet.',status:agent.status==='working'?'running':agent.status==='blocked'?'failed':agent.status==='done'?'done':'idle',action:{type:'agent',agentId:agent.name}}))}}));
                    break;
                }
                case 'run':
                    session.submit(rest ? { kind: 'user-message', text: rest, workspace: session.workspace, mode: 'agent' } : { kind: 'execute-plan' });
                    break;
                case 'plan':
                    if (!rest) {
                        addSystem('Usage: /plan <task>. Planning does not execute tools; use /run afterwards to execute the plan.');
                        break;
                    }
                    session.submit({ kind: 'plan-task', text: rest });
                    break;
                case 'dag':
                    addSystem(JSON.stringify(session.agentManager().activeNodes(), null, 2));
                    break;
                case 'cancel':
                    cancel();
                    break;
                case 'compact':
                    session.submit({ kind: 'compact' });
                    break;
                case 'clear':
                    session.submit({ kind: 'clear' });
                    if (!session.isBusy())
                        set(s => ({ ...s, entries: [], clearKey: s.clearKey + 1 }));
                    break;
                case 'resume': {
                    const sessions = listSessions();
                    if (!rest) {
                        addSystem(sessions.map(x => `${x.id} · ${x.instruction ?? ''}`).join('\n') || 'No saved sessions.');
                        break;
                    }
                    const match = sessions.find(x => x.id === rest);
                    if (!match)
                        throw new Error('Session not found. Use /resume to list sessions.');
                    await session.startRolloutIfNeeded(`Resume ${rest}`);
                    session.resume(match.file);
                    break;
                }
                case 'openrouter': {
                    if (rest) {
                        if (rest.startsWith('sk-or-') || rest.startsWith('sk-or-v1-')) {
                            setKey('openrouter', rest);
                            await session.selectProvider('openrouter');
                            set(s => ({ ...s, provider: 'openrouter', model: session.sessionModel() }));
                            addSystem(`Connected OpenRouter. Model: ${session.sessionModel()}`, 'OpenRouter');
                            break;
                        }
                        if (!providerAvailable('openrouter')) {
                            set(s => ({ ...s, awaitingProvider: 'openrouter', awaitingKey: true }));
                            addSystem('OpenRouter requires an API key. Paste your token (sk-or-v1-...) below:', 'OpenRouter Login');
                            break;
                        }
                        await session.selectProvider('openrouter', rest);
                        set(s => ({ ...s, provider: 'openrouter', model: session.sessionModel() }));
                        addSystem(`Switched OpenRouter model to ${session.sessionModel()}`, 'OpenRouter');
                        break;
                    }
                    if (providerAvailable('openrouter')) {
                        await session.selectProvider('openrouter');
                        set(s => ({ ...s, provider: 'openrouter', model: session.sessionModel() }));
                        addSystem(`Switched provider to OpenRouter. Model: ${session.sessionModel()}`, 'OpenRouter');
                        break;
                    }
                    set(s => ({ ...s, awaitingProvider: 'openrouter', awaitingKey: true }));
                    addSystem('Paste your OpenRouter API key (sk-or-v1-...) below to connect:', 'OpenRouter Login');
                    break;
                }
                case 'ollama':
                    await session.selectProvider('ollama',rest||undefined);set(s=>({...s,provider:'ollama'}));break;
                case 'login':
                    if(rest==='ollama') {await session.selectProvider('ollama');set(s=>({...s,provider:'ollama'}));break;}
                    if (rest && !listProviders(session.config).some(p => p.name === rest))
                        throw new Error('Unknown provider.');
                    set(s => ({ ...s, awaitingProvider: rest as ProviderName || null, awaitingKey: !rest }));
                    break;
                case 'logout':
                    clearKey(rest || session.providerLabel());
                    addSystem('Stored key removed.');
                    break;
                case 'model':
                case 'switch': {
                    if (!args[0]) throw new Error('Usage: /model <model> or /model <provider> [model]. Use /models to browse.');
                    const isProvider = listProviders(session.config).some(p => p.name === args[0]);
                    const provider = isProvider ? args[0] : session.providerLabel();
                    const model = isProvider ? args[1] : args[0];
                    await session.selectProvider(provider, model);
                    set(s => ({ ...s, provider: provider as ProviderName, model: session.sessionModel() }));
                    break;
                }
                case 'providers':
                case 'modelprovider':
                case 'models': {
                    const providers=listProviders(session.config).sort((a,b) => Number(b.name === session.providerLabel()) - Number(a.name === session.providerLabel()));
                    let ollamaModels:string[]=[];
                    const ollama=providers.find(provider=>provider.name==='ollama')!;
                    if(session.providerLabel()==='ollama') {
                        try {const discovery=await discoverOllama(session.config.ollamaHost||undefined,AbortSignal.timeout(2000));ollamaModels=discovery.models;ollama.available=true;ollama.model=ollamaModels.join(', ')||'No installed models';}
                        catch(error){ollama.available=false;ollama.model='Unavailable';if(cmd==='models')addSystem((error as Error).message,'Ollama');}
                    } else {ollama.available=false;ollama.model='Optional — select explicitly to connect';}
                    const makeItems = (imported: string[]): PickerItem[] => providers.flatMap<PickerItem>(provider => {
                        const status: PickerStatus = provider.enabled && provider.available ? 'connected' : 'offline';
                        if (cmd !== 'models')
                            return [{ id: provider.name, label: provider.label, meta: `${provider.model}${provider.enabled ? '' : ' · disabled'}`, status, action: { type: 'provider' as const, provider: provider.name } }];
                        const models=provider.name==='ollama'?ollamaModels:[...new Set([provider.model,...PROVIDERS.models[provider.name],...(provider.name==='opencode'?imported:[])])];
                        return models.map(model => ({ id: `${provider.name}:${model}`, label: model, meta: provider.label, status: provider.name === session.providerLabel() && model === session.sessionModel() ? 'active' : status, action: { type: 'model' as const, provider: provider.name, model } }));
                    });
                    const picker: PickerState = { kind: cmd === 'models' ? 'models' : 'providers', title: cmd === 'models' ? 'Models' : 'Providers', items: makeItems([]) };
                    set(s => ({ ...s, picker }));
                    if (cmd === 'models' && providers.some(p => p.name === 'opencode' && p.available))
                        void importOpenCodeModels().then(imported => { if (imported.length) set(s => s.picker === picker ? { ...s, picker: { ...picker, items: makeItems(imported) } } : s); });
                    break;
                }
                case 'status':
                    addSystem(`${session.providerLabel()} · ${session.sessionModel()}\n${session.workspace}\n~${session.context.tokenEstimate()} context tokens · ${state.turnTokens} last-turn tokens · ${state.tokens} session-total tokens`);
                    break;
                case 'diff': {
                    const result = await promisify(execFile)('git', ['diff'], { cwd: session.workspace, maxBuffer: 2 * 1024 * 1024 });
                    addSystem(result.stdout || 'No diff.');
                    break;
                }
                case 'benchmark':
                case 'compare':
                case 'distill': {
                    const file = path.resolve(session.workspace, rest || 'benchmark_large.py');
                    const result = distillSource(file, fs.readFileSync(file, 'utf8'), session.workspace);
                    addSystem(`${result.relativePath}: ~${result.originalTokens} → ~${result.distilledTokens} estimated tokens (${result.savingsPercent}% saved)`);
                    break;
                }
                default: throw new Error(`Unknown command: /${cmd}. Use /help.`);
            }
        }
        catch (error) {
            addSystem((error as Error).message, 'Error');
        }
    };
    return { state, approval, submit, cancel, respondApproval: (decision: ReviewDecision) => {
            if (approval) {
                session.submit({ kind: 'review', id: approval.id, decision });
            }
        }, elapsed: () => `${Math.floor((Date.now() - state.sessionStart) / 1000)}s`, addSystem, inspectAgent, inspectRole, selectPicker, closePicker };
}
