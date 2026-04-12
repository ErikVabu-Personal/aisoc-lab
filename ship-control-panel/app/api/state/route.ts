import { NextResponse } from 'next/server';

// Simple in-memory state store (persists for the lifetime of the container instance).
// Good for demos; for true durability across restarts, back with Redis/Cosmos/Storage.

type AnchorState = 'HOME' | 'PAYING_OUT' | 'HOLDING' | 'DRAGGING';

type StabilizerMode = 'OFF' | 'STANDBY' | 'AUTO' | 'MANUAL';

type PoolLights = 'OFF' | 'AMBIENT' | 'PARTY';

type EntertainmentZone = 'LOUNGE' | 'BALLROOM' | 'CABINS';

type LightScene = 'SUNSET_DECK' | 'AURORA' | 'DEEP_SEA';

type AppState = {
  version: number;
  updatedAt: string;

  // Anchor
  anchor: {
    state: AnchorState;
    chainPct: number;
  };

  // Stabilizers
  stabilizers: {
    mode: StabilizerMode;
    seaState: number; // 0..6
    finPortDeg: number; // -25..25
    finStbdDeg: number; // -25..25
  };

  // Connectivity
  connectivity: {
    enabled: boolean;
    signal: number; // 0..1
  };

  // Collision detection
  collision: {
    enabled: boolean;
  };

  // Climate (per-room)
  climate: {
    rooms: Record<
      string,
      {
        enabled: boolean;
        targetC: number;
        fan: 'AUTO' | 'LOW' | 'MED' | 'HIGH';
      }
    >;
  };

  // Entertainment
  entertainment: {
    scene: LightScene;
    poolTempC: number;
    poolJets: boolean;
    poolLights: PoolLights;
    saunaTempC: number;
    steamHumidityPct: number;
    gymBoost: boolean;

    zone: EntertainmentZone;
    playing: boolean;
    volume: number; // 0..100
    trackId: string;
    progress: number; // 0..1

    scheduleNotify: Record<string, boolean>; // per schedule row id
  };
};

const DEFAULT_STATE: AppState = {
  version: 1,
  updatedAt: new Date().toISOString(),
  anchor: { state: 'HOME', chainPct: 0 },
  stabilizers: { mode: 'AUTO', seaState: 3, finPortDeg: 4, finStbdDeg: -4 },
  connectivity: { enabled: true, signal: 0.82 },
  collision: { enabled: true },
  climate: {
    rooms: {
      Ballroom: { enabled: true, targetC: 21, fan: 'AUTO' },
      'Dining room': { enabled: true, targetC: 21, fan: 'AUTO' },
      Cabins: { enabled: true, targetC: 20, fan: 'AUTO' },
      Bridge: { enabled: true, targetC: 20, fan: 'AUTO' },
      'Engine room': { enabled: true, targetC: 18, fan: 'AUTO' },
    },
  },
  entertainment: {
    scene: 'SUNSET_DECK',
    poolTempC: 29,
    poolJets: true,
    poolLights: 'AMBIENT',
    saunaTempC: 82,
    steamHumidityPct: 65,
    gymBoost: false,
    zone: 'LOUNGE',
    playing: true,
    volume: 62,
    trackId: 't1',
    progress: 0.32,
    scheduleNotify: {
      yoga: false,
      piano: false,
      movie: false,
    },
  },
};

// globalThis survives module reloads in Next's Node runtime; still in-memory.
const g = globalThis as any;
if (!g.__SCP_STATE__) {
  g.__SCP_STATE__ = structuredClone(DEFAULT_STATE);
}

function getState(): AppState {
  return g.__SCP_STATE__ as AppState;
}

function setState(next: AppState) {
  g.__SCP_STATE__ = next;
}

function logEvent(event: string, detail: any) {
  // Structured log line for Sentinel/Log Analytics ingestion.
  // Keep it one-line JSON.
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      service: 'ship-control-panel',
      event,
      detail,
    }),
  );
}

export async function GET() {
  return NextResponse.json(getState());
}

export async function PATCH(req: Request) {
  const body = await req.json().catch(() => ({}));
  const prev = getState();

  // shallow merge at top-level; callers should send full sub-objects they change
  const next: AppState = {
    ...prev,
    ...body,
    version: (prev.version ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };

  setState(next);

  logEvent('state.changed', {
    version: next.version,
    keys: Object.keys(body ?? {}),
  });

  return NextResponse.json(next);
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  // action-style endpoint for fine-grained changes + better logs
  const { action, payload } = body ?? {};

  const prev = getState();
  let next = prev;

  if (action === 'setAnchorState') {
    next = {
      ...prev,
      anchor: {
        ...prev.anchor,
        ...payload,
      },
      version: (prev.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    setState(next);
    logEvent('anchor.state', { from: prev.anchor, to: next.anchor });
    return NextResponse.json(next);
  }

  if (action === 'setConnectivity') {
    next = {
      ...prev,
      connectivity: {
        ...prev.connectivity,
        ...payload,
      },
      version: (prev.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    setState(next);
    logEvent('connectivity', { from: prev.connectivity, to: next.connectivity });
    return NextResponse.json(next);
  }

  if (action === 'setCollision') {
    next = {
      ...prev,
      collision: {
        ...prev.collision,
        ...payload,
      },
      version: (prev.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    setState(next);
    logEvent('collision', { from: prev.collision, to: next.collision });
    return NextResponse.json(next);
  }

  if (action === 'setEntertainment') {
    next = {
      ...prev,
      entertainment: {
        ...prev.entertainment,
        ...payload,
      },
      version: (prev.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    setState(next);
    logEvent('entertainment', { keys: Object.keys(payload ?? {}) });
    return NextResponse.json(next);
  }

  if (action === 'setStabilizers') {
    next = {
      ...prev,
      stabilizers: {
        ...prev.stabilizers,
        ...payload,
      },
      version: (prev.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    setState(next);
    logEvent('stabilizers', { from: prev.stabilizers, to: next.stabilizers });
    return NextResponse.json(next);
  }

  if (action === 'setClimateRoom') {
    const { room, patch } = payload ?? {};
    if (!room) return NextResponse.json({ error: 'room required' }, { status: 400 });
    next = {
      ...prev,
      climate: {
        ...prev.climate,
        rooms: {
          ...prev.climate.rooms,
          [room]: {
            ...(prev.climate.rooms?.[room] ?? { enabled: true, targetC: 21, fan: 'AUTO' }),
            ...(patch ?? {}),
          },
        },
      },
      version: (prev.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    setState(next);
    logEvent('climate.room', { room, patch });
    return NextResponse.json(next);
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
