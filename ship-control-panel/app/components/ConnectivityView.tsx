'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Gauge } from './Instruments';
import { useAppState } from './useAppState';

type Sample = { t: number; dl: number; ul: number; rtt: number; jitter: number };

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

export function ConnectivityView() {
  const { state, loading, post } = useAppState();
  const [samples, setSamples] = useState<Sample[]>([]);

  const enabled = !!state?.connectivity?.enabled;
  const signal = typeof state?.connectivity?.signal === 'number' ? state.connectivity.signal : 0.82;

  useEffect(() => {
    const t = window.setInterval(() => {
      // signal level drifts slightly (real-time feel) - stored server-side
      const base = enabled ? 0.82 : 0.18;
      const nextSignal = clamp(base + (Math.random() - 0.5) * 0.12, 0, 1);
      post('setConnectivity', { signal: nextSignal }).catch(() => {});

      setSamples((prev) => {
        const now = Date.now();
        const baseDl = enabled ? 180 : 8;
        const baseUl = enabled ? 22 : 1.5;
        const dl = clamp(baseDl + (Math.random() - 0.5) * baseDl * 0.25, 0, 400);
        const ul = clamp(baseUl + (Math.random() - 0.5) * baseUl * 0.35, 0, 80);
        const rtt = clamp((enabled ? 34 : 250) + (Math.random() - 0.5) * 12, 10, 600);
        const jitter = clamp((enabled ? 6 : 60) + (Math.random() - 0.5) * 8, 1, 120);
        const next = [...prev, { t: now, dl, ul, rtt, jitter }].slice(-30);
        return next;
      });
    }, 900);
    return () => window.clearInterval(t);
  }, [enabled, post]);

  const last = samples[samples.length - 1];
  const status = enabled ? 'CONNECTED' : 'DEGRADED';

  return (
    <div className="view">
      <div className="viewTitle">Connectivity</div>
      <div className="viewSub">Starlink uplink + continuous speedtest (simulated).</div>

      <div className="panelGrid" style={{ marginTop: 12 }}>
        <div className="kpi bigPanel">
          <div className="nav">
            <div>
              <div className="kpiLabel">Uplink</div>
              <div className="kpiValue mono" style={{ fontSize: 18 }}>{status}</div>
            </div>
            <button
              type="button"
              className={enabled ? 'toggle on' : 'toggle off'}
              onClick={() => post('setConnectivity', { enabled: !enabled }).catch(() => {})}
              disabled={loading}
            >
              {enabled ? 'Enabled' : 'Disabled'}
            </button>
          </div>

          <div className="uplink" aria-hidden>
            <SignalBars level={signal} enabled={enabled} />
            <div className={enabled ? 'sat on' : 'sat'}>STARLINK</div>
          </div>
        </div>

        <div className="kpi">
          <Gauge label="Download" value={last ? last.dl : 0} min={0} max={400} unit="Mbps" />
        </div>
        <div className="kpi">
          <Gauge label="Upload" value={last ? last.ul : 0} min={0} max={80} unit="Mbps" />
        </div>

        <div className="kpi">
          <div className="kpiLabel">Latency</div>
          <div className="kpiValue mono">{last ? `${last.rtt.toFixed(0)} ms` : '—'}</div>
          <div className="sub" style={{ marginTop: 8 }}>Jitter: {last ? `${last.jitter.toFixed(0)} ms` : '—'}</div>
        </div>

        <div className="kpi">
          <div className="kpiLabel">Speedtest (last 30)</div>
          <Sparkline samples={samples} keyName="dl" color="rgba(34,211,238,0.85)" />
          <div className="sub" style={{ marginTop: 6 }}>DL (Mbps)</div>
          <Sparkline samples={samples} keyName="ul" color="rgba(250,204,21,0.85)" />
          <div className="sub" style={{ marginTop: 6 }}>UL (Mbps)</div>
        </div>
      </div>
    </div>
  );
}

function SignalBars({ level, enabled }: { level: number; enabled: boolean }) {
  const bars = 18;
  const onCount = Math.max(1, Math.min(bars, Math.round(level * bars)));
  return (
    <div className={enabled ? 'sigBars on' : 'sigBars'}>
      {Array.from({ length: bars }).map((_, i) => {
        const h = 12 + (i / (bars - 1)) * 54;
        const on = i < onCount;
        return (
          <div
            key={i}
            className={on ? 'sigBar on' : 'sigBar'}
            style={{ height: `${h}px` }}
          />
        );
      })}
    </div>
  );
}

function Sparkline({
  samples,
  keyName,
  color,
}: {
  samples: Sample[];
  keyName: 'dl' | 'ul';
  color: string;
}) {
  const pts = useMemo(() => {
    if (samples.length === 0) return '';
    const vals = samples.map((s) => s[keyName]);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const w = 260;
    const h = 48;
    const pad = 4;
    const scaleX = (i: number) => pad + (i / Math.max(1, vals.length - 1)) * (w - pad * 2);
    const scaleY = (v: number) => {
      const p = max === min ? 0.5 : (v - min) / (max - min);
      return h - pad - p * (h - pad * 2);
    };
    return vals.map((v, i) => `${scaleX(i)},${scaleY(v)}`).join(' ');
  }, [samples, keyName]);

  return (
    <svg width="100%" height="48" viewBox="0 0 260 48" style={{ display: 'block' }} aria-hidden>
      <polyline fill="none" stroke={color} strokeWidth="2" points={pts} />
    </svg>
  );
}
