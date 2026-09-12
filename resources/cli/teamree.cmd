@echo off
rem The `teamree` CLI as it ships inside the installed app (Windows).
rem
rem A .sh launcher is useless here, so this batch shim is what cmd.exe resolves
rem when `teamree` is typed. It runs the bundled CLI under the app's own
rem Electron binary, which behaves as plain Node with ELECTRON_RUN_AS_NODE set,
rem so no separately installed Node runtime is required.
rem
rem Put it on PATH by adding this directory (see README), for example:
rem   %LOCALAPPDATA%\Programs\teamree\resources\cli
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\teamree.exe" "%~dp0teamree.mjs" %*
exit /b %ERRORLEVEL%
