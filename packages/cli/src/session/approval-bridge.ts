// ─── Approval bridge: shared safe classifier used by the session gate ───────
import { Risk } from '../protocol/types.js';
import { classifyRisk } from '../tools/approvals.js';
import type { ApprovalRequestBrief } from '../tools/types.js';
/**
 * The session's central gate receives an already-classified brief, but a tool
 * owner may pass a raw request; classify defensively without crashing.
 */
export function classifyRiskSafe(request: ApprovalRequestBrief): ApprovalRequestBrief {
    if (!request || typeof request !== 'object') {
        return { tool: 'unknown', brief: 'unknown', risk: Risk.Read };
    }
    const risk = (['read', 'write', 'shell', 'shell-destructive'] as const).includes(request.risk as never)
        ? (request.risk as 'read' | 'write' | 'shell' | 'shell-destructive')
        : classifyRisk(request.tool, { command: request.brief }).risk;
    return {
        tool: request.tool,
        brief: request.brief ?? '',
        risk: risk as ApprovalRequestBrief['risk'],
    };
}
