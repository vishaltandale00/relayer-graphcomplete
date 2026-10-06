@echo off
set "relayerDevWorkspace=%~1"
set "relayerDevCheckout=%~2"
if not defined relayerDevWorkspace exit /b 2
if not defined relayerDevCheckout exit /b 2
set "CARGO_HOME=%relayerDevWorkspace%\cargo"
set "RUSTUP_HOME=%relayerDevWorkspace%\rustup"
set "PATH=%relayerDevWorkspace%\Perl\perl\bin;%relayerDevWorkspace%\Perl\c\bin;%relayerDevWorkspace%\cargo\bin;%relayerDevWorkspace%\Git\cmd;%relayerDevWorkspace%\Git\usr\bin;%relayerDevWorkspace%\Node\node-v22.23.2-win-x64;%relayerDevWorkspace%\CMake\cmake-4.4.3-windows-x86_64\bin;%PATH%"
call C:\RelayerBuildTools2022\VC\Auxiliary\Build\vcvars64.bat
if errorlevel 1 exit /b %errorlevel%
cd /d "%relayerDevCheckout%"

cmake -P "%relayerDevCheckout%\scripts\windows-dev-preflight.cmake"
if errorlevel 1 exit /b %errorlevel%
ninja --version
if errorlevel 1 exit /b %errorlevel%
