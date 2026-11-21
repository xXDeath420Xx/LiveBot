<#
  Builds whisper.cpp for CertiFried Studio's voice commands (0.2.12), on the Windows build PC only.

  Output:
    src\voice\whisper\            whisper-server.exe, whisper.dll, ggml.dll, ggml-base.dll and the processor backends
                                  ggml-cpu-*.dll (one per x64 CPU family), plus the Visual C++ runtime DLLs (app-local,
                                  Microsoft's redistributable files) that they and onnxruntime need. Shipped in the installer.
    <Work>\CertiFried-Studio-Voice-CUDA-<tag>.zip
                                  ggml-cuda.dll alone (88 MB, too big for the installer). Published next to the installers;
                                  Studio downloads it on first use and checks it against GPU_BACKEND.sha256 in
                                  src\main\whisper-engine.js, so put the zip's SHA-256 and size there whenever this is rebuilt.

  Needs: Visual Studio 2022 with the C++ workload, CMake, Ninja (github.com/ninja-build/ninja), Windows' tar.exe, internet.
  CUDA comes from NVIDIA's redistributable archives (no installer): nvcc, cudart, cuBLAS and CCCL 12.9, checked against
  NVIDIA's redistrib_12.9.1.json. Architectures: 75-virtual (PTX for Turing and anything newer), 86, 89 and 120a native
  (RTX 30, 40 and 50 / Blackwell; 120a needs CUDA 12.8 or later).

  .\scripts\build-whisper.ps1 -Work C:\build\whisper [-Tag v1.9.5]
#>
param(
    [Parameter(Mandatory = $true)][string]$Work,
    [string]$Tag = 'v1.9.5',
    [string]$PackTag = '1.9.5-cu12.9-b1'
)
$ErrorActionPreference = 'Stop'
$studio = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Force $Work | Out-Null
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'

# CUDA 12.9 from NVIDIA's redistributable archives
$redist = 'https://developer.download.nvidia.com/compute/cuda/redist/'
$manifest = Invoke-RestMethod "${redist}redistrib_12.9.1.json"
$cuda = Join-Path $Work 'cuda'
New-Item -ItemType Directory -Force $cuda | Out-Null
foreach ($name in 'cuda_nvcc', 'cuda_cudart', 'libcublas', 'cuda_cccl') {
    $item = $manifest.$name.'windows-x86_64'
    $zip = Join-Path $Work (Split-Path -Leaf $item.relative_path)
    if (-not (Test-Path $zip)) { Invoke-WebRequest "$redist$($item.relative_path)" -OutFile $zip }
    if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $item.sha256) { throw "$zip does not match NVIDIA's checksum" }
    $x = Join-Path $Work "x-$name"
    New-Item -ItemType Directory -Force $x | Out-Null
    & $tar -xf $zip -C $x
    Get-ChildItem $x -Directory | ForEach-Object { Copy-Item "$($_.FullName)\*" $cuda -Recurse -Force }
}

# whisper.cpp at the tag
$src = Join-Path $Work 'whisper-src'
if (-not (Test-Path $src)) { git clone --depth 1 --branch $Tag https://github.com/ggml-org/whisper.cpp.git $src }
$build = Join-Path $Work 'build'
$vcvars = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -find 'VC\Auxiliary\Build\vcvars64.bat'
$cmd = @"
call "$vcvars" >nul && set "CUDA_PATH=$cuda" && set "PATH=$cuda\bin;%PATH%" && ^
cmake -S "$src" -B "$build" -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_CUDA_COMPILER="$cuda\bin\nvcc.exe" -DCUDAToolkit_ROOT="$cuda" ^
 -DGGML_CUDA=ON -DGGML_NATIVE=OFF -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON -DBUILD_SHARED_LIBS=ON "-DCMAKE_CUDA_ARCHITECTURES=75-virtual;86-real;89-real;120a-real" ^
 -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_TESTS=OFF -DWHISPER_SDL2=OFF -DWHISPER_CURL=OFF -DWHISPER_FFMPEG=OFF && ^
cmake --build "$build" --target whisper-server ggml-cuda -j 16
"@
cmd /c $cmd
if ($LASTEXITCODE -ne 0) { throw 'build failed' }

# into the app: everything but the CUDA backend
$out = Join-Path $studio 'src\voice\whisper'
New-Item -ItemType Directory -Force $out | Out-Null
$bin = Join-Path $build 'bin'
Copy-Item "$bin\whisper-server.exe", "$bin\whisper.dll", "$bin\ggml.dll", "$bin\ggml-base.dll" $out -Force
Copy-Item "$bin\ggml-cpu-*.dll" $out -Force
Copy-Item (Join-Path $src 'LICENSE') (Join-Path $out 'LICENSE.whisper.cpp.txt') -Force
$redistDir = Get-ChildItem "$(Split-Path (Split-Path (Split-Path (Split-Path $vcvars))))\Redist\MSVC" -Directory | Where-Object Name -match '^14\.' | Sort-Object Name | Select-Object -Last 1
Copy-Item "$($redistDir.FullName)\x64\Microsoft.VC143.CRT\msvcp140.dll", "$($redistDir.FullName)\x64\Microsoft.VC143.CRT\msvcp140_1.dll", "$($redistDir.FullName)\x64\Microsoft.VC143.CRT\msvcp140_atomic_wait.dll", "$($redistDir.FullName)\x64\Microsoft.VC143.CRT\vcruntime140.dll", "$($redistDir.FullName)\x64\Microsoft.VC143.CRT\vcruntime140_1.dll", "$($redistDir.FullName)\x64\Microsoft.VC143.OpenMP\vcomp140.dll" $out -Force

# the graphics card pack
$pack = Join-Path $Work "CertiFried-Studio-Voice-CUDA-$PackTag.zip"
Push-Location $bin
& $tar -a -cf $pack ggml-cuda.dll
Pop-Location
$h = (Get-FileHash $pack -Algorithm SHA256).Hash.ToLower()
"$pack`n  size $((Get-Item $pack).Length)`n  sha256 $h`nPut these in GPU_BACKEND (src\main\whisper-engine.js)."
