# install_sysmon.ps1 — install Microsoft Sysinternals Sysmon on the
# lab VM with a verbose community config (SwiftOnSecurity).
#
# Invoked by the CustomScriptExtension VM extension defined in
# sysmon.tf. The extension downloads this script + sysmonconfig.xml
# from the GitHub raw URLs in `fileUris` and runs the script with
# `commandToExecute`.
#
# Idempotent: re-runs are safe. If Sysmon is already installed, the
# script reloads the config in place (`Sysmon64.exe -c <file>`)
# instead of failing.
#
# What gets installed:
#   - Sysmon64.exe (System32) — pulled from sysinternals.com
#   - SwiftOnSecurity sysmonconfig.xml (the config) — staged under
#     C:\ProgramData\AISOC\Sysmon\sysmonconfig.xml
#
# All output goes to C:\ProgramData\AISOC\Sysmon\install.log so the
# operator can check what happened by RDPing in.

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'  # avoid the slow PS progress UI

$logDir   = 'C:\ProgramData\AISOC\Sysmon'
$logFile  = Join-Path $logDir 'install.log'
$cfgFile  = Join-Path $logDir 'sysmonconfig.xml'
$workDir  = Join-Path $logDir 'work'
$zipPath  = Join-Path $workDir 'Sysmon.zip'
$exePath  = 'C:\Windows\System32\Sysmon64.exe'

New-Item -ItemType Directory -Path $logDir -Force | Out-Null
New-Item -ItemType Directory -Path $workDir -Force | Out-Null

function Log([string]$msg) {
    $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    "$ts $msg" | Tee-Object -FilePath $logFile -Append
}

