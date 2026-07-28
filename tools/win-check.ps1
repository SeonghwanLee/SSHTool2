<#
  SSHTool2 Windows 점검 스크립트
  ================================
  개발 장비가 리눅스라 Windows 타깃 컴파일과 실기 동작을 확인할 수 없다.
  이 스크립트를 Windows 에서 돌리고 결과 파일 하나만 넘기면 그 자리를 메운다.

  사용법 (저장소 루트에서):
      powershell -ExecutionPolicy Bypass -File tools\win-check.ps1

  옵션:
      -Full        NSIS 인스톨러까지 실제로 빌드하고 산출물 크기를 잰다(오래 걸림)
      -SkipRust    Rust 없이 환경·프런트만 점검
      -NoRedact    사용자 이름·경로를 가리지 않는다(기본은 가림)

  결과: tools\win-check-<날짜시각>.txt  ← 이 파일만 주면 된다.

  이 스크립트는 읽기만 한다. 설치하지 않고, 저장소를 고치지 않고, 커밋하지 않는다.
#>
param(
    [switch]$Full,
    [switch]$SkipRust,
    [switch]$NoRedact
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$stamp  = Get-Date -Format "yyyyMMdd-HHmmss"
$report = Join-Path $PSScriptRoot "win-check-$stamp.txt"
$buffer = New-Object System.Collections.ArrayList
$results = New-Object System.Collections.ArrayList

# 보고서에 사용자 이름과 홈 경로가 그대로 남지 않게 가린다.
function Hide-Private([string]$Text) {
    if ($NoRedact -or [string]::IsNullOrEmpty($Text)) { return $Text }
    $t = $Text
    if ($env:USERPROFILE) { $t = $t.Replace($env:USERPROFILE, "%USERPROFILE%") }
    if ($env:USERNAME)    { $t = $t.Replace($env:USERNAME, "%USERNAME%") }
    return $t
}

function Write-Log([string]$Text = "") {
    $t = Hide-Private $Text
    Write-Host $t
    [void]$buffer.Add($t)
}

# 단계마다 파일로 내보낸다 — 도중에 멈춰도 거기까지는 남아야 한다.
function Save-Report() {
    Set-Content -Path $report -Value $buffer -Encoding UTF8
}

function Get-Version([string]$Exe, [string]$VerArgs = "--version") {
    $cmd = Get-Command $Exe -ErrorAction SilentlyContinue
    if (-not $cmd) { return $null }
    try { return (& cmd /c "$Exe $VerArgs 2>&1" | Select-Object -First 1) }
    catch { return "(버전 확인 실패)" }
}

# 외부 명령 하나를 돌리고 출력·종료코드·소요시간을 기록한다.
# 출력이 길면 뒤쪽만 남긴다 — 컴파일 오류는 항상 끝에 나온다.
function Invoke-Step([string]$Title, [string]$Command, [int]$Tail = 400) {
    Write-Log ""
    Write-Log ("=" * 72)
    Write-Log "[$Title]"
    Write-Log "> $Command"
    Write-Log ("=" * 72)

    $sw = [Diagnostics.Stopwatch]::StartNew()
    $out = & cmd /c "$Command 2>&1"
    $code = $LASTEXITCODE
    $sw.Stop()

    if ($null -eq $out) { $out = @() }
    $lines = @($out)
    if ($lines.Count -gt $Tail) {
        Write-Log "… 앞부분 $($lines.Count - $Tail)줄 생략 (전체 $($lines.Count)줄) …"
        $lines = $lines[($lines.Count - $Tail)..($lines.Count - 1)]
    }
    foreach ($line in $lines) { Write-Log ([string]$line) }

    $secs = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    Write-Log "-- 종료코드 $code · ${secs}초"
    [void]$results.Add([pscustomobject]@{ Title = $Title; Code = $code; Secs = $secs })
    Save-Report
    return $code
}

# ── 1. 환경 ────────────────────────────────────────────────────────────────
Write-Log "SSHTool2 Windows 점검 보고서"
Write-Log "생성 시각: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Log "옵션: Full=$Full SkipRust=$SkipRust"
Write-Log ""
Write-Log ("=" * 72)
Write-Log "[환경]"
Write-Log ("=" * 72)

$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
Write-Log "OS         : $($os.Caption) $($os.Version) ($($os.OSArchitecture))"
Write-Log "PowerShell : $($PSVersionTable.PSVersion)"
Write-Log "CPU 코어   : $env:NUMBER_OF_PROCESSORS"
Write-Log "저장소     : $(Hide-Private $root)"

$tools = @(
    @{ Name = "node";   Args = "--version" },
    @{ Name = "npm";    Args = "--version" },
    @{ Name = "rustc";  Args = "--version" },
    @{ Name = "cargo";  Args = "--version" },
    @{ Name = "rustup"; Args = "--version" },
    @{ Name = "git";    Args = "--version" }
)
Write-Log ""
foreach ($t in $tools) {
    $v = Get-Version $t.Name $t.Args
    if ($v) { Write-Log ("{0,-10}: {1}" -f $t.Name, $v) }
    else    { Write-Log ("{0,-10}: 없음" -f $t.Name) }
}

# MSVC 링커 — Rust 의 windows-msvc 타깃이 이걸 쓴다. 없으면 컴파일이 링크 단계에서 막힌다.
$link = Get-Command link.exe -ErrorAction SilentlyContinue
if ($link) {
    Write-Log "link.exe  : 있음 ($(Hide-Private $link.Source))"
} else {
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vswhere) {
        $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
        if ($vs) { Write-Log "link.exe  : PATH 에는 없지만 VS 빌드도구 설치됨 ($(Hide-Private $vs))" }
        else     { Write-Log "link.exe  : 없음 — VS C++ 빌드도구 미설치" }
    } else {
        Write-Log "link.exe  : 없음 (vswhere 도 없음)"
    }
}

