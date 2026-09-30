' Starts the mamo work-runner without a console window.
' Launched at logon from a shortcut in the Windows Startup folder (see README.md).
' Paths are derived from this script's location, so no absolute path is hardcoded here.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
workerDir = fso.GetParentFolderName(WScript.ScriptFullName)
mamoDir = fso.GetParentFolderName(workerDir)
sh.CurrentDirectory = mamoDir
sh.Run "cmd /c node worker\work-runner.mjs", 0, False
