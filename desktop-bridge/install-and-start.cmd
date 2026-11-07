@echo off
REM Install (or repair) the bridge after DSH Desktop has exited, then start Desktop.
REM
REM Exit DSH Desktop normally before running this file from an external terminal.
REM A running target is refused; this launcher does not close or terminate it.
REM
REM No arguments needed: the installer probes for the install directory. Pass one to override it.
REM   install-and-start.cmd "C:\path\to\DSH Desktop"
REM   install-and-start.cmd "C:\path\to\DSH Desktop" --yes
REM
REM Legacy --yes is accepted for command-line compatibility; it does not permit closing Desktop.

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
