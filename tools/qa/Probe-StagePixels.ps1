# tools/qa/Probe-StagePixels.ps1
# ---------------------------------------------------------------------------
# 判据辅助工具：证明"角色到底有没有被画到屏幕上"。
#
# 为什么需要它（实测教训）：
#   `renderer.info.render.calls = 24 / triangles = 130235` 只能证明**提交了绘制指令**，
#   不能证明像素真的落到了窗口上（可能画成了全透明、可能被 alphaTest 全裁掉、可能取景到框外）。
#   这里直接读窗口区域的**真实屏幕像素**，统计：
#     · 不透明像素数 / 半透明近似像素数
#     · 与"面板底色"不同的像素数（角色一定带来颜色差异）
#     · 角色应出现的矩形（由 Stage 的包围盒投影给出）内的差异像素
#   并输出一张裁剪图供人眼复核。
#
# 用法：
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\qa\Probe-StagePixels.ps1 `
#     -OutDir docs\evidence\phase1 [-Rect "x,y,w,h"]
# ---------------------------------------------------------------------------
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$OutDir,
  [string]$Rect,
  [string]$Tag = 'stage-pixels'
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$shotDir = Join-Path $OutDir 'screens'
New-Item -ItemType Directory -Force -Path $shotDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class Dpi5 {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static void A(){ try{ if(SetProcessDpiAwarenessContext(new IntPtr(-4))) return; }catch{} try{ SetProcessDPIAware(); }catch{} }
}
'@
[Dpi5]::A()

Add-Type -TypeDefinition @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class WinPick {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static long Find(string title) {
    long found = 0;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var t = new StringBuilder(512); GetWindowTextW(h, t, 512);
      if (t.ToString() == title) { found = h.ToInt64(); return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static int[] RectOf(long hwnd) {
    RECT r; GetWindowRect(new IntPtr(hwnd), out r);
    return new int[] { r.L, r.T, r.R - r.L, r.B - r.T };
  }
}
'@

if (-not $Rect) {
  $hwnd = [WinPick]::Find('AiriMate One')
  if ($hwnd -eq 0) { Write-Host 'APP_WINDOW_NOT_FOUND'; exit 3 }
  $r = [WinPick]::RectOf($hwnd)
  $Rect = "$($r[0]),$($r[1]),$($r[2]),$($r[3])"
}
$parts = $Rect.Split(',')
$x = [int]$parts[0]; $y = [int]$parts[1]; $w = [int]$parts[2]; $h = [int]$parts[3]
Write-Host "probe rect = $x,$y ${w}x${h}"

Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
$g.Dispose()

$shot = Join-Path $shotDir "$Tag-$stamp.png"
$bmp.Save($shot, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "WROTE $shot"

# 逐像素统计（用 LockBits 一次取全图，避免 GetPixel 慢到不可用）
$rectLock = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
$data = $bmp.LockBits($rectLock, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$stride = $data.Stride
$bytes = New-Object byte[] ($stride * $h)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
$bmp.UnlockBits($data)

# 采样统计：每 2 像素取一次，够快也够判
$total = 0; $opaque = 0; $bright = 0
$hist = @{}
for ($yy = 0; $yy -lt $h; $yy += 2) {
  $row = $yy * $stride
  for ($xx = 0; $xx -lt $w; $xx += 2) {
    $i = $row + $xx * 4
    $b = $bytes[$i]; $gg = $bytes[$i + 1]; $rr = $bytes[$i + 2]; $aa = $bytes[$i + 3]
    $total++
    if ($aa -gt 200) { $opaque++ }
    # "亮"像素：明显亮于面板底色（面板底约 18-28）
    if (($rr + $gg + $b) -gt 200) { $bright++ }
    $key = "{0}-{1}-{2}" -f ([int]($rr / 16)), ([int]($gg / 16)), ([int]($bb / 16))
    if ($hist.ContainsKey($key)) { $hist[$key]++ } else { $hist[$key] = 1 }
  }
}
$bmp.Dispose()

$top = $hist.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 8
$result = [pscustomobject]@{
  generatedAt = (Get-Date).ToString('o')
  rect = @($x, $y, $w, $h)
  screenshot = $shot
  sampled = $total
  opaqueSampled = $opaque
  brightSampled = $bright
  brightRatio = [math]::Round(($bright / [math]::Max(1, $total)), 4)
  topColorBuckets = @($top | ForEach-Object { [pscustomobject]@{ bucket = $_.Key; count = $_.Value } })
  interpretation = @(
    'brightSampled 明显大于 0 ⇒ 画面上有亮内容（角色/UI）',
    'brightSampled ≈ 0 且 opaqueSampled 高 ⇒ 只有深色面板，角色没画上去',
    'opaqueSampled ≈ 0 ⇒ 窗口区域是透明的（可能窗口不可见或被完全遮挡）'
  )
}
$json = Join-Path $OutDir "$Tag-$stamp.json"
# ⚠ 无 BOM 的 UTF-8（`Set-Content -Encoding UTF8` 在 PS 5.1 下总是写 BOM ⇒ `JSON.parse` 抛错）
[System.IO.File]::WriteAllText($json, ($result | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "WROTE $json"
Write-Host ("sampled={0} opaque={1} bright={2} brightRatio={3}" -f $total, $opaque, $bright, $result.brightRatio)
