/**
 * Browser runtime mock — fetches assets and injects the same postMessage
 * events the VS Code extension would send.
 *
 * In Vite dev, it prefers pre-decoded JSON endpoints from middleware.
 * In plain browser builds, it falls back to decoding PNGs at runtime.
 *
 * Only imported in browser runtime; tree-shaken from VS Code webview runtime.
 */

import { rgbaToHex } from '../../shared/assets/colorUtils.ts';
import {
  CHAR_FRAME_H,
  CHAR_FRAME_W,
  CHAR_FRAMES_PER_ROW,
  CHARACTER_DIRECTIONS,
  FLOOR_TILE_SIZE,
  WALL_BITMASK_COUNT,
  WALL_GRID_COLS,
  WALL_PIECE_HEIGHT,
  WALL_PIECE_WIDTH,
} from '../../shared/assets/constants.ts';
import type {
  AssetIndex,
  CatalogEntry,
  CharacterDirectionSprites,
} from '../../shared/assets/types.ts';

interface MockPayload {
  characters: CharacterDirectionSprites[];
  floorSprites: string[][][];
  wallSets: string[][][][];
  furnitureCatalog: CatalogEntry[];
  furnitureSprites: Record<string, string[][]>;
  layout: unknown;
}

// ── Module-level state ─────────────────────────────────────────────────────────

let mockPayload: MockPayload | null = null;

// ── PNG decode helpers (browser fallback) ───────────────────────────────────

interface DecodedPng {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function getPixel(
  data: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const idx = (y * width + x) * 4;
  return [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]];
}

function readSprite(
  png: DecodedPng,
  width: number,
  height: number,
  offsetX = 0,
  offsetY = 0,
): string[][] {
  const sprite: string[][] = [];
  for (let y = 0; y < height; y++) {
    const row: string[] = [];
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = getPixel(png.data, png.width, offsetX + x, offsetY + y);
      row.push(rgbaToHex(r, g, b, a));
    }
    sprite.push(row);
  }
  return sprite;
}

