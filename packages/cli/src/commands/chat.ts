import { Command } from 'commander';
import React from 'react';
import { render } from 'ink';
import { App } from '../components/App.js';
import { IncrementalOutput } from '../components/incremental-output.js';
export const chatCommand = new Command('chat')
    .alias('tui')
    .description('Start the interactive terminal agent harness')
    .option('--full-access', 'Run tool actions without approval and allow paths outside the workspace')
    .option('--ask-permission', 'Ask before each mutating tool action')
    .action(async (options: {
    fullAccess?: boolean;
    askPermission?: boolean;
}) => {
    if (options.fullAccess && options.askPermission)
        throw new Error('Choose one access mode');
    const output = process.stdout.isTTY ? new IncrementalOutput(process.stdout) : null;
    const { waitUntilExit } = render(React.createElement(App, { initialAccess: options.fullAccess ? 'full' : options.askPermission ? 'ask' : undefined }), output ? { stdout: output as unknown as NodeJS.WriteStream } : undefined);
    try { await waitUntilExit(); } finally { output?.destroy(); }
});
