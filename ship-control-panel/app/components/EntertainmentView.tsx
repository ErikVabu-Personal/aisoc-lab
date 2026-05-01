'use client';

import React, { useMemo, useState } from 'react';
import { useAppState } from './useAppState';

type LightScene = 'SUNSET_DECK' | 'AURORA' | 'DEEP_SEA';

type Track = { id: string; title: string; artist: string; durSec: number };

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

export function EntertainmentView() {
  const { state, loading, post } = useAppState();

  const scene = (state?.entertainment?.scene as LightScene) ?? 'SUNSET_DECK';
  const poolTemp = typeof state?.entertainment?.poolTempC === 'number' ? state.entertainment.poolTempC : 29;
  const poolJets = !!state?.entertainment?.poolJets;
  const poolLights = (state?.entertainment?.poolLights as 'OFF' | 'AMBIENT' | 'PARTY') ?? 'AMBIENT';

  const saunaTemp = typeof state?.entertainment?.saunaTempC === 'number' ? state.entertainment.saunaTempC : 82;
  const steamHumidity =
    typeof state?.entertainment?.steamHumidityPct === 'number' ? state.entertainment.steamHumidityPct : 65;
  const gymBoost = !!state?.entertainment?.gymBoost;

  const zone = (state?.entertainment?.zone as 'LOUNGE' | 'BALLROOM' | 'CABINS') ?? 'LOUNGE';
  const playing = !!state?.entertainment?.playing;
  const volume = typeof state?.entertainment?.volume === 'number' ? state.entertainment.volume : 62;
  const progress = typeof state?.entertainment?.progress === 'number' ? state.entertainment.progress : 0.32;

  const tracks: Track[] = useMemo(
    () => [
      { id: 't1', title: 'Midnight Current', artist: 'Deck Ensemble', durSec: 242 },
      { id: 't2', title: 'Aurora Drift', artist: 'Northern Lights', durSec: 198 },
      { id: 't3', title: 'Harbor Neon', artist: 'Portside', durSec: 215 },
      { id: 't4', title: 'Deepwater Pulse', artist: 'Bathyscape', durSec: 264 },
    ],
    [],
  );
  const trackId = (state?.entertainment?.trackId as string) ?? tracks[0].id;
  const track = tracks.find((t) => t.id === trackId) ?? tracks[0];

  // Light-theme scene tints — same idea as the dark version (each
  // scene paints the entShell with its own subtle gradient) but tuned
  // for the bridge skin's off-white surface, so text remains readable
  // and the cards inside don't disappear into a black wash.
  const bg = useMemo(() => {
    switch (scene) {
      case 'SUNSET_DECK':
        return 'radial-gradient(700px 360px at 20% 10%, rgba(251,113,133,0.10), transparent 55%), radial-gradient(700px 360px at 70% 30%, rgba(250,204,21,0.08), transparent 55%), var(--panel-2)';
      case 'AURORA':
        return 'radial-gradient(700px 360px at 20% 20%, rgba(22,160,122,0.08), transparent 55%), radial-gradient(700px 360px at 70% 30%, rgba(0,153,204,0.10), transparent 55%), var(--panel-2)';
      case 'DEEP_SEA':
        return 'radial-gradient(700px 360px at 30% 20%, rgba(14,58,95,0.08), transparent 55%), radial-gradient(700px 360px at 70% 60%, rgba(0,153,204,0.08), transparent 55%), var(--panel-2)';
    }
  }, [scene]);

  return (
    <div className="view">
      <div className="viewTitle">Entertainment</div>
      <div className="viewSub">Pool • Wellness • Media • Scenes (simulated)</div>

      <div className="entShell" style={{ marginTop: 12, borderRadius: 4, padding: 12, border: '1px solid var(--hairline)', background: bg }}>
        <div className="panelGrid" style={{ marginTop: 0 }}>
          <div className="kpi">
            <div className="panelTitle">Lighting Scenes</div>
            <div className="sub" style={{ marginTop: 6 }}>Select a scene to set the mood.</div>
            <div className="stabModes" style={{ marginTop: 10 }}>
              <button type="button" className={scene === 'SUNSET_DECK' ? 'tab active' : 'tab'} onClick={() => post('setEntertainment', { scene: 'SUNSET_DECK' }).catch(() => {})} disabled={loading}>Sunset Deck</button>
              <button type="button" className={scene === 'AURORA' ? 'tab active' : 'tab'} onClick={() => post('setEntertainment', { scene: 'AURORA' }).catch(() => {})} disabled={loading}>Aurora</button>
              <button type="button" className={scene === 'DEEP_SEA' ? 'tab active' : 'tab'} onClick={() => post('setEntertainment', { scene: 'DEEP_SEA' }).catch(() => {})} disabled={loading}>Deep Sea</button>
              <button type="button" className="tab" disabled style={{ opacity: 0.5, cursor: 'not-allowed' }}>Emergency Red</button>
            </div>
          </div>

          <div className="kpi">
            <div className="panelTitle">Amenities</div>
            <div className="sub" style={{ marginTop: 6 }}>Quick controls for leisure systems.</div>

            <div className="hr" />

            <div className="sub" style={{ fontWeight: 900, opacity: 0.9 }}>Pool</div>
            <label className="ctl">
              <span>Temp</span>
              <input type="range" min={24} max={34} value={poolTemp} onChange={(e) => post('setEntertainment', { poolTempC: parseInt(e.target.value, 10) }).catch(() => {})} />
              <span className="mono">{poolTemp}°C</span>
            </label>
            <div className="nav" style={{ marginTop: 6 }}>
              <button type="button" className={poolJets ? 'toggle on' : 'toggle off'} onClick={() => post('setEntertainment', { poolJets: !poolJets }).catch(() => {})} disabled={loading}>
                Jets {poolJets ? 'ON' : 'OFF'}
              </button>
              <select className="input" style={{ padding: '10px 10px', width: 150 }} value={poolLights} onChange={(e) => post('setEntertainment', { poolLights: e.target.value }).catch(() => {})} disabled={loading}>
                <option value="OFF">Lights: Off</option>
                <option value="AMBIENT">Lights: Ambient</option>
                <option value="PARTY">Lights: Party</option>
              </select>
            </div>

            <div className="hr" />

            <div className="sub" style={{ fontWeight: 900, opacity: 0.9 }}>Wellness</div>
            <label className="ctl">
              <span>Sauna</span>
              <input type="range" min={60} max={95} value={saunaTemp} onChange={(e) => post('setEntertainment', { saunaTempC: parseInt(e.target.value, 10) }).catch(() => {})} />
              <span className="mono">{saunaTemp}°C</span>
            </label>
            <label className="ctl">
              <span>Steam</span>
              <input type="range" min={30} max={95} value={steamHumidity} onChange={(e) => post('setEntertainment', { steamHumidityPct: parseInt(e.target.value, 10) }).catch(() => {})} />
              <span className="mono">{steamHumidity}%</span>
            </label>
            <div className="nav" style={{ marginTop: 6 }}>
              <button type="button" className={gymBoost ? 'toggle on' : 'toggle off'} onClick={() => post('setEntertainment', { gymBoost: !gymBoost }).catch(() => {})} disabled={loading}>
                Gym ventilation boost
              </button>
            </div>
          </div>

          <div className="kpi bigPanel">
            <div className="panelTitle">Now Playing</div>
            <div className="sub" style={{ marginTop: 6 }}>Ship-wide media controls.</div>

            <div className="hr" />

            <div className="nav">
              <div className="pill mono">ZONE: {zone}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className={zone === 'LOUNGE' ? 'tab active' : 'tab'} onClick={() => post('setEntertainment', { zone: 'LOUNGE' }).catch(() => {})} disabled={loading}>Lounge</button>
                <button type="button" className={zone === 'BALLROOM' ? 'tab active' : 'tab'} onClick={() => post('setEntertainment', { zone: 'BALLROOM' }).catch(() => {})} disabled={loading}>Ballroom</button>
                <button type="button" className={zone === 'CABINS' ? 'tab active' : 'tab'} onClick={() => post('setEntertainment', { zone: 'CABINS' }).catch(() => {})} disabled={loading}>Cabins</button>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
              <div className="kpi">
                <div className="kpiLabel">Track</div>
                <div className="kpiValue" style={{ fontSize: 16 }}>{track.title}</div>
                <div className="sub">{track.artist}</div>
                <div className="bar" style={{ marginTop: 10 }}>
                  <div className="barFill" style={{ width: `${progress * 100}%`, background: 'rgba(34,211,238,0.85)' }} />
                </div>
                <div className="nav" style={{ marginTop: 10 }}>
                  <button type="button" className="btn" onClick={() => post('setEntertainment', { playing: !playing }).catch(() => {})} disabled={loading}>
                    {playing ? 'Pause' : 'Play'}
                  </button>
                  <button type="button" className="btn" onClick={() => post('setEntertainment', { progress: clamp(progress + 0.12, 0, 1) }).catch(() => {})} disabled={loading}>
                    Skip
                  </button>
                  <button type="button" className="btn" onClick={() => alert('Announcement chime (demo)')}>Chime</button>
                </div>
              </div>

              <div className="kpi">
                <div className="kpiLabel">Volume</div>
                <div className="kpiValue mono">{volume}%</div>
                <label className="ctl" style={{ gridTemplateColumns: '80px 1fr 60px' }}>
                  <span>Level</span>
                  <input type="range" min={0} max={100} value={volume} onChange={(e) => post('setEntertainment', { volume: parseInt(e.target.value, 10) }).catch(() => {})} />
                  <span className="mono">{volume}%</span>
                </label>

                <div className="kpiLabel" style={{ marginTop: 10 }}>Queue</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                  {tracks.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={t.id === trackId ? 'tab active' : 'tab'}
                      onClick={() => post('setEntertainment', { trackId: t.id }).catch(() => {})}
                      style={{ textAlign: 'left' }}
                    >
                      {t.title} — <span style={{ opacity: 0.75 }}>{t.artist}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="kpi bigPanel">
            <div className="panelTitle">Experiences Schedule</div>
            <div className="sub" style={{ marginTop: 6 }}>Tonight’s program (demo).</div>

            <div className="hr" />

            <ScheduleRow time="18:00" title="Yoga" place="Spa Deck" />
            <ScheduleRow time="19:30" title="Live Piano" place="Lounge" />
            <ScheduleRow time="21:00" title="Movie Night" place="Ballroom" />
          </div>
        </div>
      </div>
    </div>
  );
}

function ScheduleRow({ time, title, place }: { time: string; title: string; place: string }) {
  // local UI-only; could be wired server-side if desired
  const [notify, setNotify] = useState(false);
  return (
    <div className="nav" style={{ padding: '8px 0' }}>
      <div className="pill mono">{time}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 900 }}>{title}</div>
        <div className="sub">{place}</div>
      </div>
      <button type="button" className={notify ? 'toggle on' : 'toggle off'} onClick={() => setNotify((v) => !v)}>
        Notify cabins
      </button>
    </div>
  );
}