async function decodePng(url: string): Promise<DecodedPng> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch PNG: ${url} (${res.status.toString()})`);
  }
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('Failed to create 2d canvas context for PNG decode');
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data: imageData.data };
}

async function fetchJsonOptional<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function getIndexedAssetPath(kind: 'characters' | 'floors' | 'walls', relPath: string): string {
  return relPath.startsWith(`${kind}/`) ? relPath : `${kind}/${relPath}`;
}

async function decodeCharactersFromPng(
  base: string,
  index: AssetIndex,
): Promise<CharacterDirectionSprites[]> {
  const sprites: CharacterDirectionSprites[] = [];
  for (const relPath of index.characters) {
    const png = await decodePng(`${base}assets/${getIndexedAssetPath('characters', relPath)}`);
    const byDir: CharacterDirectionSprites = { down: [], up: [], right: [] };

    for (let dirIdx = 0; dirIdx < CHARACTER_DIRECTIONS.length; dirIdx++) {
      const dir = CHARACTER_DIRECTIONS[dirIdx];
      const rowOffsetY = dirIdx * CHAR_FRAME_H;
      const frames: string[][][] = [];
      for (let frame = 0; frame < CHAR_FRAMES_PER_ROW; frame++) {
        frames.push(readSprite(png, CHAR_FRAME_W, CHAR_FRAME_H, frame * CHAR_FRAME_W, rowOffsetY));
      }
      byDir[dir] = frames;
    }

    sprites.push(byDir);
  }
  return sprites;
}

async function decodeFloorsFromPng(base: string, index: AssetIndex): Promise<string[][][]> {
  const floors: string[][][] = [];
  for (const relPath of index.floors) {
    const png = await decodePng(`${base}assets/${getIndexedAssetPath('floors', relPath)}`);
    floors.push(readSprite(png, FLOOR_TILE_SIZE, FLOOR_TILE_SIZE));
  }
  return floors;
}

async function decodeWallsFromPng(base: string, index: AssetIndex): Promise<string[][][][]> {
  const wallSets: string[][][][] = [];
  for (const relPath of index.walls) {
    const png = await decodePng(`${base}assets/${getIndexedAssetPath('walls', relPath)}`);
    const set: string[][][] = [];
    for (let mask = 0; mask < WALL_BITMASK_COUNT; mask++) {
      const ox = (mask % WALL_GRID_COLS) * WALL_PIECE_WIDTH;
      const oy = Math.floor(mask / WALL_GRID_COLS) * WALL_PIECE_HEIGHT;
      set.push(readSprite(png, WALL_PIECE_WIDTH, WALL_PIECE_HEIGHT, ox, oy));
    }
    wallSets.push(set);
  }
  return wallSets;
}

async function decodeFurnitureFromPng(
  base: string,
  catalog: CatalogEntry[],
): Promise<Record<string, string[][]>> {
  const sprites: Record<string, string[][]> = {};
  for (const entry of catalog) {
    const png = await decodePng(`${base}assets/${entry.furniturePath}`);
    sprites[entry.id] = readSprite(png, entry.width, entry.height);
  }
  return sprites;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Call before createRoot() in main.tsx.
 * Fetches all pre-decoded assets from the Vite dev server and stores them
 * for dispatchMockMessages().
 */
export async function initBrowserMock(): Promise<void> {
  console.log('[BrowserMock] Loading assets...');

  const base = import.meta.env.BASE_URL; // '/' in dev, '/sub/' with a subpath, './' in production

  const [assetIndex, catalog] = await Promise.all([
    fetch(`${base}assets/asset-index.json`).then((r) => r.json()) as Promise<AssetIndex>,
    fetch(`${base}assets/furniture-catalog.json`).then((r) => r.json()) as Promise<CatalogEntry[]>,
  ]);

  const shouldTryDecoded = import.meta.env.DEV;
  const [decodedCharacters, decodedFloors, decodedWalls, decodedFurniture] = shouldTryDecoded
    ? await Promise.all([
        fetchJsonOptional<CharacterDirectionSprites[]>(`${base}assets/decoded/characters.json`),
        fetchJsonOptional<string[][][]>(`${base}assets/decoded/floors.json`),
        fetchJsonOptional<string[][][][]>(`${base}assets/decoded/walls.json`),
        fetchJsonOptional<Record<string, string[][]>>(`${base}assets/decoded/furniture.json`),
      ])
    : [null, null, null, null];

  const hasDecoded = !!(decodedCharacters && decodedFloors && decodedWalls && decodedFurniture);

  if (!hasDecoded) {
    if (shouldTryDecoded) {
      console.log('[BrowserMock] Decoded JSON not found, decoding PNG assets in browser...');
    } else {
      console.log('[BrowserMock] Decoding PNG assets in browser...');
    }
  }

  const [characters, floorSprites, wallSets, furnitureSprites] = hasDecoded
    ? [decodedCharacters!, decodedFloors!, decodedWalls!, decodedFurniture!]
    : await Promise.all([
        decodeCharactersFromPng(base, assetIndex),
        decodeFloorsFromPng(base, assetIndex),
        decodeWallsFromPng(base, assetIndex),
        decodeFurnitureFromPng(base, catalog),
      ]);

  const layout = assetIndex.defaultLayout
    ? await fetch(`${base}assets/${assetIndex.defaultLayout}`).then((r) => r.json())
    : null;

  mockPayload = {
    characters,
    floorSprites,
    wallSets,
    furnitureCatalog: catalog,
    furnitureSprites,
    layout,
  };

  console.log(
    `[BrowserMock] Ready (${hasDecoded ? 'decoded-json' : 'browser-png-decode'}) — ${characters.length} chars, ${floorSprites.length} floors, ${wallSets.length} wall sets, ${catalog.length} furniture items`,
  );
}

/**
 * Call inside a useEffect in App.tsx — after the window message listener
 * in useExtensionMessages has been registered.
 */
export function dispatchMockMessages(): void {
  if (!mockPayload) return;

  const { characters, floorSprites, wallSets, furnitureCatalog, furnitureSprites, layout } =
    mockPayload;

  function dispatch(data: unknown): void {
    window.dispatchEvent(new MessageEvent('message', { data }));
  }

  // Must match the load order defined in CLAUDE.md:
  // characterSpritesLoaded → floorTilesLoaded → wallTilesLoaded → furnitureAssetsLoaded → layoutLoaded
  dispatch({ type: 'characterSpritesLoaded', characters });
  dispatch({ type: 'floorTilesLoaded', sprites: floorSprites });
  dispatch({ type: 'wallTilesLoaded', sets: wallSets });
  dispatch({ type: 'furnitureAssetsLoaded', catalog: furnitureCatalog, sprites: furnitureSprites });
  dispatch({ type: 'layoutLoaded', layout });
  dispatch({
    type: 'settingsLoaded',
    soundEnabled: false,
    extensionVersion: '1.2.0',
    lastSeenVersion: '1.1',
  });

  // --- AISOC adapter: poll backend for agent states and translate to Pixel Agents messages ---
  // This replaces the VS Code host/Claude transcript watcher with our runner-driven telemetry.
  // Important: wait until layout is loaded (assets + seats built) before driving movement.
  let layoutReady = true;

  const nameToId = new Map<string, number>();
  const lastStatus = new Map<string, string>();


  // Expose deterministic debug helpers in the browser console (for troubleshooting)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__aisoc = {
    nameToId,
    dispatch,
    // Read-only seat lookup helper used by the desk-seat scan.
    // We mirror the underlying office state lookup by simply asking the extension-message layer
    // to resolve a seat (which itself checks for seat existence). This helper is best-effort:
    // it returns the last resolved seat event payload if available.
    // NOTE: We keep it as a function hook so manual probing is easy in DevTools.
    getSeatAt: (col: number, row: number) => {
      // This will be populated by useExtensionMessages' internal state once assets/layout are loaded.
      // If not available, return null.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).__aisoc_lastSeatLookup?.(`${col},${row}`) ?? null;
    },
    walkTo: (id: number, col: number, row: number) => dispatch({ type: 'agentWalkToTile', id, col, row }),
    resolveSeat: (id: number, col: number, row: number) =>
      dispatch({ type: 'agentResolveSeatAtTile', id, col, row }),
    assignSeat: (id: number, col: number, row: number) =>
      dispatch({ type: 'agentAssignSeatAtTile', id, col, row }),
    active: (id: number, active: boolean) => dispatch({ type: 'agentActive', id, active }),
    status: (id: number, status: string) => dispatch({ type: 'agentStatus', id, status }),
  };
  const lastMode = new Map<string, 'desk' | 'lounge'>();
  const lastActiveTs = new Map<string, number>();
  const lastIdleTs = new Map<string, number>();
  // Prevent idle lounge anchoring from snapping agents back while they are walking to a desk.
  const deskHoldUntil = new Map<string, number>();
  let nextId = 1;

  const loungeAnchorTimerByAgent = new Map<string, number>();

  function stopLoungeAnchorRetry(name: string): void {
    const t = loungeAnchorTimerByAgent.get(name);
    if (t) {
      window.clearInterval(t);
      loungeAnchorTimerByAgent.delete(name);
    }
  }

  function anchorToLoungeSoon(name: string, id: number): void {
    // Retry for a short period: seats/character may not exist yet.
    const MAX_TRIES = 12;
    let tries = 0;

    stopLoungeAnchorRetry(name);

    const timer = window.setInterval(() => {
      // Stop if already anchored
      if (loungeTileForAgent.has(name)) {
        stopLoungeAnchorRetry(name);
        return;
      }
      const idx = loungeNextIdx.get(name) ?? 0;
      const tile = loungeCandidates[Math.min(idx, loungeCandidates.length - 1)];
      dispatch({ type: 'agentResolveSeatAtTile', id, col: tile.col, row: tile.row });
      tries++;
      if (tries >= MAX_TRIES) {
        stopLoungeAnchorRetry(name);
      }
    }, 300);

    loungeAnchorTimerByAgent.set(name, timer);
  }

  function ensureAgent(name: string): number {
    let id = nameToId.get(name);
    if (id) return id;
    id = nextId++;
    nameToId.set(name, id);
    dispatch({ type: 'agentCreated', id, folderName: name });

    // Anchor new agents to lounge as soon as layout+seats are ready.
    loungeNextIdx.set(name, 0);
    lastMode.set(name, 'lounge');
    anchorToLoungeSoon(name, id);

    return id;
  }

  // Hard-coded tile targets for the default layout:
  // Lounge is near the sofa at cols ~13-16, rows ~13-16.
  // Candidate lounge tiles near the sofa cluster. We'll try these in order until a seat exists.
  const loungeCandidates: Array<{ col: number; row: number }> = [
    { col: 14, row: 14 },
    { col: 15, row: 14 },
    { col: 16, row: 14 },
    { col: 14, row: 15 },
    { col: 15, row: 15 },
    { col: 16, row: 15 },
    { col: 13, row: 14 },
    { col: 13, row: 15 },
  ];

  // Remember which lounge tile worked per agent so they stay stable
  const loungeTileForAgent = new Map<string, { col: number; row: number }>();
  const loungeNextIdx = new Map<string, number>();
  const takenLoungeSeats = new Set<string>();
  const takenLoungeTiles = new Set<string>();
  const pendingSeatTry = new Map<string, { col: number; row: number }>();

  // Listen for events coming from useExtensionMessages handler
  window.addEventListener('message', (ev) => {
    const msg = (ev as MessageEvent).data as any;
    if (!msg) return;

    // Active toggles: force desk movement on active=true.
    if (msg.type === 'agentActive' && msg.active === true) {
      const agentName = [...nameToId.entries()].find(([, v]) => v === msg.id)?.[0];
      if (!agentName) return;
      moveAgentTo(msg.id, agentName, true);
      lastMode.set(agentName, 'desk');
      return;
    }

    if (msg.type !== 'agentSeatResolved') return;

    // If ok, remember the tile for that agent id (reverse lookup)
    const agentName = [...nameToId.entries()].find(([, v]) => v === msg.id)?.[0];
    if (!agentName) return;

    console.log('[AISOC] agentSeatResolved', { agentName, ...msg });

    if (msg.ok) {
      const seatId = msg.seatId ? String(msg.seatId) : '';
      if (seatId && takenLoungeSeats.has(seatId)) {
        // Seat already taken by another agent — keep searching
        const cur = loungeNextIdx.get(agentName) ?? 0;
        loungeNextIdx.set(agentName, Math.min(cur + 1, loungeCandidates.length - 1));
        pendingSeatTry.delete(agentName);
        return;
      }

      loungeTileForAgent.set(agentName, { col: msg.col, row: msg.row });
      if (seatId) takenLoungeSeats.add(seatId);
      takenLoungeTiles.add(`${msg.col},${msg.row}`);
      pendingSeatTry.delete(agentName);
    } else {
      // advance index so next attempt tries another tile
      const cur = loungeNextIdx.get(agentName) ?? 0;
      loungeNextIdx.set(agentName, Math.min(cur + 1, loungeCandidates.length - 1));
      pendingSeatTry.delete(agentName);
    }
  });

  // Desk targets for active agents.
  // Step 1 (minimal): walk to a deterministic tile near the desk area (standing is OK).
  // This avoids seat-resolution edge cases while we validate the active→desk pipeline.
  const deskWalkTargets: Record<string, { col: number; row: number }> = {
    triage: { col: 3, row: 16 },
    investigator: { col: 7, row: 16 },
    reporter: { col: 5, row: 16 },
  };

  function moveAgentTo(id: number, name: string, active: boolean): void {
    if (active) {
      // If we have an ongoing lounge-anchoring retry loop, stop it; otherwise it can fight desk movement.
      stopLoungeAnchorRetry(name);

      const tile = deskWalkTargets[name] ?? deskWalkTargets.triage;
      dispatch({ type: 'agentWalkToTile', id, col: tile.col, row: tile.row });
      // Hold desk mode briefly so the idle loop doesn't immediately re-anchor to lounge mid-walk.
      deskHoldUntil.set(name, Date.now() / 1000 + 3.0);
      return;
    }

    // Idle: anchor to a lounge seat. Try a remembered tile first, otherwise try candidates.
    const remembered = loungeTileForAgent.get(name);
    if (remembered) {
      dispatch({ type: 'agentAssignSeatAtTile', id, col: remembered.col, row: remembered.row });
      return;
    }

    // Avoid spamming resolve requests while one is in-flight
    if (pendingSeatTry.has(name)) return;

    let idx = loungeNextIdx.get(name) ?? 0;
    while (idx < loungeCandidates.length) {
      const tile = loungeCandidates[idx];
      const key = `${tile.col},${tile.row}`;
      if (!takenLoungeTiles.has(key)) {
        pendingSeatTry.set(name, tile);
        dispatch({ type: 'agentResolveSeatAtTile', id, col: tile.col, row: tile.row });
        return;
      }
      idx++;
    }
  }

  function setStatus(name: string, id: number, status: 'active' | 'waiting'): void {
    const prev = lastStatus.get(name);
    if (prev === status) return;
    lastStatus.set(name, status);
    dispatch({ type: 'agentStatus', id, status });
  }

  function setActive(name: string, id: number, active: boolean): void {
    const key = `${name}:active`;
    const prev = lastStatus.get(key);
    const next = active ? '1' : '0';
    if (prev === next) return;
    lastStatus.set(key, next);
    dispatch({ type: 'agentActive', id, active });
  }

  function setTool(id: number, toolName: string): void {
    // Minimal: show current tool as a running tool item
    const toolId = `aisoc-${toolName}`;
    dispatch({ type: 'agentToolStart', id, toolId, status: toolName, toolName });
    // Immediately mark done so the overlay doesn't accumulate forever
    dispatch({ type: 'agentToolDone', id, toolId });
  }

  async function pollOnce(): Promise<void> {
    try {
      const res = await fetch('/api/agents/state');
      if (!res.ok) return;
      const data = (await res.json()) as { agents?: Array<{ id: string; status: string; tool_name?: string | null }> };
      const list = data.agents || [];

      const now = Date.now() / 1000;

      for (const a of list) {
        const name = a.id;
        const id = ensureAgent(name);

        if (!layoutReady) return;

        const isActive = a.status === 'typing' || a.status === 'reading';
        const isError = a.status === 'error';

        if (isActive) {
          lastActiveTs.set(name, now);
        } else {
          lastIdleTs.set(name, now);
        }

        // Hysteresis thresholds (seconds)
        const ACTIVE_TO_DESK_SEC = 0.1;
        const IDLE_TO_LOUNGE_SEC = 5.0;

        const lastActive = lastActiveTs.get(name) ?? 0;
        const lastIdle = lastIdleTs.get(name) ?? 0;

        const wantDesk = isActive && (now - lastIdle) >= ACTIVE_TO_DESK_SEC;
        const wantLounge = !isActive && !isError && (now - lastActive) >= IDLE_TO_LOUNGE_SEC;

        if (isError) {
          // Error → waiting bubble
          setStatus(name, id, 'waiting');
          setActive(name, id, false);
          // Keep them in lounge during errors
          if (lastMode.get(name) !== 'lounge') {
            moveAgentTo(id, name, false);
            lastMode.set(name, 'lounge');
          }
          continue;
        }

        if (isActive) {
          setActive(name, id, true);
          if (a.tool_name) setTool(id, a.tool_name);
          if (wantDesk && lastMode.get(name) !== 'desk') {
            moveAgentTo(id, name, true);
            lastMode.set(name, 'desk');
          }
        } else {
          // Normal idle: keep them anchored in lounge
          setActive(name, id, false);

          const holdUntil = deskHoldUntil.get(name) ?? 0;
          const canReturnToLounge = now >= holdUntil;

          if (wantLounge && canReturnToLounge && lastMode.get(name) !== 'lounge') {
            // Reset lounge candidate search when returning to lounge
            loungeNextIdx.set(name, 0);
            loungeTileForAgent.delete(name);
            moveAgentTo(id, name, false);
            lastMode.set(name, 'lounge');
          }
        }
      }
    } catch {
      // ignore
    }
  }

  void pollOnce();
  window.setInterval(() => void pollOnce(), 750);

  console.log('[BrowserMock] Messages dispatched + AISOC adapter polling enabled');
}
