using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle("B1 Prep")]
[assembly: AssemblyDescription("Start B1 Prep Portable")]
[assembly: AssemblyProduct("B1 Prep Portable")]
[assembly: AssemblyVersion("1.0.0.0")]

internal static class Launcher
{
    [STAThread]
    private static int Main(string[] args)
    {
        // This check is intentionally silent and never starts the app or a browser.
        bool checkOnly = args.Length == 1 && args[0] == "--check";
        if (args.Length > 0 && !checkOnly) return 64;

        string root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string[] required = { "start.cmd", "portable-launcher.cjs", "server.js", @"runtime\node.exe" };
        foreach (string relative in required)
        {
            if (File.Exists(Path.Combine(root, relative))) continue;
            if (!checkOnly)
                MessageBox.Show("B1 Prep cannot find " + relative + ".\n\n" +
                    "Keep B1 Prep.exe inside the complete B1_Prep folder on your SSD.",
                    "B1 Prep", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 2;
        }
        if (checkOnly) return 0;

        try
        {
            var start = new ProcessStartInfo
            {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe"),
                // Resolve the sibling through WorkingDirectory: no fixed drive letter and
                // no interpolation of folder names into cmd.exe's command language.
                Arguments = "/d /s /c \"\".\\start.cmd\"\"",
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = false,
                WindowStyle = ProcessWindowStyle.Normal
            };
            using (Process process = Process.Start(start)) { }
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show("B1 Prep could not start.\n\n" + error.Message +
                "\n\nTry opening start.cmd in the same folder.",
                "B1 Prep", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
