# Runbook — Starlink uplink disabled mid-voyage

**When to use:** an `event="connectivity"` log line shows
`to.enabled:false` outside a scheduled maintenance window.

## Why this matters

The Starlink uplink is the ship's **only** path back to:
- Brussels Sentinel (loss of remote logging — investigation goes
  blind)
- Brussels NOC (loss of remote support / containment)
- Vendor management plane (firmware updates, remote config)

Cutting connectivity is a **denial-of-investigation** move. It either
means an attacker is trying to hide what comes next, or there's a
legitimate reason (rare; almost always pre-coordinated).

## Investigator checklist

1. Confirm timing — is this within a scheduled maintenance window?
   Check the Brussels NOC's maintenance calendar.
2. Identify the user who toggled it (auth events at the same client
   IP / session as the connectivity event).
3. **Critical**: from this point on, your KQL queries may show stale
   data — the ship hasn't been forwarding logs since the toggle.
   Note this gap explicitly in your timeline.
4. Look at events immediately before the toggle (the last 5 min of
   forwarded data). Are there any other state changes that look like
   pre-attack staging?
5. Check whether the uplink came back on. If it's still off, the
   response is much more urgent — the bridge officer should be
   calling Brussels NOC by ship-to-shore radio.

## Containment steps (recommendation only — humans execute)

- **Re-enable the uplink** via local bridge override (the toggle is
  software, the antenna is still physically active).
- If the bridge isn't reachable, the **Master must be informed by
  ship-to-shore radio** and asked to authorise an investigation.
- Once the uplink is restored, expect a **burst of buffered logs** —
  the ship-side log forwarder buffers up to 8h of events when
  disconnected. Re-run your KQL with a wider time window.

## Verdict mapping

| Pattern                                          | Verdict           |
|--------------------------------------------------|-------------------|
| Pre-coordinated maintenance window               | Closed (benign)   |
| Any unscheduled toggle, uplink restored quickly  | Active (escalate to L3) |
| Uplink still disabled                            | Active (escalate to incident commander) |
| Multiple state changes (cameras + uplink)        | Active (escalate to incident commander — active intrusion) |
