# PC（Windows PowerShell）で、提供 ZIP を会話に添付できる大きさ（既定 20 MB）に分割し、SHA-256 の一覧を作る。
#   powershell -ExecutionPolicy Bypass -File tools\frames-2d\split_zip.ps1 -Zip C:\path\seipai_transparent_412frames.zip
# 出力: 同じフォルダに <名前>.part001, .part002, … と <名前>.sha256.txt（元の ZIP と各部分の SHA-256）
# 元の ZIP は変更しない。分割した部分と .sha256.txt をすべて渡し、受け取り側で join_parts.py を実行する。
param([Parameter(Mandatory=$true)][string]$Zip, [int]$PartMB = 20)
$src = Get-Item $Zip
$size = $PartMB * 1MB
$fs = [System.IO.File]::OpenRead($src.FullName)
$buf = New-Object byte[] $size
$k = 0
$lines = @("whole $((Get-FileHash $src.FullName -Algorithm SHA256).Hash.ToLower()) $($src.Name) $($src.Length)")
try {
  while (($n = $fs.Read($buf, 0, $size)) -gt 0) {
    $k++
    $part = "{0}.part{1:D3}" -f $src.FullName, $k
    $out = [System.IO.File]::Create($part)
    $out.Write($buf, 0, $n); $out.Close()
    $lines += "part $((Get-FileHash $part -Algorithm SHA256).Hash.ToLower()) $(Split-Path $part -Leaf) $n"
  }
} finally { $fs.Close() }
$lines | Set-Content -Encoding ascii ("{0}.sha256.txt" -f $src.FullName)
Write-Host "$k parts + sha256 list written next to $($src.Name)"
