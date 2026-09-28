# Endpoint telemetry — the GOAD Windows estate + Sysmon

The Windows hosts in the corporate Active Directory estate (GOAD)
— domain controllers `dc01` / `dc02` / `dc03` and member servers
`srv02` / `srv03` — are monitored assets. Each runs the Azure
Monitor Agent + Sysmon, and their endpoint telemetry lands in two
different Sentinel tables, depending on which Windows channel
produced it:

- **`SecurityEvent`** — Security channel (Windows audit events:
  4624 logon-success, 4625 logon-failure, 4634 logoff, 4672
  special-privilege-assigned, 4688 process-create, etc.). This
  table is **fully columnized** — `Account`, `AccountName`,
  `LogonType`, `IpAddress`, `WorkstationName`, `Process`,
  `CommandLine`, etc. are all first-class fields you can `where`
  and `summarize` on directly.
- **`Event`** — everything else from the hosts: Application /
  System logs and Sysmon. These channels don't have a structured
  Sentinel-native table; the body lives in `EventData` as XML and
  needs `parse_xml()` per-query for fields beyond `Source`,
  `EventID`, `Computer`, and `RenderedDescription`.

Use this page when an alert is host-side (a logon, a process, a
network connection on one of the GOAD hosts), or when you need to
pivot from a **Maison Miró** web event into "what was happening on
the domain at the same time". The AD-attack detections that sit on
top of this telemetry (Kerberoasting, DCSync, password spray,
AS-REP roasting) are in `12-goad-ad-attacks.md`.

## Scope warning — a Windows 4625 burst ≠ a Maison web-auth alert

The GOAD domain controllers carry a steady background of EventID
4625 (failed logon) rows — service accounts with stale passwords,
misconfigured clients, and (in this lab) the red-team's own
password-spray probes. These are Windows / Kerberos / NTLM layer
events.

**The Maison Miró analytic rules read from
`ContainerAppConsoleLogs_CL`, not from `SecurityEvent`.** When
triaging or investigating a Maison incident (`auth.sqli_attempt`,
`auth.login_bypass`, …), do not summarise `SecurityEvent` 4625
rows alongside Maison `auth.*` events — they are separate
phenomena on separate surfaces (Windows domain logon vs. the web
storefront) that happen to look similar in the abstract.

The disambiguator: Maison events carry the client in `source_ip`
(a field inside the `[EVENT]` JSON, correlation key for the whole
incident) and a dotted `type`. Windows-side 4625 rows carry the
target account in `Account` / `AccountName` (often with a domain
prefix, e.g. `NORTH\eddard.stark`) and the source in `IpAddress`
on the `SecurityEvent` row. Keep the two corpora in separate parts
of a case note.

## What's collected, where it lands

| Channel | Table | Why |
|---------|-------|-----|
| `Security` (audit events: 4624 / 4625 / 4634 / 4672 / 4688 / 4720 / 4740 / …) | **`SecurityEvent`** | Native Sentinel table; columns parsed per Microsoft's schema. Use this for any user / logon / process question. |
| `Application` / `System` | `Event` | Generic Windows logs; no structured table needed for this corpus. |
| `Microsoft-Windows-Sysmon/Operational` | `Event` | Sysmon writes here. No separate Sysmon table; parse `EventData` XML for fields. |

**Rule of thumb when choosing a table:**

- "who logged in / from where / how" → **`SecurityEvent`**
- "what process ran / what network connection happened / what
  file/registry change happened" → **`Event`** filtered to
  `Source == "Microsoft-Windows-Sysmon"`

## Base filter — Security audit events (`SecurityEvent`)

```kusto
SecurityEvent
| where TimeGenerated > ago(1h)
| where Computer == "dc01"   // the host named in the incident (dc01/dc02/dc03/srv02/srv03)
```

`SecurityEvent` columns you'll use most:

| Column | Meaning |
|--------|---------|
| `EventID` | 4624 (logon success), 4625 (failure), 4634 (logoff), 4672 (special priv), 4688 (process create), 4720 (account created), 4740 (account locked out), … |
| `Account` | `DOMAIN\user` form, e.g. `NORTH\eddard.stark` |
| `AccountName` | bare username, e.g. `eddard.stark` |
| `LogonType` | 2 = interactive at console, 3 = network, 7 = unlock, 10 = RemoteInteractive (RDP), 11 = CachedInteractive |
| `IpAddress` / `WorkstationName` | source of the logon (4624 / 4625) |
| `Process` / `ProcessName` / `CommandLine` | for 4688 process-create |
| `LogonProcessName`, `AuthenticationPackageName` | how the logon was performed |

## Base filter — Application / System / Sysmon (`Event`)

```kusto
Event
| where TimeGenerated > ago(1h)
| where Computer == "dc01"   // the host named in the incident
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

**Is a given external IP a managed / internal host?** When an
event names a source IP and you want to know if that IP belongs to
a host you have telemetry from, pivot via Sysmon EID 3: managed
hosts log every outbound connection they make. If some surface saw
inbound traffic from IP X.X.X.X, the host that originated that
traffic logged its outbound at the same time.

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

If a `Computer` shows up here making outbound connections during
the window, the traffic is from a **managed host in the estate**:
the `Computer` field is the host name. If the result is empty, the
source IP is unmanaged — likely an external attacker (in this lab,
the RedAmon red-team box operating from outside the domain).

This is the canonical first move when triaging any alert that
carries a source IP and you need to know whether it's an internal
managed host.

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

## When to consult endpoint telemetry vs. Maison Miró

The two corpora answer different questions:

| Question | Look in |
|----------|---------|
| Who attacked the **web store** (SQLi login, auth bypass, forged session, IDOR, exfil, fraud, XSS)? | `ContainerAppConsoleLogs_CL` (`ContainerName_s == "maison-miro"` — see `13-maison-logging.md`) |
| Who logged in / failed to log in / logged off **on a GOAD host**? | **`SecurityEvent`** (EID 4624 / 4625 / 4634) |
| What process ran **on a GOAD host**? | **`SecurityEvent`** (EID 4688 process create — has `Process` / `CommandLine` parsed) AND `Event` (Sysmon EID 1 — has full process tree via ProcessGuid) |
| Did a host phone out somewhere? | `Event` (Sysmon EID 3, 22) |
| Did anything inject into another process? | `Event` (Sysmon EID 8, 10) |
| Was a privileged Windows event audited? | **`SecurityEvent`** (4672 special privilege, 4720 account created, 4740 account locked out) |
| Is this a Kerberoast / DCSync / spray / AS-REP roast? | **`SecurityEvent`** — detection logic in `12-goad-ad-attacks.md` |

In a full kill-chain the investigator should query **both**
corpora: Maison tells you how the attacker got in at the web tier;
the endpoint telemetry tells you what they did once they pivoted
to the domain.

## Verifying the channel is alive

If a query returns no rows for `Source == "Microsoft-Windows-Sysmon"`
on a host you expect telemetry from, the Sysmon install or the DCR
forwarding may have failed. Diagnostic ladder:

1. Reach the host (through the GOAD jumpbox), and confirm the
   Sysmon service: `Get-Service Sysmon64` — should be `Running`.
2. On the host, run
   `Get-WinEvent -LogName 'Microsoft-Windows-Sysmon/Operational' -MaxEvents 5`
   — confirms the channel is producing locally.
3. In the workspace, check for any rows from this Computer:
   `Event | where Computer == "dc01" | take 5` (Sysmon /
   Application / System) and
   `SecurityEvent | where Computer == "dc01" | take 5` (audit
   events). If both return zero rows, the AMA isn't forwarding
   from this host at all — check that `4-onboard-goad` associated
   it to the DCR (the association is per-host). If only one is
   empty, that channel's stream binding in the DCR is broken —
   Security → `SecurityEvent` (via `Microsoft-SecurityEvent`
   stream), other channels → `Event` (via `Microsoft-Event`
   stream).
