@echo off
setlocal
rem jarvisd - the Jarvis daemon's command line, run with the Jarvis.exe this
rem file ships beside (resources\bin\jarvisd.cmd). The CLI is a script inside
rem app.asar that Jarvis.exe runs as plain Node with ELECTRON_RUN_AS_NODE=1.
rem setlocal keeps that variable out of the calling console. Nothing here
rem touches PATH; see docs/guide/background-daemon.md.
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\Jarvis.exe" "%~dp0..\app.asar\dist\src\daemon\cli\jarvisd.js" %*
exit /b %ERRORLEVEL%
