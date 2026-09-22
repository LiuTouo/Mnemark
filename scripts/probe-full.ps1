# Full-window kHz poller regression loop for the panel title-bar flash.
# Captures the panel window at kHz around hotkey toggles; run then: node scripts/verdict.mjs
param([int]$Cycles = 3, [string]$Exe = "src-tauri\target\debug\mnemark.exe")
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class P3 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public delegate bool EnumCb(IntPtr h, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCb cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowRgnBox(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inp, int size);
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public int type; public KEYBDINPUT ki; public int pad; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr ext; }
  public static IntPtr Found;
  public static IntPtr FindByPidTitle(uint pid, string title) {
    Found = IntPtr.Zero;
    EnumWindows((h, lp) => {
      uint wp; GetWindowThreadProcessId(h, out wp);
      if (wp != pid) return true;
      int len = GetWindowTextLength(h);
      var sb = new System.Text.StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      if (sb.ToString() == title) { Found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return Found;
  }
  public static void Key(ushort vk, bool up) {
    var inp = new INPUT[1];
    inp[0].type = 1;
    inp[0].ki.wVk = vk;
    if (up) inp[0].ki.dwFlags = 0x2;
    SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void Hotkey() {
    Key(0x11, false); Key(0x10, false); Key(0x56, false);
    Key(0x56, true);  Key(0x10, true);  Key(0x11, true);
  }
}

public static class Poll2 {
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  public static volatile bool StyleRun;
  public static long StyleT0;
  public static IntPtr StyleHwnd;
  public static readonly List<long> StyleT = new List<long>();
  public static readonly List<int> StyleV = new List<int>();
  public static void StartStyle(IntPtr hwnd) {
    StyleHwnd = hwnd; StyleRun = true;
    var th = new Thread(() => {
      while (StyleRun) {
        int s = GetWindowLong(hwnd, -16);
        lock (StyleT) { if (StyleT.Count == 0 || StyleV[StyleV.Count - 1] != s) { StyleT.Add(Ms() - T0); StyleV.Add(s); } }
      }
    });
    th.IsBackground = true; th.Priority = ThreadPriority.Highest; th.Start();
  }
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
  [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr d, int x, int y, int w, int h, IntPtr s, int sx, int sy, uint rop);
  [DllImport("gdi32.dll")] public static extern int GetBitmapBits(IntPtr hb, int cb, byte[] buf);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);

  public class Ev { public long t; public string name; }
  public class S { public long t; public byte[] bgr; public int idx; public string tag; }
  public static volatile bool Running;
  public static volatile bool Force;
  public static long T0;
  public static readonly List<Ev> Marks = new List<Ev>();
  public static readonly List<S> Snaps = new List<S>();
  public static int W, H;
  static byte[] Prev;
  static long Ms() { return (long)(System.Diagnostics.Stopwatch.GetTimestamp() * 1000 / System.Diagnostics.Stopwatch.Frequency); }
  public static void Mark_(string n) { lock (Marks) Marks.Add(new Ev { t = Ms(), name = n }); }

  public static void Start(int x, int y, int w, int h) {
    W = w; H = h; Running = true; T0 = Ms();
    Mark_("poller-start");
    var th = new Thread(() => {
      var sdc = GetDC(IntPtr.Zero);
      var mdc = CreateCompatibleDC(sdc);
      var hbmp = CreateCompatibleBitmap(sdc, w, h);
      SelectObject(mdc, hbmp);
      var buf = new byte[w * h * 4];
      int idx = 0;
      while (Running) {
        bool take = Force;
        if (BitBlt(mdc, 0, 0, w, h, sdc, x, y, 0x00CC0020)) {
          GetBitmapBits(hbmp, buf.Length, buf);
          bool changed = take || Prev == null;
          if (!changed && Prev != null) {
            for (int p = 0; p < w * h; p += 7) {
              if (Math.Abs(buf[p * 4 + 2] - Prev[p * 4 + 2]) > 6) { changed = true; break; }
            }
          }
          if (changed && Snaps.Count < 500) {
            Snaps.Add(new S { t = Ms(), bgr = (byte[])buf.Clone(), idx = idx++ });
            Prev = (byte[])buf.Clone();
            Force = false;
          }
        }
      }
      DeleteObject(hbmp); DeleteDC(mdc); ReleaseDC(IntPtr.Zero, sdc);
    });
    th.IsBackground = true;
    th.Priority = ThreadPriority.Highest;
    th.Start();
  }
  public static void ForceSnap() { Force = true; System.Threading.Thread.Sleep(60); }
  public static void Stop() { Running = false; Thread.Sleep(150); }
}
"@

Get-Process mnemark -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 400
$dir = Split-Path (Resolve-Path $Exe)
Set-Content -Path (Join-Path $dir "mnemark.config.json") -Value '{"tutorial_version":9999,"persist":false,"auto_update":false,"hotkey":"Ctrl+Shift+V","ui_scale_percent":100}' -Encoding ascii
$proc = Start-Process -FilePath (Resolve-Path $Exe) -ArgumentList "--hidden" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 3
$sw = [P3]::GetSystemMetrics(0); $sh = [P3]::GetSystemMetrics(1)
[P3]::SetCursorPos([int]($sw/2), [int]($sh/2)) | Out-Null
[P3]::Hotkey()
$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 100 -and $hwnd -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 50; $hwnd = [P3]::FindByPidTitle($proc.Id, "Mnemark") }
if ($hwnd -eq [IntPtr]::Zero) { Stop-Process -Id $proc.Id -Force; throw "panel not found" }
Start-Sleep -Milliseconds 1200
$wr = New-Object P3+RECT; [P3]::GetWindowRect($hwnd, [ref]$wr) | Out-Null
$swid = $wr.R - $wr.L; $shgt = $wr.B - $wr.T
Write-Host "[full] window ($($wr.L),$($wr.T)) ${swid}x${shgt}"
[P3]::Hotkey()
Start-Sleep -Milliseconds 800

[Poll2]::Start($wr.L, $wr.T, $swid, $shgt)
for ($c = 0; $c -lt $Cycles; $c++) {
  [P3]::SetCursorPos([int]($sw/2), [int]($sh/2)) | Out-Null
  Start-Sleep -Milliseconds 150
  [Poll2]::ForceSnap()
  [Poll2]::Mark_("hid-ref-$c")
  Start-Sleep -Milliseconds 100
  [Poll2]::Mark_("show-$c")
  [P3]::Hotkey()
  Start-Sleep -Milliseconds 900
  [Poll2]::ForceSnap()
  [Poll2]::Mark_("open-ref-$c")
  Start-Sleep -Milliseconds 100
  [Poll2]::Mark_("hide-$c")
  [P3]::Hotkey()
  Start-Sleep -Milliseconds 900
  [Poll2]::ForceSnap()
  [Poll2]::Mark_("hid-settle-$c")
}
[Poll2]::Mark_("end")
[Poll2]::Stop()
Stop-Process -Id $proc.Id -Force

$frameDir = Join-Path $PWD "target\full-frames"
New-Item -ItemType Directory -Force -Path $frameDir | Out-Null
Remove-Item "$frameDir\*" -ErrorAction SilentlyContinue
$marks = @(); foreach ($m in [Poll2]::Marks) { $marks += , @([string]$m.name, ([long]$m.t - [long][Poll2]::T0)) }
$snaps = @()
foreach ($s in [Poll2]::Snaps) {
  [IO.File]::WriteAllBytes((Join-Path $frameDir ("frame-{0:d3}.bgrx" -f $s.idx)), $s.bgr)
  $snaps += , @(([long]$s.t - [long][Poll2]::T0), [int]$s.idx)
}
@{ w = $swid; h = $shgt; marks = $marks; snaps = $snaps } | ConvertTo-Json -Compress -Depth 4 | Set-Content (Join-Path $PWD "target\full-log.json") -Encoding ascii
Write-Host ("[full] {0} snaps" -f $snaps.Count)
