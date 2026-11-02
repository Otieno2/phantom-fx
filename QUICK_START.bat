@echo off
REM Phantom FX - Quick Start Script (Batch Version)
REM This will move project to C:\Dev and start the server

echo === Phantom FX Quick Start ===
echo.

set SOURCE=C:\Users\INFINITY\OneDrive\Desktop\phantom-fx
set TARGET=C:\Dev\phantom-fx

REM Check if target exists
if exist "%TARGET%" (
    echo Target directory already exists: %TARGET%
    echo.
    set /p CONTINUE="Continue anyway and reinstall? (Y/N): "
    if /i not "%CONTINUE%"=="Y" (
        echo Cancelled.
        pause
        exit /b
    )
    cd /d "%TARGET%"
    goto INSTALL
)

REM Create target directory
echo Creating directory: %TARGET%
mkdir "%TARGET%" 2>nul

REM Copy project files (excluding node_modules)
echo Copying project files...
robocopy "%SOURCE%" "%TARGET%" /E /XD "node_modules" ".next" /XF "*.log" /NFL /NDL /NJH /NJS >nul

REM Copy .env if exists
if exist "%SOURCE%\.env" (
    copy "%SOURCE%\.env" "%TARGET%\.env" >nul
)

REM Navigate to target
cd /d "%TARGET%"
echo Moved to: %TARGET%
echo.

:INSTALL
REM Install dependencies
echo Installing dependencies (this may take a few minutes)...
call npm install

if errorlevel 1 (
    echo.
    echo Installation failed! Please check errors above.
    pause
    exit /b 1
)

echo.
echo === Installation Complete ===
echo.
echo Starting development server...
echo Server will be available at: http://localhost:3000
echo.
echo Login credentials:
echo   Email: admin@phantomfx.local
echo   Password: ChangeMe123!
echo.
echo Press Ctrl+C to stop the server
echo.

REM Start the dev server
call npm run dev
