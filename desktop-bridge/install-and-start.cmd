@echo off
REM Install (or repair) the desktop bridge and restart DSH Desktop, in one step.
REM
REM Reported as issue #36: installing by hand meant closing DSH first, because the archive cannot be
REM moved while the shell holds it, and every "wait for the exit" arrangement lost its waiter. This
REM runs the installer with --restart, which closes the shell itself, installs, and starts it again.
REM
REM No arguments needed: the installer probes for the install directory. Pass one to override it.
REM   install-and-start.cmd "C:\path\to\DSH Desktop"
REM   install-and-start.cmd "C:\path\to\DSH Desktop" --yes
REM
REM --yes skips the confirmation prompt; without it the installer asks before closing DSH.

setlocal
set "HERE=%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo node was not found on PATH. Install Node.js 22 or later, then run this again.
  exit /b 1
)

if "%~1"=="" (
  node "%HERE%install.mjs" --restart
) else if "%~2"=="" (
  node "%HERE%install.mjs" "%~1" --restart
) else (
  node "%HERE%install.mjs" "%~1" %2 --restart
)

set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo The installer exited with code %CODE%. Nothing was changed if the message above says so.
)
endlocal & exit /b %CODE%
