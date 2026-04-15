@echo off
REM DarknessBot Trip Viewer — local static server
REM Worker + IndexedDB require http(s)://, so file:// won't work.
cd /d "%~dp0"
echo Serving %CD% on http://localhost:8000/
echo Press Ctrl+C to stop.
start "" http://localhost:8000/
python -m http.server 8000