# WebView2 런타임 — 앱 실행에 필요. Win11 에는 기본 포함.
$wv = Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" -ErrorAction SilentlyContinue
if ($wv) { Write-Log "WebView2  : $($wv.pv)" } else { Write-Log "WebView2  : 레지스트리에서 못 찾음(설치돼 있어도 위치가 다를 수 있음)" }

# ── 2. 저장소 상태 ─────────────────────────────────────────────────────────
Write-Log ""
Write-Log ("=" * 72)
Write-Log "[저장소]"
Write-Log ("=" * 72)
if (Get-Command git -ErrorAction SilentlyContinue) {
    Write-Log "브랜치   : $(& cmd /c 'git rev-parse --abbrev-ref HEAD 2>&1')"
    Write-Log "커밋     : $(& cmd /c 'git log -1 --oneline 2>&1')"
    $dirty = & cmd /c "git status --porcelain 2>&1"
    if ($dirty) {
        Write-Log "변경사항 : 있음"
        foreach ($d in @($dirty)) { Write-Log "           $d" }
    } else {
        Write-Log "변경사항 : 없음(깨끗함)"
    }
} else {
    Write-Log "git 이 없어 건너뜀"
}
$pkg = Get-Content "package.json" -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
if ($pkg) { Write-Log "앱 버전  : $($pkg.version)" }
Save-Report

# ── 3. 프런트엔드 ──────────────────────────────────────────────────────────
if (-not (Test-Path "node_modules")) {
    Invoke-Step "의존성 설치 (npm ci)" "npm ci" | Out-Null
}
Invoke-Step "프런트 빌드 (tsc + vite)" "npm run build" | Out-Null

# ── 4. Rust ────────────────────────────────────────────────────────────────
if ($SkipRust) {
    Write-Log ""
    Write-Log "[Rust] -SkipRust 지정 — 건너뜀"
} elseif (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Log ""
    Write-Log ("=" * 72)
    Write-Log "[Rust] cargo 가 없어 건너뜀"
    Write-Log ("=" * 72)
    Write-Log "설치하려면:"
    Write-Log "  winget install Rustlang.Rustup"
    Write-Log "  winget install Microsoft.VisualStudio.2022.BuildTools"
    Write-Log "    → 설치 관리자에서 'C++를 사용한 데스크톱 개발' 워크로드 선택"
    Write-Log "  설치 후 새 터미널에서 이 스크립트를 다시 실행"
} else {
    # cargo check 는 코드 생성을 건너뛰어 빌드보다 훨씬 빠르면서 타입·차용 오류를 모두 잡는다.
    # 첫 실행은 의존성 463개를 훑느라 몇 분 걸린다. 두 번째부터는 짧다.
    Invoke-Step "Rust 검사 (cargo check)" `
        "cd src-tauri && cargo check --target x86_64-pc-windows-msvc --message-format short" | Out-Null
}

# ── 5. 전체 빌드(선택) ─────────────────────────────────────────────────────
if ($Full -and -not $SkipRust) {
    Invoke-Step "인스톨러 빌드 (tauri build)" `
        "npm run tauri build -- --target x86_64-pc-windows-msvc --bundles nsis" 600 | Out-Null

    Write-Log ""
    Write-Log ("=" * 72)
    Write-Log "[산출물 크기]"
    Write-Log ("=" * 72)
    $bundle = Get-ChildItem -Path "src-tauri\target" -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match "\\bundle\\" -and ($_.Extension -eq ".exe" -or $_.Extension -eq ".zip") }
    if ($bundle) {
        foreach ($f in $bundle) {
            Write-Log ("{0,-46} {1,8:N2} MB" -f $f.Name, ($f.Length / 1MB))
        }
    } else {
        Write-Log "번들 산출물을 찾지 못했습니다."
        $dirs = Get-ChildItem -Path "src-tauri\target" -Recurse -Directory -Filter "bundle" -ErrorAction SilentlyContinue
        foreach ($d in $dirs) { Write-Log "  $(Hide-Private $d.FullName)" }
    }
}

# ── 6. 요약 ────────────────────────────────────────────────────────────────
Write-Log ""
Write-Log ("=" * 72)
Write-Log "[요약]"
Write-Log ("=" * 72)
if ($results.Count -eq 0) {
    Write-Log "실행한 단계가 없습니다."
} else {
    foreach ($r in $results) {
        $mark = if ($r.Code -eq 0) { "성공" } else { "실패(코드 $($r.Code))" }
        Write-Log ("{0,-32} {1,-16} {2,7}초" -f $r.Title, $mark, $r.Secs)
    }
}
$failed = @($results | Where-Object { $_.Code -ne 0 }).Count
Write-Log ""
Write-Log $(if ($failed -eq 0) { "모든 단계 성공." } else { "$failed 개 단계 실패 — 위 로그의 해당 구간을 보세요." })

Save-Report
Write-Host ""
Write-Host "보고서를 저장했습니다: $report" -ForegroundColor Green
Write-Host "이 파일을 그대로 전달하면 됩니다." -ForegroundColor Green
