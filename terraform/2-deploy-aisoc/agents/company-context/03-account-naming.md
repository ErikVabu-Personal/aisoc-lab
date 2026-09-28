# Account naming + intent

The two monitored surfaces name identities differently. Work out
which surface an account came from, resolve it against that
surface's conventions, then apply the generic intent rules below.

## GOAD Active Directory (the Windows domains)

Users, service accounts, and machine accounts across three domains
in two forests (`sevenkingdoms.local`, `north.sevenkingdoms.local`,
`essos.local`). Conventions:

- **User accounts** — fictional Game-of-Thrones names, e.g.
  `eddard.stark`, `cersei.lannister`, `daenerys.targaryen`,
  `jon.snow`. On a `SecurityEvent` row they appear as
  `TargetUserName` / `AccountName`, often with a domain prefix
  (`NORTH\eddard.stark`).
- **Service accounts** — accounts that carry a Service Principal
  Name (SPN). These are the **Kerberoast targets**: a service
  account appearing as the *actor* requesting many RC4 service
  tickets, or as the actor in a DCSync, is a high-severity signal.
  The attack-relevant principals (SPN-holders, DCSync-capable
  accounts, Domain / Enterprise Admins) are enumerated in
  `12-goad-ad-attacks.md`.
- **Machine accounts** — end in `$` (`dc01$`, `srv02$`). Domain
  controllers replicate constantly as `DC$`; that is normal. A
  non-DC machine account — or a *user* account — performing
  directory replication is not.

## Maison Miró (the web store)

Maison has its own customer accounts, but an attacker there is
**not** identified by a username — the correlation key is
`source_ip` (one attacker walks the whole kill chain from a single
IP). The login form is itself the SQL-injection / auth-bypass
target, so a "username" in a Maison event is attacker-controlled
input, not a trustworthy identity. Attribute Maison activity by
`source_ip`; see `13-maison-logging.md`.

## Generic intent rules (both surfaces)

- **Service / automation accounts should never log in
  interactively.** Any interactive logon (or, on the web tier, any
  privileged action) by an automation identity from a
  non-allow-listed source is alert-worthy.
- **Treat any account you can't place as untrusted** until an
  analyst verifies it. Classic attacker-supplied names seen in past
  incidents: `root`, `sa`, `test`, `admin`, `user1`. Any auth
  attempt involving those is hostile by default.
- The org chart (`10-org-chart.md`) maps *staff* names to real
  people for HITL routing — it is not a catalogue of attacker
  identities, and attacker activity should never be attributed to a
  staff member without corroborating evidence.
