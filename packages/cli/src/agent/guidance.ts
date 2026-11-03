import * as fs from 'fs';
import * as path from 'path';
/** Include project instructions, but fetch code and repository structure only on demand. */
export function workspaceGuidance(workspace: string): string {
    const parts = [`Workspace: ${workspace}`];
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
        const file = path.join(workspace, name);
        if (fs.existsSync(file)) {
            parts.push(`Project instructions:\n${fs.readFileSync(file, 'utf8')}`);
            break;
        }
    }
    return parts.join('\n\n');
}
