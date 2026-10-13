// RecallFlow native messaging 启动器。
//
// 作用：把浏览器创建的 stdin/stdout 管道原样交给 node 运行的 host.js。
//
// 为什么要这一层：
//   1. Chrome/Edge 在 Windows 上启动 native host 走 CreateProcess，manifest 的 path 必须是可执行文件；
//   2. 宿主必须拿到**浏览器创建的管道**，而这是 4 字节长度前缀的二进制协议 ——
//      任何一层用 StreamReader/StreamWriter 逐行转发都会把帧写坏（编码转换 + 换行翻译），
//      所以这里全程操作 BaseStream，做字节级透传。
//
// 设计要点：**本 exe 与机器无关**（2026-10 改）。
//   以前是安装时把 node 路径与 host.js 路径烘焙进字符串 —— 那样安装器必须在每台机器上用 csc 编译一次，
//   而且换个目录就得重编。现在改成运行时解析：
//     1) 同目录的 launcher.config（纯文本，前两行非注释内容 = node 路径、host.js 路径）→ 仓储开发态用；
//     2) 同目录的 node.exe + host.js → 发行包布局（扁平目录，见 scripts/build-dist.mjs）；
//     3) 同目录 ..\host.js（仓储里 exe 在 native-host\bin\ 下）+ PATH 里的 node → 兜底。
//   于是编译一次即可到处发，用户机器不需要任何编译器。
//
// 失败时把原因写进 stderr 与 %LOCALAPPDATA%\RecallFlow\logs\launcher.log，并以非零码退出；
// 浏览器侧表现为 onDisconnect + lastError（"Native host has exited."），扩展会把它显示在设置页。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;

internal static class Launcher
{
    private static string BaseDir()
    {
        try
        {
            return AppDomain.CurrentDomain.BaseDirectory;
        }
        catch (Exception)
        {
            return Directory.GetCurrentDirectory();
        }
    }

    private static string LogFile()
    {
        try
        {
            var baseDir = Environment.GetEnvironmentVariable("LOCALAPPDATA");
            if (string.IsNullOrEmpty(baseDir)) baseDir = Path.GetTempPath();
            var dir = Path.Combine(baseDir, "RecallFlow", "logs");
            Directory.CreateDirectory(dir);
            return Path.Combine(dir, "launcher.log");
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static void Log(string message)
    {
        try
        {
            var file = LogFile();
            if (file == null) return;
            File.AppendAllText(file, "[" + DateTime.UtcNow.ToString("o") + "] " + message + Environment.NewLine);
        }
        catch (Exception) { }
    }

    /// 读取同目录 launcher.config 的前两行有效内容（# 视为注释）。
    private static List<string> ReadConfig(string dir)
    {
        var values = new List<string>();
        try
        {
            var path = Path.Combine(dir, "launcher.config");
            if (!File.Exists(path)) return values;
            foreach (var raw in File.ReadAllLines(path))
            {
                var line = raw.Trim();
                if (line.Length == 0 || line.StartsWith("#")) continue;
                values.Add(line);
            }
        }
        catch (Exception) { }
        return values;
    }

    private static string ResolveNode(string dir, List<string> cfg)
    {
        if (cfg.Count >= 1 && File.Exists(cfg[0])) return cfg[0];
        var local = Path.Combine(dir, "node.exe");
        if (File.Exists(local)) return local;
        return "node"; // 交给 PATH；找不到时 Process.Start 会抛，错误信息里能看到路径
    }

    private static string ResolveHostJs(string dir, List<string> cfg)
    {
        if (cfg.Count >= 2 && File.Exists(cfg[1])) return cfg[1];
        var flat = Path.Combine(dir, "host.js");
        if (File.Exists(flat)) return flat;
        try
        {
            var parent = Path.GetFullPath(Path.Combine(dir, ".."));
            var repo = Path.Combine(parent, "host.js");
            if (File.Exists(repo)) return repo;
        }
        catch (Exception) { }
        return flat; // 不存在也要给个确定路径，便于日志里看出错在哪
    }

    private static int Main(string[] args)
    {
        var dir = BaseDir();
        var cfg = ReadConfig(dir);
        var nodePath = ResolveNode(dir, cfg);
        var hostJs = ResolveHostJs(dir, cfg);
        Log("launcher 启动：dir=" + dir + " node=" + nodePath + " host=" + hostJs + " args=" + string.Join(" ", args));

        var psi = new ProcessStartInfo
        {
            FileName = nodePath,
            Arguments = "\"" + hostJs + "\"",
            WorkingDirectory = Path.GetDirectoryName(hostJs),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };

        Process child;
        try
        {
            child = Process.Start(psi);
        }
        catch (Exception ex)
        {
            Log("启动 node 失败：" + ex.Message + "（node=" + nodePath + " host=" + hostJs + "）");
            Console.Error.WriteLine("[recallflow-native-host] 无法启动 node：" + ex.Message + "（路径 " + nodePath + "）");
            return 3;
        }

        if (child == null)
        {
            Log("Process.Start 返回 null");
            Console.Error.WriteLine("[recallflow-native-host] 无法启动 node（Process.Start 返回 null）");
            return 3;
        }

        // 三条流各一个泵线程；入向泵结束后要关闭子进程 stdin，node 才会收到 EOF 正常退出。
        var toChild = Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream, true);
        var toBrowser = Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput(), false);
        var errToBrowser = Pump(child.StandardError.BaseStream, Console.OpenStandardError(), false);

        child.WaitForExit();
        Log("node 退出，exitCode=" + child.ExitCode);
        toBrowser.Join(1000);
        errToBrowser.Join(1000);
        toChild.Join(1000);
        return child.ExitCode;
    }

    private static Thread Pump(Stream from, Stream to, bool closeTargetAtEnd)
    {
        var t = new Thread(delegate ()
        {
            try
            {
                var buf = new byte[8192];
                int n;
                while ((n = from.Read(buf, 0, buf.Length)) > 0)
                {
                    to.Write(buf, 0, n);
                    to.Flush();
                }
            }
            catch (Exception) { /* 对端关闭：正常结束路径，不当作错误 */ }
            finally
            {
                try { to.Flush(); } catch (Exception) { }
                if (closeTargetAtEnd)
                {
                    try { to.Close(); } catch (Exception) { }
                }
            }
        });
        t.IsBackground = true;
        t.Start();
        return t;
    }
}
