@echo off
setlocal
echo.
echo   Deteniendo el servidor DINAMIC BYB...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
timeout /t 2 >nul
echo   Listo. Puede cerrar esta ventana.
timeout /t 2 >nul
exit /b 0
