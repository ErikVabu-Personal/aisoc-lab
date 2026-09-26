# onboard_goad_endpoint.ps1 - install Sysmon + enable the audit subcategories
# that the AD-attack detections need, on a GOAD Windows host.
#
# Run via azurerm_virtual_machine_run_command (NOT a CustomScriptExtension -
# GOAD already uses a CSE on these VMs and only one is allowed per VM). Because
# run_command does not stage files, this script self-fetches Sysmon + its config.
# Idempotent: re-runs reload the Sysmon config and re-assert audit policy.
#
# Everything is logged to C:\ProgramData\AISOC\Sysmon\install.log.
#
# Terraform templatefile var: sysmon_config_url.

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

$logDir  = 'C:\ProgramData\AISOC\Sysmon'
$logFile = Join-Path $logDir 'install.log'
$cfgFile = Join-Path $logDir 'sysmonconfig.xml'
$workDir = Join-Path $logDir 'work'
$zipPath = Join-Path $workDir 'Sysmon.zip'
$exePath = 'C:\Windows\System32\Sysmon64.exe'

New-Item -ItemType Directory -Path $logDir -Force | Out-Null
New-Item -ItemType Directory -Path $workDir -Force | Out-Null

function Log([string]$msg) {
    $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    "$ts $msg" | Tee-Object -FilePath $logFile -Append
}

try {
    Log "=== onboard_goad_endpoint.ps1 starting ==="
    Log "OS: $((Get-CimInstance Win32_OperatingSystem).Caption)"

    # -----------------------------------------------------------------
    # Audit policy. The base set mirrors the aisoc-lab lab VM; the AD
    # block is what makes the GOAD detections possible:
    #   Kerberos Service Ticket Operations -> 4769/4770 (Kerberoasting)
    #   Kerberos Authentication Service    -> 4768/4771 (AS-REP roast, spray)
    #   Credential Validation              -> 4776       (NTLM spray)
    #   Directory Service Access           -> 4662       (DCSync)
    #   Directory Service Changes          -> 5136       (AD object changes)
    #   Certification Services             -> 4886-4899  (ADCS, on the CA host)
    # auditpol is local policy; on a DC a conflicting Advanced Audit GPO
    # could override it at the next gpupdate - note in the runbook.
    # -----------------------------------------------------------------
    Log "Configuring audit policy (auditpol.exe)..."
    $auditCommands = @(
        @('Logon',                             'enable', 'enable'),
        @('Logoff',                            'enable', 'enable'),
        @('Account Lockout',                   'enable', 'enable'),
        @('Special Logon',                     'enable', 'enable'),
        @('Process Creation',                  'enable', 'enable'),
        @('User Account Management',           'enable', 'enable'),
        @('Security Group Management',         'enable', 'enable'),
        @('Sensitive Privilege Use',           'enable', 'enable'),
        @('Kerberos Service Ticket Operations','enable', 'enable'),
        @('Kerberos Authentication Service',   'enable', 'enable'),
        @('Credential Validation',             'enable', 'enable'),
        @('Directory Service Access',          'enable', 'enable'),
        @('Directory Service Changes',         'enable', 'enable'),
        @('Certification Services',            'enable', 'enable')
    )
    foreach ($cmd in $auditCommands) {
        $sub = $cmd[0]; $succ = $cmd[1]; $fail = $cmd[2]
        $argList = @('/set', "/subcategory:$sub", "/success:$succ", "/failure:$fail")
        try {
            $out = & auditpol.exe @argList 2>&1
            Log ("  auditpol /subcategory:'{0}' -> {1}" -f $sub, ($out -join '; '))
        } catch {
            Log ("  WARN: auditpol failed for '{0}': {1}" -f $sub, $_.Exception.Message)
        }
    }

    # Command line in process-creation (4688).
    try {
        New-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System\Audit' `
                         -Name 'ProcessCreationIncludeCmdLine_Enabled' `
                         -Value 1 -PropertyType DWord -Force | Out-Null
        Log "Enabled command-line logging in EID 4688."
    } catch {
        Log "WARN: could not enable cmdline-in-4688: $($_.Exception.Message)"
    }

    # -----------------------------------------------------------------
    # Sysmon config + install.
    # -----------------------------------------------------------------
    Log "Downloading Sysmon config from ${sysmon_config_url}"
    Invoke-WebRequest -Uri '${sysmon_config_url}' -OutFile $cfgFile -UseBasicParsing -TimeoutSec 60
    $cfgKb = [math]::Round((Get-Item $cfgFile).Length / 1KB, 1)
    Log ("Sysmon config: {0} ({1} KB)" -f $cfgFile, $cfgKb)

    $sysmonService = Get-Service -Name 'Sysmon64' -ErrorAction SilentlyContinue
    if ($sysmonService -and (Test-Path $exePath)) {
        Log "Sysmon already installed ($($sysmonService.Status)) - reloading config"
        & $exePath -c $cfgFile 2>&1 | ForEach-Object { Log "[sysmon -c] $_" }
    } else {
        Log "Sysmon not installed - downloading + installing"
        Invoke-WebRequest -Uri 'https://download.sysinternals.com/files/Sysmon.zip' -OutFile $zipPath -UseBasicParsing -TimeoutSec 120
        Expand-Archive -Path $zipPath -DestinationPath $workDir -Force
        $stagedExe = Join-Path $workDir 'Sysmon64.exe'
        if (-not (Test-Path $stagedExe)) { throw "Sysmon64.exe not found in extracted zip" }
        Log "Running: Sysmon64.exe -accepteula -i"
        & $stagedExe -accepteula -i $cfgFile 2>&1 | ForEach-Object { Log "[sysmon -i] $_" }
        if (-not (Test-Path $exePath)) { throw "Sysmon -i did not place Sysmon64.exe in System32" }
        $svcAfter = Get-Service -Name 'Sysmon64' -ErrorAction SilentlyContinue
        if (-not $svcAfter) { throw "Sysmon64 service did not register after install" }
        Log "Sysmon installed; service status: $($svcAfter.Status)"
    }

    Log "=== onboard_goad_endpoint.ps1 done (success) ==="
    exit 0
}
catch {
    Log "ERROR: $($_.Exception.Message)"
    exit 1
}
