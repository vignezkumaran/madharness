import { exec } from 'child_process';
import { promisify } from 'util';
import type { ToolResult } from './types.js';

const execAsync = promisify(exec);

export class GitTool {
  public async getStatus(): Promise<ToolResult> {
    try {
      const { stdout } = await execAsync('git status --short');
      const branchRes = await execAsync('git branch --show-current');
      const branch = branchRes.stdout.trim();
      const output = stdout.trim() 
        ? `Branch: ${branch}\nChanges:\n${stdout.trim()}`
        : `Branch: ${branch}\nWorking tree clean (no uncommitted changes)`;

      return { success: true, output };
    } catch (err) {
      return {
        success: false,
        output: `Git status error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  public async getDiff(cached = false): Promise<ToolResult> {
    try {
      const cmd = cached ? 'git diff --cached' : 'git diff';
      const { stdout } = await execAsync(cmd);
      return {
        success: true,
        output: stdout.trim() ? stdout.slice(0, 3000) : 'No diff found.',
      };
    } catch (err) {
      return {
        success: false,
        output: `Git diff error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  public async getRecentCommits(count = 5): Promise<ToolResult> {
    try {
      const { stdout } = await execAsync(`git log -n ${count} --oneline`);
      return {
        success: true,
        output: stdout.trim() ? stdout : 'No commits yet.',
      };
    } catch (err) {
      return {
        success: false,
        output: `Git log error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

export const gitTool = new GitTool();
