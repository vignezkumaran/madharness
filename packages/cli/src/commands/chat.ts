import { Command } from 'commander';
import React from 'react';
import { render } from 'ink';
import { App } from '../components/App.js';

export const chatCommand = new Command('chat')
  .alias('tui')
  .description('Start the interactive terminal agent harness')
  .action(async () => {
    const { waitUntilExit } = render(React.createElement(App));
    await waitUntilExit();
  });
