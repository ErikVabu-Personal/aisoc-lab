# GOAD — Active Directory attacks: EID reference + runbooks

The corporate Active Directory estate (**GOAD**) is monitored alongside
the Maison Miró web store. This page is what Triage / Investigator /
Reporter retrieve when an incident's rule reads `SecurityEvent` on a
domain controller. It covers the estate, the audit events that matter,
per-attack detection logic, and the verdict mapping.

## The estate

Standard GOAD layout (verify against the live deployment — names can
differ, the roles don't):

| Host | Role | Domain |
|------|------|--------|
| `dc01` | Domain controller | `sevenkingdoms.local` |
| `dc02` | Domain controller | `north.sevenkingdoms.local` |
| `dc03` | Domain controller | `essos.local` (separate forest) |
| `srv02` | Member server (SQL / web) | `north.sevenkingdoms.local` |
| `srv03` | Member server (IIS / web) | `sevenkingdoms.local` |

Three domains across two forests, with a trust between them —
deliberately misconfigured for training. All hosts run the Azure
Monitor Agent + Sysmon; audit events land in `SecurityEvent`, Sysmon
in `Event` (`Source == "Microsoft-Windows-Sysmon"`).

## AD-attack event-ID reference (`SecurityEvent`)

| EID | Meaning | Key columns | Attack it reveals |
|-----|---------|-------------|-------------------|
| 4768 | Kerberos TGT (AS-REQ) requested | `TargetUserName`, `TicketEncryptionType`, `PreAuthType`, `IpAddress` | AS-REP roasting (PreAuthType 0 + RC4) |
| 4769 | Kerberos service ticket (TGS) requested | `TargetUserName`, `ServiceName`, `TicketEncryptionType`, `IpAddress` | Kerberoasting (RC4 for user SPNs) |
| 4771 | Kerberos pre-auth failed | `TargetUserName`, `IpAddress` | Password spray / brute force |
| 4776 | NTLM credential validation | `TargetUserName`, `Workstation` | NTLM spray / brute force |
| 4625 | Logon failure | `TargetUserName`, `IpAddress`, `LogonType` | Spray / brute force |
| 4624 | Logon success | `TargetUserName`, `LogonType`, `IpAddress` | Lateral movement, post-compromise use |
| 4662 | Operation on a directory object | `SubjectUserName`, `Properties`, `AccessMask` | DCSync (replication GUIDs) |
| 5136 | Directory object modified | `SubjectUserName`, `ObjectDN` | Persistence / ACL abuse |
| 4728/4732/4756 | Member added to (global/local/universal) group | `SubjectUserName`, `MemberName`, `TargetUserName` | Privilege escalation |

`TicketEncryptionType == "0x17"` is RC4-HMAC — the weak cipher both
Kerberoasting and AS-REP roasting rely on. `0x12` is AES256 (normal).

## Per-attack runbooks

### Kerberoasting (rule fires on 4769)

**What it is:** an authenticated user requests service tickets (TGS)
for many *user* service accounts with RC4, to crack them offline.

**Confirm:**
```kusto
SecurityEvent
| where TimeGenerated > ago(1h)
| where EventID == 4769 and TicketEncryptionType == "0x17"
| where ServiceName !endswith "$" and ServiceName != "krbtgt"
| summarize distinct_services = dcount(ServiceName), services = make_set(ServiceName, 25),
            first_seen = min(TimeGenerated), last_seen = max(TimeGenerated)
    by TargetUserName, IpAddress
| order by distinct_services desc
```
**Normal:** a handful of 4769s with AES (`0x12`) as apps request
tickets. **Abnormal:** one account (`TargetUserName`) requesting RC4
tickets for many distinct user SPNs in a short window.

**Investigate:** which account requested them (`TargetUserName`), from
which host (`IpAddress` → 4624 on that host), which SPNs were targeted.

### DCSync (rule fires on 4662)

**What it is:** a non-DC principal invokes directory replication
(`DS-Replication-Get-Changes*`) to pull password hashes — Mimikatz
`lsadump::dcsync`.

**Confirm:** 4662 with `AccessMask has "0x100"` and `Properties`
containing a replication GUID (`1131f6aa-…`, `1131f6ad-…`,
`89e95b76-…`) where `SubjectUserName` is **not** a machine account
(`$`). Real DCs replicate constantly as `DC$` — those are excluded.

**Normal:** replication between `dc01$`/`dc02$`/`dc03$` only.
**Abnormal:** a user account (or a server like `srv02$` that is not a
DC) performing replication → almost always credential theft.

**Investigate:** the `SubjectUserName` is the compromised/abused
account; treat as **high severity** — a successful DCSync means domain
credentials are exposed. Recommend: reset `krbtgt` (twice) + affected
accounts, hunt for the source host.

### Password spray (rule fires on 4625 / 4771)

**What it is:** one source tries a few passwords against many accounts
to stay under lockout thresholds.

**Confirm:** high `dcount(TargetUserName)` from one `IpAddress` in a
window (4625 and/or 4771). **Normal:** a single user fat-fingering
their own password (few distinct accounts). **Abnormal:** one source,
many distinct accounts.

**Investigate:** did any account then succeed (4624 from the same
`IpAddress`)? A success flips this to a confirmed compromise — pivot
to that account + host.

### AS-REP roasting (rule fires on 4768)

**What it is:** accounts flagged "do not require Kerberos pre-auth"
let anyone request a TGT and crack it offline.

**Confirm:** 4768 with `PreAuthType == "0"` and RC4 (`0x17`) for user
accounts. **Normal:** none — pre-auth is required by default.
**Abnormal:** any such request is roastable-account abuse.

**Investigate:** which accounts are exposed (`TargetUserName`), from
where (`IpAddress`). Recommend removing the "no pre-auth" flag.

## Account intent

Resolve account meaning via `03-account-naming.md`. In GOAD the
notable identities are the domain/enterprise admins and the service
accounts with SPNs (the Kerberoast targets). A service account or
admin account appearing as the *actor* in DCSync/Kerberoast is a
high-severity signal.

## Verdict mapping

| Pattern | Verdict |
|---------|---------|
| Kerberoast/AS-REP: RC4 ticket requests for many user SPNs from one account | Active — escalate L2 (credential-theft attempt in progress) |
| DCSync by any non-DC principal | Active — escalate **L3** (domain credential exposure; recommend krbtgt reset) |
| Password spray, zero successes, source not on watchlist | Closed (true positive, contained — no compromise) OR benign if a single mistyping user |
| Spray/roast **+ subsequent 4624 success** for a targeted account | Active — escalate L3 (confirmed compromise; pivot to the host) |
| Group-membership change (4728/4732/4756) adding a user to Domain/Enterprise Admins outside a change window | Active — escalate L3 (privilege escalation / persistence) |

## Containment (recommendation only — humans execute)

- Reset the compromised account's password; for a DCSync, reset
  `krbtgt` twice and force TGT re-issue.
- Isolate the source host once identified (via the source IP → host
  pivot).
- Remove "do not require pre-auth" and unnecessary SPNs from user
  accounts flagged by AS-REP/Kerberoast rules.
