; YT Downloader — Inno Setup installer script
; Compiled by build_installer.bat using Inno Setup's ISCC.exe.
; Packages the standalone dist\YT-Downloader.exe (which already has
; ffmpeg bundled inside it) into a proper Windows installer with
; Start Menu / Desktop shortcuts and an uninstaller.

#define MyAppName "YT Downloader"
#define MyAppVersion "1.0"
#define MyAppExeName "YT-Downloader.exe"

[Setup]
AppId={{7C6E2A1F-4B3D-4E9A-9F2C-1D8B6A5E3C90}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64
OutputDir={#SourcePath}\installer_output
OutputBaseFilename=YT-Downloader-Setup
Compression=lzma2
SolidCompression=yes
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Files]
Source: "{#SourcePath}\dist\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent
