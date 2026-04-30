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

  // Navigation/helm
  navigation: {
    throttle: number; // 0..100
    destination: { lng: number; lat: number };
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
  navigation: { throttle: 35, destination: { lng: -135.0, lat: 58.3 } },
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

function reqMeta(req: Request) {
  const h = req.headers;
  // Field name is `client` (not `clientIp`) to stay consistent with
  // the auth events — Sentinel rules + agent KQL all read
  // j.detail.client. The state events end up in the same logs and
  // diverging here would force consumers to extract two field names
  // for the same concept.
  return {
    client: h.get('x-forwarded-for') ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent') ?? null,
  };
}

function logEvent(event: string, detail: any, meta?: any) {
  // Structured log line for Sentinel/Log Analytics ingestion.
  // Keep it one-line JSON.
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      service: 'ship-control-panel',
      event,
      meta: meta ?? null,
      detail,
    }),
  );
}

function diffKeys(prev: any, next: any, allowedKeys?: string[]) {
  const keys = allowedKeys ?? Array.from(new Set([...
    Object.keys(prev ?? {}),
    ...Object.keys(next ?? {}),
  ]));

  const changed: string[] = [];
  for (const k of keys) {
    const a = prev?.[k];
    const b = next?.[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(k);
  }
  return changed;
}

export async function GET() {
  return NextResponse.json(getState());
}

export async function PATCH(req: Request) {
  const body = await req.json().catch(() => ({}));
  const prev = getState();
  const meta = reqMeta(req);

  // shallow merge at top-level; callers should send full sub-objects they change
  const next: AppState = {
    ...prev,
    ...body,
    version: (prev.version ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };

  setState(next);

  logEvent(
    'state.changed',
    {
      version: next.version,
      keys: Object.keys(body ?? {}),
    },
    meta,
  );

  return NextResponse.json(next);
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  // action-style endpoint for fine-grained changes + better logs
  const { action, payload } = body ?? {};

  const meta = reqMeta(req);
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
    const changed = diffKeys(prev.anchor, next.anchor, ['state', 'chainPct']);
    if (changed.length) logEvent('anchor', { changed, from: prev.anchor, to: next.anchor }, meta);
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
    const changed = diffKeys(prev.connectivity, next.connectivity, ['enabled', 'signal']);
    // Avoid noisy signal drift spam; only log enable/disable changes.
    const changedNoSignal = changed.filter((k) => k !== 'signal');
    if (changedNoSignal.length) logEvent('connectivity', { changed: changedNoSignal, from: prev.connectivity, to: next.connectivity }, meta);
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
    const changed = diffKeys(prev.collision, next.collision, ['enabled']);
    if (changed.length) logEvent('collision', { changed, from: prev.collision, to: next.collision }, meta);
    return NextResponse.json(next);
  }

  if (action === 'setThrottle') {
    next = {
      ...prev,
      navigation: {
        ...prev.navigation,
        ...payload,
      },
      version: (prev.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    setState(next);
    const changed = diffKeys(prev.navigation, next.navigation, ['throttle']);
    if (changed.length) logEvent('navigation.throttle', { changed, from: prev.navigation, to: next.navigation }, meta);
    return NextResponse.json(next);
  }

  if (action === 'setDestination') {
    next = {
      ...prev,
      navigation: {
        ...prev.navigation,
        destination: {
          ...prev.navigation.destination,
          ...(payload ?? {}),
        },
      },
      version: (prev.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    setState(next);
    const changed = diffKeys(prev.navigation.destination, next.navigation.destination, ['lng', 'lat']);
    if (changed.length) {
      logEvent(
        'navigation.destination',
        {
          changed,
          from: prev.navigation.destination,
          to: next.navigation.destination,
        },
        meta,
      );
    }
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
    const changed = diffKeys(prev.entertainment, next.entertainment, Object.keys(payload ?? {}));
    if (changed.length) logEvent('entertainment', { changed, from: prev.entertainment, to: next.entertainment }, meta);
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
    const changed = diffKeys(prev.stabilizers, next.stabilizers, Object.keys(payload ?? {}));
    // Only log user changes (mode/seaState/manual fin sliders). AUTO fin drift can be noisy.
    const noisy = ['finPortDeg', 'finStbdDeg'];
    const changedNoisy = changed.filter((k) => !noisy.includes(k) || (payload && k in payload && prev.stabilizers?.[k] !== payload[k]));
    if (changedNoisy.length) logEvent('stabilizers', { changed: changedNoisy, from: prev.stabilizers, to: next.stabilizers }, meta);
    return NextResponse.json(next);
  }

  if (action === 'setClimateRoom') {
    const { room, patch } = payload ?? {};
    if (!room) return NextResponse.json({ error: 'room required' }, { status: 400 });

    const prevRoom = prev.climate.rooms?.[room] ?? { enabled: true, targetC: 21, fan: 'AUTO' };

    next = {
      ...prev,
      climate: {
        ...prev.climate,
        rooms: {
          ...prev.climate.rooms,
          [room]: {
            ...prevRoom,
            ...(patch ?? {}),
          },
        },
      },
      version: (prev.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    setState(next);

    const nextRoom = next.climate.rooms?.[room];
    const changed = diffKeys(prevRoom, nextRoom, Object.keys(patch ?? {}));
    if (changed.length) logEvent('climate', { room, changed, from: prevRoom, to: nextRoom }, meta);
    return NextResponse.json(next);
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
