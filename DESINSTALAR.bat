@echo off
setlocal
title Desinstalar DINAMIC BYB
echo.
echo   Quitando los accesos directos de DINAMIC BYB...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $d=$ws.SpecialFolders('Desktop'); Remove-Item ($d+'\DINAMIC BYB.lnk') -Force -ErrorAction SilentlyContinue; $sp=$ws.SpecialFolders('Programs')+'\DINAMIC BYB'; Remove-Item $sp -Recurse -Force -ErrorAction SilentlyContinue; Write-Host '   Accesos directos eliminados.'"
echo.
echo   Los archivos de la app NO se borraron (siguen en esta carpeta).
echo.
pause
exit /b 0
