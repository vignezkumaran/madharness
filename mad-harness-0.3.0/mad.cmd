@echo off
if exist "%~dp0..\packages\cli\dist\index.js" (
  node "%~dp0..\packages\cli\dist\index.js" %*
) else (
  node "%~dp0packages\cli\dist\index.js" %*
)
