import { Command } from 'commander';
import React from 'react';
import { render } from 'ink';
import { App } from '../components/App.js';

export const chatCommand = new Command('chat')
  .description('Start interactive chat with AI providers')
  .option('-p, --provider <provider>', 'Default AI provider', 'claude')
  .action(async () => {
    const { waitUntilExit } = render(React.createElement(App));
    await waitUntilExit();
  });
