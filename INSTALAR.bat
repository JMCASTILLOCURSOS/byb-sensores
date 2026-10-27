@echo off
setlocal
cd /d "%~dp0"
title Instalar DINAMIC BYB

set "APP=%~dp0"
if "%APP:~-1%"=="\" set "APP=%APP:~0,-1%"

set "ICO=%APP%\icons\icon.ico"
if not exist "%ICO%" set "ICO=%APP%\icons\icon-192.png"

echo.
echo   ================================================================
echo    INSTALANDO  "DINAMIC BYB"  en este PC
echo   ================================================================
echo    Carpeta: %APP%
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo    AVISO: no encontre Node.js.
  echo    La app lo necesita para funcionar.
  echo    Descarguelo gratis de  https://nodejs.org  ^(boton "LTS"^).
  echo.
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $app=$env:APP; $ico=$env:ICO; $ws=New-Object -ComObject WScript.Shell; $d=$ws.SpecialFolders('Desktop'); $l=$ws.CreateShortcut($d+'\DINAMIC BYB.lnk'); $l.TargetPath=$app+'\INICIAR.bat'; $l.WorkingDirectory=$app; $l.IconLocation=$ico+',0'; $l.Description='DINAMIC BYB - Balanceo dinamico'; $l.WindowStyle=7; $l.Save(); $sp=$ws.SpecialFolders('Programs')+'\DINAMIC BYB'; if(-not (Test-Path $sp)){ New-Item -ItemType Directory -Path $sp | Out-Null }; $s2=$ws.CreateShortcut($sp+'\DINAMIC BYB.lnk'); $s2.TargetPath=$app+'\INICIAR.bat'; $s2.WorkingDirectory=$app; $s2.IconLocation=$ico+',0'; $s2.WindowStyle=7; $s2.Save(); $s3=$ws.CreateShortcut($sp+'\Detener servidor.lnk'); $s3.TargetPath=$app+'\DETENER.bat'; $s3.WorkingDirectory=$app; $s3.WindowStyle=7; $s3.Save(); $s4=$ws.CreateShortcut($sp+'\Desinstalar DINAMIC BYB.lnk'); $s4.TargetPath=$app+'\DESINSTALAR.bat'; $s4.WorkingDirectory=$app; $s4.WindowStyle=7; $s4.Save(); Write-Host '   Accesos directos creados.'"

if errorlevel 1 (
  echo.
  echo    No se pudieron crear los accesos directos.
  echo    Pruebe a ejecutar este INSTALAR.bat con clic derecho
  echo    y "Ejecutar como administrador".
  echo.
  pause
  exit /b 1
)

echo.
echo   ================================================================
echo    LISTO. Instalado correctamente.
echo.
echo    En el Escritorio vera el icono  "DINAMIC BYB".
echo    Hagale doble clic y la app se abre sola en el navegador.
echo.
echo    Para quitarlo de este PC use  DESINSTALAR.bat
echo    ^(tambien quedo en el menu Inicio^).
echo   ================================================================
echo.
pause
exit /b 0
