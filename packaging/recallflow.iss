; RecallFlow 安装器（Inno Setup 6/7）
;
; 由 scripts/build-dist.mjs 调用：
;   ISCC.exe /DAppVersion=0.0.1 /DSourceDir=<dist\payload> /DOutDir=<dist> packaging\recallflow.iss
; 下面的 #ifndef 默认值保证它也能被单独编译（例如在 Inno 的 IDE 里直接按 F9）。
;
; 设计取向（都是为"不会编程的人"服务的）：
;   · PrivilegesRequired=lowest：全程只写 HKCU 与用户目录，不弹 UAC；
;   · 只装"本地服务宿主"，扩展仍由浏览器加载 —— 安装器不碰浏览器配置；
;   · 装完必须把"扩展还没加载"这种情况讲清楚，这是安装后最常见的失败原因（见 CurPageChanged）。

#ifndef AppVersion
  #define AppVersion "0.0.1"
#endif
#ifndef SourceDir
  #define SourceDir "..\dist\payload"
#endif
#ifndef OutDir
  #define OutDir "..\dist"
#endif
#ifndef LangFile
  #define LangFile "compiler:Default.isl"
#endif

[Setup]
; AppId 必须固定：升级时靠它认出"这是同一个应用"，改了会导致新旧版本并存。
AppId={{8F2E1B64-3C7A-4E5D-9A21-0B6D4C7E5F10}
AppName=RecallFlow
AppVersion={#AppVersion}
AppVerName=RecallFlow {#AppVersion}
AppPublisher=RecallFlow
DefaultDirName={localappdata}\Programs\RecallFlow
DefaultGroupName=RecallFlow
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutDir}
OutputBaseFilename=RecallFlow-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=RecallFlow（浏览器本地服务宿主）
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; 我们自己负责"先停进程再替换文件"，所以不要让 Inno 去弹"文件正在使用"或重启应用。
CloseApplications=no
RestartApplications=no

[Languages]
Name: "chinese"; MessagesFile: "{#LangFile}"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; "修复宿主注册"：用户先装扩展后装宿主（或换浏览器/换 Profile）时，点它就能补注册。
Name: "{userprograms}\RecallFlow 修复宿主注册"; Filename: "{app}\install-host.cmd"; WorkingDir: "{app}"; Comment: "在浏览器里加载 RecallFlow 扩展后运行一次"
Name: "{userprograms}\RecallFlow 日志与状态"; Filename: "{sys}\explorer.exe"; Parameters: """{localappdata}\RecallFlow\logs"""; Comment: "打开本地服务日志目录"
Name: "{userprograms}\卸载 RecallFlow"; Filename: "{uninstallexe}"

[UninstallRun]
; 顺序很重要：先反注册（删 HKCU 里的 native messaging 项），**再**停进程。
; 只停不反注册没用 —— 实测过：宿主被杀掉后扩展 1 秒内就按注册表把它重新拉起来，
; 文件继续被占用，卸载会留下 node.exe / exe 删不掉。
Filename: "{app}\node.exe"; Parameters: """{app}\install-host.mjs"" --uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "UnregisterHost"
Filename: "{app}\node.exe"; Parameters: """{app}\install-host.mjs"" --stop"; Flags: runhidden waituntilterminated; RunOnceId: "StopHost"

[Code]
var
  RegisterExitCode: Integer;

// 升级/重装前：先反注册，再停掉宿主与服务，然后 Inno 才去覆盖文件。
// 为什么必须按这个顺序（实测教训）：Windows 不允许覆盖正在运行的 exe，而"只杀进程"不够 ——
// 扩展会立刻按注册表把宿主拉回来（实测 1 秒），文件重新被锁住，安装器直接以退出码 5 失败。
// 反注册之后扩展拉不起来（会退避重试，最长 1 分钟），这段窗口足够替换文件，装完再注册回去。
procedure StopRunning();
var
  ResultCode: Integer;
begin
  if FileExists(ExpandConstant('{app}\node.exe')) and FileExists(ExpandConstant('{app}\install-host.mjs')) then
  begin
    Exec(ExpandConstant('{app}\node.exe'), '"' + ExpandConstant('{app}\install-host.mjs') + '" --uninstall', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(ExpandConstant('{app}\node.exe'), '"' + ExpandConstant('{app}\install-host.mjs') + '" --stop', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep = ssInstall then
    StopRunning()
  else if CurStep = ssPostInstall then
  begin
    // 注册宿主：这一步要在**用户机器上**读浏览器 Profile 才能拿到扩展 ID，
    // 所以交给随包的 node 跑 install-host.mjs（退出码 3 = 还没加载扩展）。
    if Exec(ExpandConstant('{app}\node.exe'),
            '"' + ExpandConstant('{app}\install-host.mjs') + '" --install --dir "' + ExpandConstant('{app}') + '"',
            '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
      RegisterExitCode := ResultCode
    else
      RegisterExitCode := -1;
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpFinished then
  begin
    if RegisterExitCode = 3 then
      MsgBox('文件已安装完成，但还没在浏览器里加载 RecallFlow 扩展，因此本地宿主暂未注册。' + #13#10 + #13#10 +
             '请在 Edge/Chrome 的扩展页启用「开发人员模式」→「加载解压缩的扩展」→ 指向扩展目录；' + #13#10 +
             '然后运行开始菜单里的「RecallFlow 修复宿主注册」。', mbInformation, MB_OK)
    else if (RegisterExitCode <> 0) and (RegisterExitCode <> -1) then
      MsgBox('宿主注册未成功（退出码 ' + IntToStr(RegisterExitCode) + '）。' + #13#10 + #13#10 +
             '可运行开始菜单里的「RecallFlow 修复宿主注册」重试，日志见 %LOCALAPPDATA%\RecallFlow\logs。', mbError, MB_OK);
  end;
end;
