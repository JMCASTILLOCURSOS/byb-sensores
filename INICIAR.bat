@echo off
setlocal
cd /d "%~dp0"
title DINAMIC BYB - servidor

where node >nul 2>nul
if errorlevel 1 goto sinnode

node server.js
if errorlevel 1 pause
exit /b 0

:sinnode
echo.
echo   ------------------------------------------------------------------
echo    No encontre Node.js en este PC.
echo.
echo    Node.js es el programa que necesita la app para arrancar.
echo    Descarguelo gratis en:   https://nodejs.org
echo    Elija el boton verde "LTS", instale con las opciones por defecto
echo    y despues vuelva a hacer doble clic en el icono DINAMIC BYB.
echo   ------------------------------------------------------------------
echo.
pause
exit /b 1
