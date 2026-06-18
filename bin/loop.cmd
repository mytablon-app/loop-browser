@echo off
rem loop — Loop Browser CLI launcher (packaged app, Windows).
rem Runs the bundled CLI using the app's OWN Electron as Node (ELECTRON_RUN_AS_NODE=1),
rem so the user needs neither a separate Node install nor the source repo.
rem Mirrors the POSIX `bin/loop` shim. This file lives at
rem   <install>\resources\app\bin\loop.cmd
rem and the Electron exe sits at the install root, three levels up.
setlocal
set "HERE=%~dp0"
set "ELECTRON=%HERE%..\..\..\Loop Browser.exe"
set "CLI=%HERE%..\cli.mjs"
set "ELECTRON_RUN_AS_NODE=1"
"%ELECTRON%" "%CLI%" %*
exit /b %ERRORLEVEL%
