# Endpoint telemetry — bridge workstation (`BRIDGE-WS`) + Sysmon

The bridge workstation (`BRIDGE-WS`) is a second monitored asset alongside the Ship
Control Panel. Endpoint telemetry from the VM lands in a different
Sentinel table (`Event`, not `ContainerAppConsoleLogs_CL`) and
exposes detail the Ship Control Panel logs can't.

Use this page when you need to pivot from a Ship-Control-Panel
event into "what was happening on the host at the same time", or
when an alert is purely host-side.

## What's collected, where it lands

Two channels merge into the `Event` table via the AMA agent + DCR:

1. **Windows Event Logs** — Application / System / Security at
   Levels 1–3 (Critical / Error / Warning) plus Security Level 4
   (Information — that's where audit events live, e.g. logon
   success / process creation auditing).
2. **Sysmon** — `Microsoft-Windows-Sysmon/Operational` channel.
   All Sysmon events are Level=4 by design. The host runs the
   SwiftOnSecurity verbose config, so the channel is
   comprehensive.

Both flow into the **`Event`** table. Distinguish them by the
`Source` field:

| Source | Channel | Notes |
|--------|---------|-------|
| `Application` / `System` / `Security` | Windows core channels | Standard Windows logging. |
| `Microsoft-Windows-Sysmon` | Sysmon Operational | Endpoint detection signal — what we look at first. |

## Base filter for endpoint queries

```kusto
Event
| where TimeGenerated > ago(1h)
| where Computer == "BRIDGE-WS"   // filter to the bridge workstation
```

For Sysmon-only:

```kusto
Event
| where TimeGenerated > ago(1h)
| where Source == "Microsoft-Windows-Sysmon"
```

The `RenderedDescription` column is the human-readable text Sysmon
emitted (process name, command line, file path, etc.) — quote it
verbatim in case notes when summarising what happened on the host.
For structured fields, parse `EventData` as XML:

```kusto
Event
| where Source == "Microsoft-Windows-Sysmon" and EventID == 1
| extend ed = parse_xml(EventData)
| extend Data = ed.DataItem.EventData.Data
| extend Image       = tostring(Data[4]["#text"])
| extend CommandLine = tostring(Data[10]["#text"])
| extend User        = tostring(Data[12]["#text"])
| extend ParentImage = tostring(Data[20]["#text"])
| project TimeGenerated, Computer, Image, CommandLine, User, ParentImage
| take 50
```

## Sysmon event IDs you'll see most

