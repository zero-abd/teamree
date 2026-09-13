@echo off
rem The one command that stands a relay up, on Windows. See the POSIX script
rem beside this one for what it does and why it insists on Node.
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo teamree-relay: deploying a Cloudflare Worker needs Node, and there is none on PATH - install Node 20 or newer from https://nodejs.org and run this again. 1>&2
  exit /b 1
)
node "%~dp0bin\teamree-relay.mjs" %*
