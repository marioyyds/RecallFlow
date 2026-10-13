@echo off
rem Windows entry point: forwards all arguments to scripts/dev-up.sh.
rem Why not a native cmd/PowerShell implementation: two copies of the same logic
rem always drift apart, so this file only locates Git Bash and forwards.
rem Keep this file pure ASCII: cmd.exe reads .cmd with the console code page
rem (usually 936 here), and UTF-8 Chinese comment bytes break line parsing
rem (observed: "rem" lines got split and executed as commands).
setlocal

set "BASH="
if exist "%ProgramFiles%\Git\bin\bash.exe" set "BASH=%ProgramFiles%\Git\bin\bash.exe"
if not defined BASH if exist "%ProgramFiles(x86)%\Git\bin\bash.exe" set "BASH=%ProgramFiles(x86)%\Git\bin\bash.exe"
if not defined BASH if exist "%LOCALAPPDATA%\Programs\Git\bin\bash.exe" set "BASH=%LOCALAPPDATA%\Programs\Git\bin\bash.exe"
if not defined BASH (
  for /f "delims=" %%i in ('where git 2^>nul') do (
    if not defined BASH if exist "%%~dpi..\bin\bash.exe" set "BASH=%%~dpi..\bin\bash.exe"
  )
)

if not defined BASH (
  echo [dev-up] Git Bash not found. Install Git for Windows, or run inside Git Bash: 1>&2
  echo   bash scripts/dev-up.sh %* 1>&2
  echo   WSL bash will NOT work here: its node and D:\ paths differ. 1>&2
  exit /b 2
)

set "SCRIPT=%~dp0dev-up.sh"
set "SCRIPT=%SCRIPT:\=/%"
"%BASH%" "%SCRIPT%" %*
exit /b %ERRORLEVEL%
