Option Explicit
' Watchdog launcher: the scheduled task calls this, it hands off to node.
' Window style 0 = hidden: nothing flashes, nothing steals focus.
' node instead of powershell: powershell cold start spawns a conhost and can stutter video.
'
' IMPORTANT: keep this file pure ASCII and never let an error escape as a dialog.
' (A Chinese comment saved as UTF-8 broke it once: WSH read it as ANSI/GBK, lines
'  merged, and it popped a modal "Variable is undefined" box that stole focus.)
On Error Resume Next

Dim fso, sh, here, nodeExe, scriptFile, logFile, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
logFile = fso.BuildPath(here, "..\state\watchdog-vbs.log")

Sub Note(message)
  On Error Resume Next
  Dim f
  Set f = fso.OpenTextFile(logFile, 8, True)
  f.WriteLine Now & " " & message
  f.Close
End Sub

If Err.Number <> 0 Then WScript.Quit 0

scriptFile = fso.BuildPath(here, "bridge-watchdog.mjs")
nodeExe = "D:\deepseek\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
If Not fso.FileExists(nodeExe) Then
  nodeExe = "C:\Program Files\nodejs\node.exe"
End If

If Err.Number <> 0 Then WScript.Quit 0
If Not fso.FileExists(scriptFile) Then
  Note "missing " & scriptFile
  WScript.Quit 0
End If
If Not fso.FileExists(nodeExe) Then
  Note "no node.exe found"
  WScript.Quit 0
End If

cmd = """" & nodeExe & """ """ & scriptFile & """"
sh.Run cmd, 0, False
If Err.Number <> 0 Then Note "run failed: " & Err.Description
