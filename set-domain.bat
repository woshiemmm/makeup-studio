@echo off
setlocal
title Set Site Domain

set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

if not defined NODE_EXE (
  echo.
  echo  [ERROR] Node.js not found. Install it from https://nodejs.org
  echo.
  pause
  exit /b 1
)

if "%~1"=="" (
  echo.
  echo  Usage: drag nothing, just run and type your site URL below.
  echo  Example: https://makeup-studio.pages.dev
  echo.
  set /p SITE=  Your site URL: 
) else (
  set "SITE=%~1"
)

"%NODE_EXE%" "%~dp0set-domain.js" "%SITE%"
pause
