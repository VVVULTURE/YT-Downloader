; YT Downloader — Inno Setup installer script
; Compiled by build_installer.bat using Inno Setup's ISCC.exe.
; Packages the standalone dist\YT-Downloader.exe (which already has
; ffmpeg bundled inside it) into a proper Windows installer with
; Start Menu / Desktop shortcuts and an uninstaller.

#define MyAppName "YT Downloader"
#define MyAppVersion "3.1"
#define MyAppExeName "YT-Downloader.exe"
#define MyAppIcoName "YT-Downloader.ico"

[Setup]
AppId={{7C6E2A1F-4B3D-4E9A-9F2C-1D8B6A5E3C90}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#SourcePath}\installer_output
OutputBaseFilename=YT-Downloader-Setup
Compression=lzma2
SolidCompression=yes
SetupIconFile={#SourcePath}\assets\{#MyAppIcoName}
UninstallDisplayIcon={app}\{#MyAppIcoName}
UninstallDisplayName={#MyAppName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Files]
Source: "{#SourcePath}\dist\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
; Ship the icon as a standalone file too. Explorer reads a shortcut's icon
; from this small .ico far more reliably than by digging it out of a 200+ MB
; onefile exe (which is why the desktop shortcut can show a blank/generic
; icon right after install until the icon cache refreshes).
Source: "{#SourcePath}\assets\{#MyAppIcoName}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppIcoName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppIcoName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent
