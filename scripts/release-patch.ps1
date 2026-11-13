# Local patch release (temporary Actions-quota saver).
#
# Builds and publishes a Mnemark release from this machine while
# .github/workflows/release.yml is on workflow_dispatch only:
#   bump -> CHANGELOG -> gates -> commit/tag -> signed tauri build ->
#   portable exe + signed manifest -> GitHub release via gh.
#
# Usage:
#   npm run release                      # next patch of the Cargo.toml version
#   npm run release -- -Version 0.9.0    # explicit version
#   npm run release -- -DryRun           # preflight + plan, no mutations
#
# Requires in the current shell env (the key lives only in GitHub secrets,
# see docs/release-key-rotation.md — never put it in a file inside the repo):
#   $env:TAURI_SIGNING_PRIVATE_KEY = "<minisign private key text>"
#   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<password>"
#
# Resume behavior: if the script stops after bump (CHANGELOG unfilled), fill
# CHANGELOG.md and re-run the same command — bump is idempotent. Unrelated
# dirty/untracked files are allowed as long as they cannot affect the build
# (anything under src/ or src-tauri/, or root build inputs, must be clean —
# the binaries are built from this tree and must match the tag). Commit and
# tag steps are idempotent too: a run that stopped after tagging resumes
# cleanly. If the script stops after the tag was pushed, finish the upload
# manually: gh release create v<ver> ... <files>.
param(
    [string]$Version = "",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

# PS 5.1 Get-Content/Set-Content default to ANSI for BOM-less files, which
# corrupts UTF-8 Chinese text. Use .NET IO with explicit UTF-8 (no BOM).
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Assert-NativeExit([string]$Name) {
    if ($LASTEXITCODE -ne 0) { throw "$Name failed (exit $LASTEXITCODE)" }
}

# ---------- preflight ----------
$problems = @()
# The push and tag below hardcode the mainline branch; refuse to release
# from anywhere else (also catches detached HEAD, which reports "").
$branch = git branch --show-current
if ($branch -ne "main") {
    $problems += "Release must run from 'main' (current branch: '$branch')"
}
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    $problems += "gh CLI not found"
} else {
    gh auth status 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { $problems += "gh is not authenticated (gh auth login)" }
}
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    $problems += "TAURI_SIGNING_PRIVATE_KEY not set in this shell (export from GitHub secrets, docs/release-key-rotation.md)"
}
# Empty password is a valid configuration (keys without a password); only the
# key itself is mandatory. Encrypted keys fail later with a clear error.
if ($null -eq $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -or "" -eq $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
    Write-Host "Note: TAURI_SIGNING_PRIVATE_KEY_PASSWORD not set - OK for keys without a password."
}

# ---------- version resolution ----------
$cargoPath = "src-tauri/Cargo.toml"
$current = (Select-String -Path $cargoPath -Pattern '^version = "([^"]+)"').Matches[0].Groups[1].Value
if (-not $current) { throw "Could not find package version in $cargoPath" }

if ($Version -eq "") {
    $parts = $current.Split(".")
    $Version = "$($parts[0]).$($parts[1]).$([int]$parts[2] + 1)"
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Version must be semver (e.g. 0.8.22), got: $Version"
}
$tag = "v$Version"
# Resume: an existing tag is acceptable only when it is already part of this
# branch's history (a previous run committed + tagged but stopped later).
if (git rev-parse -q --verify "refs/tags/$tag") {
    git merge-base --is-ancestor "refs/tags/$tag" HEAD
    if ($LASTEXITCODE -ne 0) { throw "Tag $tag already exists and is not on the current branch - refusing to resume" }
    Write-Host "Resuming: tag $tag already exists on this branch"
}

$changelogPath = "CHANGELOG.md"
$changelog = [System.IO.File]::ReadAllText($changelogPath, $utf8)
$hasSection = $changelog -match [regex]::Escape("## [$Version]")

# Bump output (resume mode: bump already ran in a previous attempt).
$bumpFiles = @("src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "package.json", "package-lock.json", "CHANGELOG.md")

if ($DryRun) {
    Write-Host "Dry run - no changes were made."
    Write-Host "  current version : $current"
    Write-Host "  release version : $Version ($tag)"
    Write-Host "  changelog section: $(if ($hasSection) { 'present' } else { 'would be created by npm run bump' })"
    if ($problems) {
        Write-Host ""
        Write-Host "Preflight problems (real run would throw):"
        $problems | ForEach-Object { Write-Host "  - $_" }
    } else {
        Write-Host "Preflight: gh auth OK, signing key env OK."
    }
    Write-Host ""
    Write-Host "Plan: npm run bump -> gates (vitest/fmt/clippy/cargo test) -> cargo check"
    Write-Host "      -> commit 'chore(release): $Version' + tag $tag -> npx tauri build (signed)"
    Write-Host "      -> portable exe + signed manifest + zip -> git push origin main $tag"
    Write-Host "      -> gh release create $tag with NSIS setup+sig, latest.json, portable exe+sig, manifest+sig, zip"
    exit 0
}

if ($problems) { $problems | ForEach-Object { Write-Host "PROBLEM: $_" }; throw "Preflight failed — fix the problems above and re-run." }

# ---------- bump (skip when resuming) ----------
if (-not $hasSection) {
    # The build happens from this working tree, so build-relevant paths must
    # be clean or the artifacts would not match the tag. Everything else
    # (docs, website/, agent-tooling dirs) is allowed and never committed.
    $buildRoots = @("src/", "src-tauri/", "index.html", "settings.html", "about.html", "tutorial.html", "vite.config.ts", "tsconfig.json")
    $dirty = @(git status --porcelain | ForEach-Object { $_.Substring(3) })
    $ambiguous = @($dirty | Where-Object { $bumpFiles -ccontains $_ })
    if ($ambiguous) { throw "These release files have uncommitted changes:`n$($ambiguous -join "`n")`nCommit or restore them before releasing." }
    $danger = @($dirty | Where-Object {
        $p = $_
        (@($buildRoots | Where-Object { $p.StartsWith($_) })).Count -gt 0
    })
    if ($danger) { throw "These changes affect the build and must be committed or stashed first (artifacts must match the tag):`n$($danger -join "`n")" }

    Write-Host "Bumping $current -> $Version"
    npm run bump -- $Version
    Assert-NativeExit "npm run bump"
} else {
    Write-Host "Resuming: $cargoPath and CHANGELOG already at $Version (bump skipped)"
}

# ---------- release notes ----------
$changelog = [System.IO.File]::ReadAllText($changelogPath, $utf8)
$m = [regex]::Match($changelog, "(?ms)^## \[$([regex]::Escape($Version))\].*?(?=^## \[|^\[\d|\z)")
if (-not $m.Success) { throw "CHANGELOG.md has no section for $Version" }
$notes = (($m.Value.Trim() -split "`r?`n") | Select-Object -Skip 1) -join "`n"
if ($notes -notmatch '(?m)^- ') {
    throw "CHANGELOG.md section [$Version] is an unfilled skeleton. Fill it in, save, and re-run this command (bump is skipped on re-run)."
}

# ---------- quality gates (same set as the A+B release job) ----------
Write-Host "Frontend tests"
npm test -- --run
Assert-NativeExit "npm test"

Write-Host "Check formatting"
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
Assert-NativeExit "cargo fmt"

Write-Host "Clippy (deny warnings)"
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
Assert-NativeExit "cargo clippy"

Write-Host "Rust tests"
cargo test --manifest-path src-tauri/Cargo.toml
Assert-NativeExit "cargo test"

# Cargo.lock must carry the bumped version (AGENTS.md release procedure).
cargo check --manifest-path src-tauri/Cargo.toml
Assert-NativeExit "cargo check"

# ---------- commit + tag ----------
git add -- $bumpFiles
git diff --cached --quiet -- $bumpFiles
if ($LASTEXITCODE -ne 0) {
    git commit -m "chore(release): $Version"
    Assert-NativeExit "git commit"
} else {
    Write-Host "Resuming: release commit for $Version already in history"
}
if (-not (git rev-parse -q --verify "refs/tags/$tag")) {
    git tag $tag
    Assert-NativeExit "git tag"
}

# ---------- signed build ----------
Write-Host "Building release bundle (this compiles the release profile; takes a while)"
npx tauri build
Assert-NativeExit "npx tauri build"

$bundle = "src-tauri/target/release/bundle"
$setup = Join-Path $bundle "nsis/Mnemark_${Version}_x64-setup.exe"
if (-not (Test-Path $setup)) { throw "NSIS setup not found: $setup" }
if (-not (Test-Path "$setup.sig")) { throw "Updater signature not found: $setup.sig (was the build signed?)" }
# tauri-action created latest.json in CI; a local tauri build does not, so
# generate it here. Shape mirrors the CI-generated file (checked against
# v0.8.21): the installed updater downloads this from the release assets.
# tauri's .sig file is already the base64-wrapped minisign text the updater
# expects — re-encoding it a second time yields an unparseable signature
# (this broke the v0.8.23 updater).
$sigB64 = [System.IO.File]::ReadAllText("$setup.sig", $utf8).Trim()
if (-not $sigB64.StartsWith("dW50cnVzdGVkIGNvbW1lbnQ6")) { throw "Unexpected .sig format: $setup.sig" }
$dlUrl = "https://github.com/LiuTouo/Mnemark/releases/download/$tag/Mnemark_${Version}_x64-setup.exe"
$platEntry = [ordered]@{ signature = $sigB64; url = $dlUrl }
$latestJson = [ordered]@{
    version   = $Version
    notes     = ""
    pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    platforms = [ordered]@{ "windows-x86_64" = $platEntry; "windows-x86_64-nsis" = $platEntry }
}
$latestPath = Join-Path $bundle "nsis/latest.json"
[System.IO.File]::WriteAllText($latestPath, ($latestJson | ConvertTo-Json -Depth 5), $utf8)

# ---------- portable exe + signed manifest (mirrors release.yml) ----------
$stage = Join-Path $env:TEMP "mnemark-release-$tag"
New-Item -ItemType Directory -Force $stage | Out-Null
Get-ChildItem $stage -Force | Remove-Item -Recurse -Force

$exeName = "Mnemark_${tag}_x64-portable.exe"
$exePath = Join-Path $stage $exeName
Copy-Item "src-tauri/target/release/mnemark.exe" $exePath

npx tauri signer sign $exePath
Assert-NativeExit "npx tauri signer sign (portable exe)"

$manifest = [ordered]@{
    repository   = "LiuTouo/Mnemark"
    version      = $Version
    channel      = "portable"
    architecture = "x86_64"
    file         = $exeName
    length       = (Get-Item $exePath).Length
    # .NET crypto, not Get-FileHash: that cmdlet fails to auto-load in some
    # local PS 5.1 environments (CI's pwsh 7 is unaffected).
    sha256       = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.IO.File]::ReadAllBytes($exePath))).Replace("-", "").ToLowerInvariant()
}
$manifestPath = "$exePath.manifest.json"
# UTF-8 without BOM — the backend verifies the raw bytes it parsed.
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Compress), $utf8)
npx tauri signer sign $manifestPath
Assert-NativeExit "npx tauri signer sign (manifest)"

$zipPath = Join-Path $stage "$exeName.zip"
Compress-Archive -Path $exePath -DestinationPath $zipPath -Force

# ---------- publish ----------
git push origin main $tag
Assert-NativeExit "git push"

$assets = @(
    $setup, "$setup.sig", $latestPath,
    $exePath, "$exePath.sig", $manifestPath, "$manifestPath.sig", $zipPath
)
gh release create $tag --title "Mnemark v$Version" --notes=$notes @assets
Assert-NativeExit "gh release create"

Write-Host ""
Write-Host "Released $tag. Assets: $($assets.Count) files uploaded."
Write-Host "Verify: https://github.com/LiuTouo/Mnemark/releases/tag/$tag"
