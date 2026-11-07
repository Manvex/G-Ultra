!ifndef BUILD_UNINSTALLER
  !include nsDialogs.nsh
  Var InstallDriver
  Var DriverCheckbox
!endif

!macro customInit
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM GUltraHelper.exe'
  Pop $0
  ; Checked by default, and also what a silent install does.
  StrCpy $InstallDriver 1
!macroend

; The sensor driver is optional, so it gets its own page, ticked by default.
!macro customPageAfterChangeDir
  Page custom DriverPageShow DriverPageLeave

  Function DriverPageShow
    !insertmacro MUI_HEADER_TEXT "Sensor driver" "Recommended, and most people should leave it on."
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateLabel} 0 0 100% 70u "G Ultra uses PawnIO, a signed open-source driver, to read the real CPU temperature and control fans. Windows doesn't give apps this data any other way.$\r$\n$\r$\nWithout it, everything else still works, but you won't see the CPU temperature, and fan control and the temperature rules may not be available. You can install it later from the Thermals screen."
    Pop $0
    ${NSD_CreateCheckbox} 0 78u 100% 14u "Install the PawnIO sensor driver (recommended)"
    Pop $DriverCheckbox
    ${If} $InstallDriver == 1
      ${NSD_Check} $DriverCheckbox
    ${EndIf}
    nsDialogs::Show
  FunctionEnd

  Function DriverPageLeave
    ${NSD_GetState} $DriverCheckbox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $InstallDriver 1
    ${Else}
      StrCpy $InstallDriver 0
    ${EndIf}
  FunctionEnd
!macroend

!macro customUnInit
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM GUltraHelper.exe'
  Pop $0
!macroend

; Everything G Ultra needs goes in with the app: the installer runs elevated, so nothing
; has to be set up by hand afterwards.

!macro customInstall
  ; The native helper needs .NET Framework 4.7.2 or newer. Windows 10 1803+ and Windows 11
  ; already have it, so the bundled web installer only runs on older systems.
  SetRegView 64
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full" "Release"
  ${If} $0 < 461808
    DetailPrint "Installing .NET Framework..."
    ExecWait '"$INSTDIR\resources\drivers\ndp48-web.exe" /q /norestart' $1
    DetailPrint ".NET Framework setup finished with code $1"
  ${EndIf}

  ; PawnIO is the signed sensor driver behind CPU temperatures and fan control.
  ; Remember whether this installer added it, so uninstalling only removes what it put there.
  ${If} $InstallDriver == 1
  ReadRegStr $2 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PawnIO" "DisplayVersion"
  ${If} $2 == ""
    WriteRegDWORD HKLM "Software\G Ultra" "InstalledPawnIO" 1
  ${EndIf}
  DetailPrint "Installing the sensor driver (PawnIO)..."
  ExecWait '"$INSTDIR\resources\drivers\PawnIO_setup.exe" -install -silent' $3
  DetailPrint "Sensor driver setup finished with code $3"
  ${EndIf}
  SetRegView lastused
!macroend

!macro customUnInstall
  ; An update also runs the uninstaller: keep the driver in that case.
  ${ifNot} ${isUpdated}
    SetRegView 64
    ReadRegDWORD $0 HKLM "Software\G Ultra" "InstalledPawnIO"
    ${If} $0 == 1
      ReadRegStr $1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PawnIO" "QuietUninstallString"
      ${If} $1 != ""
        DetailPrint "Removing the sensor driver (PawnIO)..."
        ExecWait '$1'
      ${EndIf}
    ${EndIf}
    DeleteRegKey HKLM "Software\G Ultra"
    nsExec::Exec '"$SYSDIR\schtasks.exe" /Delete /TN "G Ultra Monitor" /F'
    Pop $0
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "G Ultra Monitor"
    SetRegView lastused
  ${EndIf}
!macroend