| EventID | Meaning | When to care |
|---------|---------|--------------|
| **1** | Process create | Anything unusual under Image, CommandLine, ParentImage. LOLBINS (cmd / powershell / wscript / mshta / rundll32) launching from suspicious parents. |
| **2** | File creation time changed | Timestomping — usually attacker tradecraft. |
| **3** | Network connection | Destination IP / port + initiating process. Useful for "who phoned out". |
| **5** | Process terminated | Crash investigations. |
| **7** | Image loaded | DLL side-loading patterns; `Signed=false` with a system-folder path is suspicious. |
| **8** | CreateRemoteThread | Process injection. High signal — almost always malicious outside of debuggers / AV. |
| **10** | Process access | LSASS opened with non-zero `GrantedAccess` is the credential-dumping classic. |
| **11** | File create | Drops to startup folders, scheduled-task triggers, browser-cookie reads. |
| **12 / 13 / 14** | Registry create / set / rename | Persistence. Keys under `Run`, `RunOnce`, `Image File Execution Options`. |
| **17 / 18** | Pipe created / connected | Lateral movement (Cobalt Strike's beacon pipes), `wmiprvse → smb → svchost`. |
| **22** | DNS query | The domain a process resolved. Pivot from a suspicious `Image` to its C2 candidates. |
| **25** | Process tampering | Process-hollowing / herpaderping. |

## Pivot patterns

**Is a given external IP a managed / internal host?** When an SCP
event names a `detail.client` IP and you want to know if that IP
belongs to a host you have telemetry from, pivot via Sysmon EID 3:
managed hosts log every outbound connection they make. If the SCP
saw inbound traffic from IP X.X.X.X, the host that originated that
traffic logged its outbound to the SCP at the same time.

```kusto
// Time window = the burst window ± 5 min
Event
| where TimeGenerated between ((datetime(<start>) - 5m) .. (datetime(<end>) + 5m))
| where Source == "Microsoft-Windows-Sysmon" and EventID == 3
| extend ed = parse_xml(EventData)
| extend Data = ed.DataItem.EventData.Data
| extend DestIp   = tostring(Data[14]["#text"])
| extend DestPort = tostring(Data[16]["#text"])
| where DestPort in ("80","443")
| summarize n=count() by Computer, DestIp
| order by n desc
```

If a `Computer` shows up here making outbound connections to the
SCP during the window, the burst is from a **managed internal
workstation**: the `Computer` field is the host name. If the
result is empty, the source IP is unmanaged — likely external.

This is the canonical first move in the credential-stuffing
runbook (`04-runbook-credential-stuffing.md`) and the
Captain-on-`BRIDGE-WS` pattern (`10-org-chart.md`).

**Process tree from a single suspicious process.** Sysmon writes
ProcessGuid (a unique ID) — chain it parent ↔ child:

```kusto
let pid = "<ProcessGuid>";
Event
| where Source == "Microsoft-Windows-Sysmon" and EventID == 1
| extend ed = parse_xml(EventData)
| extend ProcessGuid = tostring(ed.DataItem.EventData.Data[2]["#text"])
| extend ParentGuid  = tostring(ed.DataItem.EventData.Data[18]["#text"])
| where ProcessGuid == pid or ParentGuid == pid
| project TimeGenerated, ProcessGuid, ParentGuid, Image, CommandLine
```

**DNS queries from a process around an alert.** Pivot from the
suspect process's ProcessGuid to its DNS lookups (EID 22):

```kusto
let pid = "<ProcessGuid>";
Event
| where Source == "Microsoft-Windows-Sysmon" and EventID == 22
| extend ed = parse_xml(EventData)
| extend ProcessGuid = tostring(ed.DataItem.EventData.Data[1]["#text"])
| extend QueryName   = tostring(ed.DataItem.EventData.Data[3]["#text"])
| extend QueryStatus = tostring(ed.DataItem.EventData.Data[4]["#text"])
| where ProcessGuid == pid
| project TimeGenerated, QueryName, QueryStatus
| order by TimeGenerated asc
```

**Network connections from a process.** EID 3:

```kusto
let pid = "<ProcessGuid>";
Event
| where Source == "Microsoft-Windows-Sysmon" and EventID == 3
| extend ed = parse_xml(EventData)
| extend ProcessGuid     = tostring(ed.DataItem.EventData.Data[1]["#text"])
| extend DestinationIp   = tostring(ed.DataItem.EventData.Data[14]["#text"])
| extend DestinationPort = tostring(ed.DataItem.EventData.Data[16]["#text"])
| where ProcessGuid == pid
| project TimeGenerated, DestinationIp, DestinationPort
```

## When to consult endpoint telemetry vs. Ship Control Panel

The two corpora answer different questions:

| Question | Look in |
|----------|---------|
| Who attempted to log in? | `ContainerAppConsoleLogs_CL` (`auth.login.failure` / `success`) |
| Was a security toggle flipped? | `ContainerAppConsoleLogs_CL` (`event="security"` / `connectivity` / `collision`) |
| What process did *that* on the bridge workstation (`BRIDGE-WS`)? | `Event` (Sysmon EID 1, 11, 12) |
| Did the host phone out somewhere? | `Event` (Sysmon EID 3, 22) |
| Did anything inject into another process? | `Event` (Sysmon EID 8, 10) |
| Was a privileged Windows event audited? | `Event` (Source="Security", e.g. EID 4624 logon, 4672 special privilege) |

In practice the investigator should query **both** when
investigating a suspicious user — the Ship Control Panel auth
trail tells you when they signed in; the endpoint telemetry tells
you what they did once they were on the host.

## Verifying the channel is alive

If a query returns no rows for `Source == "Microsoft-Windows-Sysmon"`,
the install or the DCR forwarding may have failed. Diagnostic
ladder:

1. RDP into the bridge workstation (`BRIDGE-WS`), check
   `C:\ProgramData\AISOC\Sysmon\install.log` — every install step
   is logged there.
2. On the VM, run `Get-Service Sysmon64` — should be `Running`.
3. On the VM, run
   `Get-WinEvent -LogName 'Microsoft-Windows-Sysmon/Operational' -MaxEvents 5`
   — confirms the channel is producing.
4. In the workspace, check for any rows from this Computer:
   `Event | where Computer == "BRIDGE-WS" | take 5`. If no rows
   appear, the AMA isn't forwarding from this host (check the
   DCR association in the portal).
