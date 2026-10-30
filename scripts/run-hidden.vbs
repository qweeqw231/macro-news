' scripts\run-hidden.vbs
' Launch a command with NO visible window.
'
' Why: powershell.exe -WindowStyle Hidden still creates a console window for a
' moment before hiding it (visible as a flash every run). wscript.exe is a GUI
' subsystem host: it never allocates a console, and WshShell.Run with style 0
' starts the child process without any window at all.
'
' Usage:
'   wscript.exe //nologo run-hidden.vbs "<script.ps1>" ["-ExtraArg" ...]
'
Option Explicit

Dim sh, ps1, extra, i, cmd

If WScript.Arguments.Count = 0 Then
  WScript.Quit 1
End If

Set sh = CreateObject("WScript.Shell")
ps1 = WScript.Arguments(0)
extra = ""
For i = 1 To WScript.Arguments.Count - 1
  extra = extra & " " & WScript.Arguments(i)
Next

cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """" & extra

' 0 = hidden window, False = do not wait
sh.Run cmd, 0, False
