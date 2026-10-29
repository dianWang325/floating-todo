; The visible product name changed; the application identifier and binary did not.
; Only retire a legacy registration when it points to this installation.
!macro RemoveLegacyShortcut PATH
  !insertmacro IsShortcutTarget "${PATH}" "$INSTDIR\${MAINBINARYNAME}.exe"
  Pop $0
  ${If} $0 = 1
    Delete "${PATH}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $0 SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\floating todo" "InstallLocation"
  ${If} $0 == '$\"$INSTDIR$\"'
  ${OrIf} $0 == "$INSTDIR"
    DeleteRegKey SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\floating todo"
  ${EndIf}
  !insertmacro RemoveLegacyShortcut "$DESKTOP\floating todo.lnk"
  !insertmacro RemoveLegacyShortcut "$DESKTOP\悬浮待办.lnk"
  !insertmacro RemoveLegacyShortcut "$SMPROGRAMS\floating todo.lnk"
  !insertmacro RemoveLegacyShortcut "$SMPROGRAMS\悬浮待办.lnk"
!macroend