try {
    Log "=== install_sysmon.ps1 starting ==="
    Log "PowerShell: $($PSVersionTable.PSVersion)"
    Log "OS: $((Get-CimInstance Win32_OperatingSystem).Caption)"

    # ---------------------------------------------------------------
    # Audit policy — enable the subcategories whose events we forward
    # to Sentinel. By default Windows 11 Pro has SOME logon auditing
    # but it's incomplete (e.g. Logoff is often Failure-only). Make
    # it explicit so the demo doesn't depend on whatever the OEM
    # baseline shipped.
    #
    # Reference EIDs we care about:
    #   4624 logon success         (Audit Logon)
    #   4625 logon failure         (Audit Logon)
    #   4634 logoff                (Audit Logoff)
    #   4672 special priv assigned (Audit Special Logon)
    #   4688 process create        (Audit Process Creation)
    #   4720 user account created  (Audit User Account Mgmt)
    #   4740 account locked out    (Audit Account Lockout)
    # auditpol writes to Local Security Policy and survives reboot.
    # All of these subcategories are advanced audit policy — enabling
    # them does NOT require GPO; auditpol.exe is sufficient.
    # ---------------------------------------------------------------
    Log "Configuring audit policy (auditpol.exe)..."
    $auditCommands = @(
        @('Logon',                    'enable', 'enable'),
        @('Logoff',                   'enable', 'enable'),
        @('Account Lockout',          'enable', 'enable'),
        @('Special Logon',            'enable', 'enable'),
        @('Process Creation',         'enable', 'enable'),
        @('Process Termination',      'enable', 'disable'),
        @('User Account Management',  'enable', 'enable'),
        @('Security Group Management','enable', 'enable'),
        @('Sensitive Privilege Use',  'enable', 'enable')
    )
    foreach ($cmd in $auditCommands) {
        $sub = $cmd[0]; $succ = $cmd[1]; $fail = $cmd[2]
        $argList = @('/set', "/subcategory:$sub", "/success:$succ", "/failure:$fail")
        try {
            $out = & auditpol.exe @argList 2>&1
            Log ("  auditpol /subcategory:'{0}' /success:{1} /failure:{2}  ->  {3}" -f $sub, $succ, $fail, ($out -join '; '))
        } catch {
            Log ("  WARN: auditpol failed for '{0}': {1}" -f $sub, $_.Exception.Message)
        }
    }

    # Process-creation EID 4688 carries the command line ONLY when
    # this registry value is set. Without it, you get the .exe path
    # but not the args — which is most of what you actually want for
    # detection. Idempotent.
    try {
        New-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System\Audit' `
                         -Name 'ProcessCreationIncludeCmdLine_Enabled' `
                         -Value 1 -PropertyType DWord -Force | Out-Null
        Log "Enabled command-line logging in EID 4688."
    } catch {
        Log "WARN: could not enable cmdline-in-4688: $($_.Exception.Message)"
    }

    # CustomScriptExtension stages fileUris into a working directory
    # we can find via the well-known plugin path. The sysmonconfig
    # XML is one of the URIs we passed in `settings.fileUris` —
    # depending on the upstream URL the file might be named
    # sysmonconfig.xml OR sysmonconfig-export.xml (the SwiftOnSecurity
    # repo's canonical name). Match both.
    $stagedConfig = $null
    $candidates = @()
    if ($env:AzureData_ScriptDirectory) { $candidates += $env:AzureData_ScriptDirectory }
    $candidates += (Get-ChildItem 'C:\Packages\Plugins\Microsoft.Compute.CustomScriptExtension\*\Downloads\*' -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
    $candidates += (Get-Location).Path
    $names = @('sysmonconfig.xml', 'sysmonconfig-export.xml')
    :outer foreach ($d in $candidates) {
        if (-not $d) { continue }
        foreach ($n in $names) {
            $maybe = Join-Path $d $n
            if (Test-Path $maybe) { $stagedConfig = $maybe; break outer }
        }
    }

    if ($stagedConfig) {
        Log "Found staged sysmonconfig.xml at $stagedConfig"
        Copy-Item -Path $stagedConfig -Destination $cfgFile -Force
    } else {
        # CSE didn't stage the file (or we couldn't find it) — fall
        # back to fetching from the SwiftOnSecurity GitHub raw URL.
        # This is the de facto community config: comprehensive but
        # filtered enough that endpoints don't drown.
        Log "No staged config found, downloading SwiftOnSecurity sysmonconfig.xml from GitHub"
        $configUrl = 'https://raw.githubusercontent.com/SwiftOnSecurity/sysmon-config/master/sysmonconfig-export.xml'
        Invoke-WebRequest -Uri $configUrl -OutFile $cfgFile -UseBasicParsing -TimeoutSec 60
    }

    $cfgKb = [math]::Round((Get-Item $cfgFile).Length / 1KB, 1)
    Log ("Sysmon config: {0} ({1} KB)" -f $cfgFile, $cfgKb)

    # Decide whether to install or just reload the config.
    $sysmonService = Get-Service -Name 'Sysmon64' -ErrorAction SilentlyContinue
    if ($sysmonService -and (Test-Path $exePath)) {
        Log "Sysmon already installed (service: $($sysmonService.Status)) — reloading config"
        & $exePath -c $cfgFile 2>&1 | ForEach-Object { Log "[sysmon -c] $_" }
        Log "Reload complete."
    } else {
        Log "Sysmon not installed — downloading + installing"
        $sysmonUrl = 'https://download.sysinternals.com/files/Sysmon.zip'
        Invoke-WebRequest -Uri $sysmonUrl -OutFile $zipPath -UseBasicParsing -TimeoutSec 120
        $zipMb = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
        Log ("Downloaded {0} ({1} MB)" -f $zipPath, $zipMb)

        Expand-Archive -Path $zipPath -DestinationPath $workDir -Force
        $stagedExe = Join-Path $workDir 'Sysmon64.exe'
        if (-not (Test-Path $stagedExe)) {
            throw "Sysmon64.exe not found in extracted zip: $workDir"
        }

        # -accepteula  — auto-accept Sysinternals EULA (one-time prompt)
        # -i <config>  — install the service AND apply the config
        Log "Running: $stagedExe -accepteula -i $cfgFile"
        & $stagedExe -accepteula -i $cfgFile 2>&1 | ForEach-Object { Log "[sysmon -i] $_" }

        # Sysmon -i copies itself to System32 and registers the service.
        # Verify both.
        if (-not (Test-Path $exePath)) {
            throw "Sysmon -i did not place Sysmon64.exe in System32"
        }
        $svcAfter = Get-Service -Name 'Sysmon64' -ErrorAction SilentlyContinue
        if (-not $svcAfter) {
            throw "Sysmon64 service did not register after install"
        }
        Log "Sysmon installed; service status: $($svcAfter.Status)"
    }

    # Sanity check — query a couple of recent Sysmon events to confirm
    # the channel is producing. Wrapped in its own try/catch so a
    # parser oddity here can never fail the whole install (Windows
    # PowerShell 5.1 is touchy about deeply-nested sub-expressions
    # inside double-quoted strings; use the -f format operator + the
    # -split operator instead of "$($x.y.z)").
    Start-Sleep -Seconds 5
    try {
        $recent = Get-WinEvent -LogName 'Microsoft-Windows-Sysmon/Operational' -MaxEvents 3 -ErrorAction SilentlyContinue
        if ($recent) {
            $count = ($recent | Measure-Object).Count
            Log ("Sysmon channel alive - {0} recent events" -f $count)
            foreach ($e in $recent) {
                $firstLine = ($e.Message -split "`r?`n")[0]
                Log ("  EID {0} @ {1}: {2}" -f $e.Id, $e.TimeCreated, $firstLine)
            }
        } else {
            Log "WARN: no Sysmon events visible yet - channel will populate as the host generates activity"
        }
    } catch {
        Log ("WARN: sanity-check query failed (non-fatal): {0}" -f $_.Exception.Message)
    }

    Log "=== install_sysmon.ps1 done (success) ==="
    exit 0
}
catch {
    Log "ERROR: $($_.Exception.Message)"
    Log "Stack: $($_.ScriptStackTrace)"
    exit 1
}
