@echo off
setlocal
if not defined LOCALAPPDATA (
  echo Windows LOCALAPPDATA is missing. Nothing was started.
  exit /b 1
)
if not exist "%~dp0hermes-light-3b42157.exe" (
  echo Extract the complete Windows ZIP before starting this launcher.
  exit /b 1
)
set "HERMES_DESKTOP_USER_DATA_DIR=%LOCALAPPDATA%\HermesVoiceNote\desktop"
set "HERMES_HOME=%HERMES_DESKTOP_USER_DATA_DIR%\hermes-home"
set "HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION=1"
start "" /D "%~dp0" "%~dp0hermes-light-3b42157.exe"
exit /b %errorlevel%
