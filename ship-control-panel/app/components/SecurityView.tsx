'use client';

// SecurityView — CCTV control wall.
//
// Six tiles arranged 3x2 (collapses to 2x1 on narrow screens). Each
// tile shows a "live feed" whose source is /security/<name>.gif. The
// tile renders a CSS-only NO-SIGNAL placeholder behind the <img>, so
// when the GIF is missing the operator sees a believable degraded
// state instead of a broken image icon.
//
// To replace the placeholders with real footage, drop your GIFs into
// `ship-control-panel/public/security/` using the file names below.
// Anything 16:9 (or 16:10) at modest resolution (640x360 is plenty)
// will look right.
//
// The "Disable cameras" toggle in the toolbar mutates ship state via
// /api/state setSecurity, which emits a structured `event:"security"`
// log line — visible to Sentinel as suspicious-bridge-action signal.

import React, { useEffect, useState } from 'react';
import { useAppState } from './useAppState';

type Camera = {
  id: string;
  name: string;
  zone: string;
  file: string;     // path under /public
};

const CAMERAS: Camera[] = [
  { id: 'CAM-01', name: 'Bridge — Helm',           zone: 'Deck 12 · Forward', file: '/security/bridge.gif' },
  { id: 'CAM-02', name: 'Atrium — Grand Lobby',    zone: 'Deck 5 · Midship',  file: '/security/atrium.gif' },
  { id: 'CAM-03', name: 'Engine Room',             zone: 'Deck 1 · Aft',      file: '/security/engine.gif' },
  { id: 'CAM-04', name: 'Promenade — Port Side',   zone: 'Deck 7 · Port',     file: '/security/promenade.gif' },
  { id: 'CAM-05', name: 'Lido Pool Deck',          zone: 'Deck 14 · Topside', file: '/security/pooldeck.gif' },
  { id: 'CAM-06', name: 'Crew Gangway',            zone: 'Deck 2 · Starboard',file: '/security/gangway.gif' },
];

function pad2(n: number): string { return n < 10 ? `0${n}` : String(n); }

function formatStamp(d: Date): string {
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  const h = pad2(d.getHours());
  const mn = pad2(d.getMinutes());
  const s = pad2(d.getSeconds());
  return `${y}-${m}-${day}  ${h}:${mn}:${s}`;
}

function CameraTile({ cam, enabled }: { cam: Camera; enabled: boolean }) {
  // Tracks whether the GIF actually loaded. We don't unmount the
  // fallback when it does — z-index ordering means the loaded img
  // simply covers it.
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  return (
    <div
      className={`sec-tile${enabled ? '' : ' offline'}`}
      data-cam={cam.id}
    >
      <div className="sec-head">
        <span className="cam-id">{cam.id}</span>
        <span className="cam-name">{cam.name}</span>
        {enabled ? (
          <span className="rec"><span className="dot"></span>REC</span>
        ) : (
          <span className="rec offline" aria-label="Offline">OFFLINE</span>
        )}
      </div>

      {/* Fallback — visible until the gif loads OR when the camera is
          disabled. Stays mounted so a slow network, a missing file,
          or an off-screen tile never shows a broken-image icon. */}
      <div className="sec-fallback">
        <div className="sweep" aria-hidden="true"></div>
        <div className="label">
          {enabled
            ? `No signal · drop ${cam.file.split('/').pop()}`
            : 'Camera disabled'}
        </div>
      </div>

      {enabled && !errored && (
        <img
          className="sec-feed"
          src={cam.file}
          alt={`${cam.id} ${cam.name}`}
          onLoad={() => setLoaded(true)}
          onError={() => setErrored(true)}
          // Inline style so the img stays hidden until it loads —
          // avoids the alt-text flash the browser would otherwise
          // show while the file is unreachable. Once loaded, the
          // CSS opacity transitions to 1.
          style={{
            opacity: loaded ? 1 : 0,
            transition: 'opacity 0.3s ease',
          }}
        />
      )}

      <div className="sec-foot">
        <span className="label">{cam.zone}</span>
        <span style={{ marginLeft: 'auto' }}>
          <LiveStamp />
        </span>
      </div>
    </div>
  );
}

// Ticking timestamp at 1Hz. Lives in its own component so each tile's
// re-render stays cheap.
function LiveStamp() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{formatStamp(now)}</>;
}

function HeaderClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="clock">
      {pad2(now.getHours())}:{pad2(now.getMinutes())}:{pad2(now.getSeconds())} UTC
    </span>
  );
}

export function SecurityView() {
  const { state, post } = useAppState();
  // Optimistic-locking flag so a click doesn't fire twice while the
  // POST is in-flight.
  const [busy, setBusy] = useState(false);

  // First-render the state may not be loaded yet; default to enabled
  // so the grid shows live tiles by default.
  const enabled = state?.security?.camerasEnabled ?? true;

  async function onToggle() {
    if (busy) return;
    setBusy(true);
    try {
      await post('setSecurity', { camerasEnabled: !enabled });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="view">
      <div className="sec-toolbar">
        {enabled ? (
          <span className="live-pill"><span className="blink"></span>Live</span>
        ) : (
          <span className="live-pill offline">All cameras disabled</span>
        )}
        <span>{CAMERAS.length} cameras · DVR retention 30 days</span>
        <HeaderClock />
        <button
          type="button"
          onClick={onToggle}
          disabled={busy}
          className={`btn ${enabled ? '' : 'ghost'}`}
          style={{ padding: '8px 14px' }}
          title={enabled
            ? 'Disable all cameras (logged as a security state change).'
            : 'Re-enable all cameras.'}
        >
          {busy
            ? 'Working…'
            : (enabled ? 'Disable cameras' : 'Re-enable cameras')}
        </button>
      </div>

      <div className="sec-grid">
        {CAMERAS.map((cam) => (
          <CameraTile key={cam.id} cam={cam} enabled={enabled} />
        ))}
      </div>

      <div className="sec-hint">
        Camera feeds are served from <code>public/security/</code>.
        Drop GIFs named{' '}
        {CAMERAS.map((c, i) => (
          <span key={c.id}>
            <code>{c.file.split('/').pop()}</code>
            {i < CAMERAS.length - 1 ? ', ' : ''}
          </span>
        ))}
        {' '}to replace the placeholders. 16:10 ratio · 640×400 is plenty.
      </div>
    </div>
  );
}
