@echo off
rem RecallFlow: re-run native host registration (Start Menu shortcut "RecallFlow 修复宿主注册").
rem Kept ASCII-only on purpose: cmd.exe parses .cmd with the console code page, and non-ASCII
rem comment bytes can break line parsing (we hit exactly that in scripts\dev-up.cmd).
rem The actual messages are printed by install-host.mjs, and chcp 65001 makes them readable.
setlocal
chcp 65001 >nul
echo Registering RecallFlow native messaging host...
echo.
"%~dp0node.exe" "%~dp0install-host.mjs" --install --dir "%~dp0."
echo.
echo Exit code: %ERRORLEVEL%
pause
