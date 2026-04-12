'use client';

import React, { useMemo, useState } from 'react';

type LightScene = 'SUNSET_DECK' | 'AURORA' | 'DEEP_SEA';

type Track = { id: string; title: string; artist: string; durSec: number };

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

export function EntertainmentView() {
  const [scene, setScene] = useState<LightScene>('SUNSET_DECK');

  const [poolTemp, setPoolTemp] = useState(29);
  const [poolJets, setPoolJets] = useState(true);
  const [poolLights, setPoolLights] = useState<'OFF' | 'AMBIENT' | 'PARTY'>('AMBIENT');

  const [saunaTemp, setSaunaTemp] = useState(82);
  const [steamHumidity, setSteamHumidity] = useState(65);
  const [gymBoost, setGymBoost] = useState(false);

  const [zone, setZone] = useState<'LOUNGE' | 'BALLROOM' | 'CABINS'>('LOUNGE');
  const [playing, setPlaying] = useState(true);
  const [volume, setVolume] = useState(62);
  const [progress, setProgress] = useState(0.32);

  const tracks: Track[] = useMemo(
    () => [
      { id: 't1', title: 'Midnight Current', artist: 'Deck Ensemble', durSec: 242 },
      { id: 't2', title: 'Aurora Drift', artist: 'Northern Lights', durSec: 198 },
      { id: 't3', title: 'Harbor Neon', artist: 'Portside', durSec: 215 },
      { id: 't4', title: 'Deepwater Pulse', artist: 'Bathyscape', durSec: 264 },
    ],
    [],
  );
  const [trackId, setTrackId] = useState(tracks[0].id);
  const track = tracks.find((t) => t.id === trackId) ?? tracks[0];

  const bg = useMemo(() => {
    switch (scene) {
      case 'SUNSET_DECK':
        return 'radial-gradient(900px 500px at 20% 10%, rgba(251,113,133,0.18), transparent 55%), radial-gradient(900px 500px at 70% 30%, rgba(250,204,21,0.14), transparent 55%), linear-gradient(180deg, rgba(0,0,0,0.24), rgba(0,0,0,0.62))';
      case 'AURORA':
        return 'radial-gradient(900px 500px at 20% 20%, rgba(52,211,153,0.16), transparent 55%), radial-gradient(900px 500px at 70% 30%, rgba(34,211,238,0.16), transparent 55%), linear-gradient(180deg, rgba(0,0,0,0.24), rgba(0,0,0,0.62))';
      case 'DEEP_SEA':
        return 'radial-gradient(900px 500px at 30% 20%, rgba(96,165,250,0.14), transparent 55%), radial-gradient(900px 500px at 70% 60%, rgba(34,211,238,0.10), transparent 55%), linear-gradient(180deg, rgba(0,0,0,0.28), rgba(0,0,0,0.68))';
    }
  }, [scene]);

  return (
    <div className="view">
      <div className="viewTitle">Entertainment</div>
      <div className="viewSub">Pool • Wellness • Media • Scenes (simulated)</div>

      <div className="entShell" style={{ marginTop: 12, borderRadius: 14, padding: 12, border: '1px solid rgba(255,255,255,0.10)', background: bg }}>
        <div className="panelGrid" style={{ marginTop: 0 }}>
          <div className="kpi">
            <div className="panelTitle">Lighting Scenes</div>
            <div className="sub" style={{ marginTop: 6 }}>Select a scene to set the mood.</div>
            <div className="stabModes" style={{ marginTop: 10 }}>
              <button type="button" className={scene === 'SUNSET_DECK' ? 'tab active' : 'tab'} onClick={() => setScene('SUNSET_DECK')}>Sunset Deck</button>
              <button type="button" className={scene === 'AURORA' ? 'tab active' : 'tab'} onClick={() => setScene('AURORA')}>Aurora</button>
              <button type="button" className={scene === 'DEEP_SEA' ? 'tab active' : 'tab'} onClick={() => setScene('DEEP_SEA')}>Deep Sea</button>
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
              <input type="range" min={24} max={34} value={poolTemp} onChange={(e) => setPoolTemp(parseInt(e.target.value, 10))} />
              <span className="mono">{poolTemp}°C</span>
            </label>
            <div className="nav" style={{ marginTop: 6 }}>
              <button type="button" className={poolJets ? 'toggle on' : 'toggle off'} onClick={() => setPoolJets((v) => !v)}>
                Jets {poolJets ? 'ON' : 'OFF'}
              </button>
              <select className="input" style={{ padding: '10px 10px', width: 150 }} value={poolLights} onChange={(e) => setPoolLights(e.target.value as any)}>
                <option value="OFF">Lights: Off</option>
                <option value="AMBIENT">Lights: Ambient</option>
                <option value="PARTY">Lights: Party</option>
              </select>
            </div>

            <div className="hr" />

            <div className="sub" style={{ fontWeight: 900, opacity: 0.9 }}>Wellness</div>
            <label className="ctl">
              <span>Sauna</span>
              <input type="range" min={60} max={95} value={saunaTemp} onChange={(e) => setSaunaTemp(parseInt(e.target.value, 10))} />
              <span className="mono">{saunaTemp}°C</span>
            </label>
            <label className="ctl">
              <span>Steam</span>
              <input type="range" min={30} max={95} value={steamHumidity} onChange={(e) => setSteamHumidity(parseInt(e.target.value, 10))} />
              <span className="mono">{steamHumidity}%</span>
            </label>
            <div className="nav" style={{ marginTop: 6 }}>
              <button type="button" className={gymBoost ? 'toggle on' : 'toggle off'} onClick={() => setGymBoost((v) => !v)}>
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
                <button type="button" className={zone === 'LOUNGE' ? 'tab active' : 'tab'} onClick={() => setZone('LOUNGE')}>Lounge</button>
                <button type="button" className={zone === 'BALLROOM' ? 'tab active' : 'tab'} onClick={() => setZone('BALLROOM')}>Ballroom</button>
                <button type="button" className={zone === 'CABINS' ? 'tab active' : 'tab'} onClick={() => setZone('CABINS')}>Cabins</button>
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
                  <button type="button" className="btn" onClick={() => setPlaying((v) => !v)}>
                    {playing ? 'Pause' : 'Play'}
                  </button>
                  <button type="button" className="btn" onClick={() => setProgress((p) => clamp(p + 0.12, 0, 1))}>
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
                  <input type="range" min={0} max={100} value={volume} onChange={(e) => setVolume(parseInt(e.target.value, 10))} />
                  <span className="mono">{volume}%</span>
                </label>

                <div className="kpiLabel" style={{ marginTop: 10 }}>Queue</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                  {tracks.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={t.id === trackId ? 'tab active' : 'tab'}
                      onClick={() => setTrackId(t.id)}
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
