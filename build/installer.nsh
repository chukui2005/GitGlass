; This marker is written only by NSIS, never into the unpacked or ZIP payload.
!macro customInstall
  Push $R0
  FileOpen $R0 "$INSTDIR\resources\gitglass-installed" w
  FileWrite $R0 "nsis"
  FileClose $R0
  Pop $R0
!macroend

!macro customUnInstall
  Delete "$INSTDIR\resources\gitglass-installed"
!macroend
