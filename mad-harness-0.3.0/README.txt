MAD Harness 0.3.0 - portable build
==================================

Requires Node.js 18+ (20+ recommended). Runtime dependencies are included,
so no `npm install` is needed. A network connection is only required when
calling a hosted model provider.

Quick start
-----------
  ./mad                         Interactive TUI
  ./mad "create hello.txt"      One-shot agent run
  ./mad ask "explain this repo" Direct provider answer
  ./mad auth                    Connect a hosted provider

Windows
-------
  mad.cmd
  node packages\cli\dist\index.js

Connect a provider
------------------
  ./mad auth gsk_...            Auto-detect Groq
  ./mad auth sk-ant-...         Auto-detect Anthropic
  ./mad auth sk-...             Auto-detect OpenAI
  ./mad auth AIza...            Auto-detect Gemini
  ./mad auth groq               Prompt for a Groq key

Local agents (no API key)
-------------------------
  OpenCode is the default provider and is auto-detected from PATH.
  It uses its own installed CLI and local credentials for direct chat.
  Pi is auto-detected but disabled by default.
  The /dag pipeline requires a hosted or Ollama provider.

TUI commands
------------
  /login [provider|key]         Connect a provider
  /modelprovider                Choose a provider (cloud, Ollama, local CLI)
  /models                       Choose a model
  /model <provider|model-id>    Switch provider or model
  /dag <task>                   Hidden Architect → Coder → Sandbox → Debugger run
  /agents                       Browse worker roles/status
  /help                         All commands
  /exit                         Quit

Notes
-----
- File and shell tools operate inside the current working directory.
- Run `cd /path/to/project` before launching `mad`.
- Writes and shell commands require explicit approval by default.
- API keys are stored in the OS user config directory via `conf`.
- This portable build uses pure-JS fallbacks for optional native accelerators,
  so it runs without a compiler or native rebuild.
