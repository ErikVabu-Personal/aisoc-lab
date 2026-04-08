# PixelAgents Web status (AISOC demo)

Last updated: 2026-04-08

## What works

- PixelAgents Web deployed as Azure Container App and reachable.
- Runner emits events to PixelAgents Web via `PIXELAGENTS_URL` and `PIXELAGENTS_TOKEN`.
- Pixel Agents **webview UI** is vendored and served (no longer the hand-rolled canvas UI).
- UI is driven by an adapter that polls `GET /api/agents/state` and dispatches Pixel Agents style message events.
- Agent attribution works via Foundry OpenAPI schemas that set `x-aisoc-agent` header (triage/investigator/reporter).

## What is WIP / broken

- Lounge seating is not fully deterministic:
  - triage reliably gets a sofa seat
  - investigator and reporter can remain at desks while idle
- Root cause (observed via debug logs): multiple agents resolve to the same lounge seatId (seat contention) + timing issues.
- We added retry + feedback (`agentResolveSeatAtTile` → `agentSeatResolved`) and attempted to avoid reusing the same lounge tile/seat.

## Current architecture

- Backend: `pixelagents_web/app/server.py`
  - `POST /events` (protected by `x-pixelagents-token`)
  - `GET /events/stream` (SSE)
  - `GET /api/agents/state` (adapter JSON)
  - `/` serves Pixel Agents UI from `pixelagents_web/app/ui_dist`
  - `/assets` and `/fonts` serve UI static assets

- Frontend (vendored): `pixelagents_web/ui/`
  - `src/browserMock.ts` contains AISOC adapter polling `/api/agents/state`
  - `src/hooks/useExtensionMessages.ts` contains additional message types:
    - `agentWalkToTile`
    - `agentActive`
    - `agentAssignSeatAtTile`
    - `agentResolveSeatAtTile` (emits `agentSeatResolved`)

## Recent commits (high signal)

- `9f3d5f3` serve Pixel Agents UI assets under `/assets` and `/fonts`
- `f72f698` add `/api/agents/state` endpoint
- `88e745e` initial adapter: poll `/api/agents/state` and dispatch mock messages
- `8f61423` add `agentWalkToTile` handler + move between lounge/desks
- `8e03744` add `agentActive` to allow inactive without waiting bubble
- `d8d13bc` seat resolution feedback + retry until seat found
- `7e73fae` retry lounge anchoring after agentCreated
- `d93001b` avoid assigning same lounge seat to multiple agents

## Next debugging steps (tomorrow)

1) Remove debug logs after fixing.
2) Make lounge seating deterministic by:
   - resolving *three distinct* sofa seatIds and assigning by seatId (not by tile)
   - or adding a proper seat reservation mechanism in OfficeState adapter layer.
3) Adjust desk targets / seat assignment for active state (use desk chair seats instead of walkToTile).
