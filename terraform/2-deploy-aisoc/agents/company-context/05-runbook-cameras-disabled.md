# Runbook — security cameras disabled

**When to use:** the alert "Security — Cameras disabled" fires, OR an
investigator surfaces an `event="security"` log line with
`severity:"warn"` and `to.camerasEnabled:false`.

## Why this is high-priority

Disabling the CCTV system is **textbook attacker tradecraft**. It's
done before a physical action (theft, sabotage, unauthorised entry
to restricted areas) or before social-engineering activity that the
attacker doesn't want recorded. Treat as **high-confidence indicator
of compromise** until proven otherwise.

There is no legitimate operational reason to disable all cameras at
sea. The only valid use cases are:
- During scheduled drydock maintenance (camera units replaced — but
  that's done port-side, not at sea, and the maintenance window is
  pre-coordinated).
- Vendor maintenance window with explicit ticket reference (vendor
  account `vendor_*` doing the toggle, during a pre-agreed window).

Anything else is an alarm.

## Investigator checklist

1. Pull the full `event="security"` log line. Note the **client IP**,
   **userAgent**, and exact timestamp.
2. Pull the auth context: who was signed in on that client IP at
   that timestamp? Run the auth-success query for the same IP +
   ±5min window.
3. Check whether this is the only state change. Look for adjacent
   `event="connectivity"` (uplink off?), `event="navigation"`
   (throttle / destination change?), `event="anchor"` (anchor
   dropped?). A burst of state changes at once is a strong signal
   that the attacker is doing more than just disabling cameras.
4. Cross-check against the maintenance schedule. There is no legit
   maintenance window after 18:00 ship local on any vessel.
5. Confirm the disabling was undone — if cameras are still off in
   the latest event, the response is more urgent.

## Containment steps (recommendation only — humans execute)

- **Re-enable cameras immediately** via the Brussels NOC. The
  bridge officer on watch has emergency override.
- **Suspend the user account** that did the toggle pending review.
- **Pull and preserve the camera footage** from before the disable
  — file might still be on disk on the DVR if the disable came
  before recording wrapped.
- **Bridge officer to do a physical sweep** of the affected zones
  during the disabled window.

## Verdict mapping

| Pattern                                                    | Verdict           |
|-------------------------------------------------------------|-------------------|
| `vendor_*` user during pre-agreed maintenance window        | Closed (benign)   |
| Any other user, any time                                    | Active (escalate to L3 — confirmed compromise) |
| Cameras still disabled in the latest event                  | Active (escalate to incident commander — active intrusion) |
