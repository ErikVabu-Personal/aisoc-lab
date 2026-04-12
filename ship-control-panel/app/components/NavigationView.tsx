'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';

import { Compass } from './Compass';
import { Throttle } from './Throttle';
import { BarMeter, Gauge } from './Instruments';
import { SHIP_SVG } from './shipIcon';
import { useAppState } from './useAppState';

type OtherShip = { lng: number; lat: number; id: string };

function rand(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function makeOtherShips(): OtherShip[] {
  // Place ships well offshore (west of the coast) to avoid land.
  // Push further west than before.
  const ships: OtherShip[] = [];
  for (let i = 0; i < 8; i++) {
    ships.push({
      id: `s${i + 1}`,
      lng: rand(-150, -136),
      lat: rand(44, 58),
    });
  }
  return ships;
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

// Start near Seattle.
const START: [number, number] = [-122.3321, 47.6062];
const DEFAULT_DEST: [number, number] = [-135.0, 58.3];

type LngLat = { lng: number; lat: number };

function fmtCoord(n: number) {
  const s = n.toFixed(3);
  return s === '-0.000' ? '0.000' : s;
}

export function NavigationView() {
  const { state, loading, post } = useAppState();

  const [heading, setHeading] = useState(315);
  const [throttle, setThrottle] = useState(35);

  const [dest, setDest] = useState<LngLat>({ lng: DEFAULT_DEST[0], lat: DEFAULT_DEST[1] });
  const destLabel = `${fmtCoord(dest.lat)}, ${fmtCoord(dest.lng)}`;

  const collisionEnabled = state?.collision?.enabled ?? true;

  const otherShips = useMemo(() => makeOtherShips(), []);

  const mapRef = useRef<maplibregl.Map | null>(null);
  const mapDivRef = useRef<HTMLDivElement | null>(null);

  const [pos, setPos] = useState<LngLat>({ lng: START[0], lat: START[1] });

  // Move ship gradually toward destination; throttle controls speed.
  useEffect(() => {
    const t = window.setInterval(() => {
      setPos((p) => {
        // Follow the route polyline by moving toward the next waypoint.
        const dx = dest.lng - p.lng;
        const dy = dest.lat - p.lat;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;

        // speed factor tuned for demo
        const step = (throttle / 100) * 0.02;
        const next = {
          lng: p.lng + (dx / dist) * step,
          lat: p.lat + (dy / dist) * step,
        };

        // crude heading from velocity vector
        const brg = (Math.atan2(dx, dy) * 180) / Math.PI;
        const h = (brg + 360) % 360;
        setHeading(Math.round(h));

        return next;
      });
    }, 600);
    return () => window.clearInterval(t);
  }, [throttle]);

  const [mapError, setMapError] = useState<string | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);

  // Initialize MapLibre once
  useEffect(() => {
    if (!mapDivRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapDivRef.current,
      style: 'https://demotiles.maplibre.org/style.json',
      center: START,
      zoom: 4.2,
      attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');

    map.on('error', (e) => {
      // MapLibre error events are a bit loose-typed
      const msg = (e as any)?.error?.message || (e as any)?.error || (e as any)?.message || 'Map error';
      console.error('[MapLibre] error', e);
      setMapError(String(msg));
    });

    map.on('load', () => {
      setMapLoaded(true);
      setMapError(null);

      // Provide a ship icon for symbol layers (robust against style reloads)
      try {
        const svg = SHIP_SVG.replace('currentColor', '#ffffff');
        const img = new Image();
        img.onload = () => {
          try {
            if (!map.hasImage('ship-icon')) map.addImage('ship-icon', img, { pixelRatio: 2 });
          } catch (e) {
            console.error('[MapLibre] addImage failed', e);
          }
        };
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

        map.on('styleimagemissing', (e: any) => {
          if (e?.id !== 'ship-icon') return;
          try {
            if (!map.hasImage('ship-icon')) map.addImage('ship-icon', img, { pixelRatio: 2 });
          } catch (err) {
            console.error('[MapLibre] addImage (styleimagemissing) failed', err);
          }
        });
      } catch {
        // ignore
      }
      // Destination marker (draggable)
      map.addSource('dest', {
        type: 'geojson',
        data: {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [dest.lng, dest.lat] },
          properties: {},
        },
      });

      map.addLayer({
        id: 'dest-point',
        type: 'circle',
        source: 'dest',
        paint: {
          'circle-radius': 7,
          'circle-color': 'rgba(34,211,238,0.0)',
          'circle-stroke-color': 'rgba(34,211,238,0.95)',
          'circle-stroke-width': 3,
        },
      });

      map.addLayer({
        id: 'dest-glow',
        type: 'circle',
        source: 'dest',
        paint: {
          'circle-radius': 18,
          'circle-color': 'rgba(34,211,238,0.12)',
        },
      });

      // Draggable HTML marker handle for destination
      const el = document.createElement('div');
      el.className = 'destHandle';
      const mk = new maplibregl.Marker({ element: el, draggable: true })
        .setLngLat([dest.lng, dest.lat])
        .addTo(map);
      mk.on('dragend', () => {
        const ll = mk.getLngLat();
        setDest({ lng: ll.lng, lat: ll.lat });
      });

      // Ship position
      map.addSource('ship', {
        type: 'geojson',
        data: {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [START[0], START[1]] },
          properties: {},
        },
      });

      // Current ship (red) + other ships (yellow)
      // Use circles as a reliable fallback if the custom icon fails to register.
      const hasShipIcon = () => {
        try {
          return map.hasImage('ship-icon');
        } catch {
          return false;
        }
      };

      const ensureShipLayers = () => {
        // Remove existing layers if they exist (idempotent)
        for (const id of ['ship-point', 'others-ships']) {
          if (map.getLayer(id)) map.removeLayer(id);
        }

        if (hasShipIcon()) {
          map.addLayer({
            id: 'ship-point',
            type: 'symbol',
            source: 'ship',
            layout: {
              'icon-image': 'ship-icon',
              'icon-size': 0.4,
              'icon-allow-overlap': true,
            },
            paint: {
              'icon-color': 'rgba(251,113,133,0.98)',
            },
          });

          map.addLayer({
            id: 'others-ships',
            type: 'symbol',
            source: 'others',
            layout: {
              'icon-image': 'ship-icon',
              'icon-size': 0.35,
              'icon-allow-overlap': true,
            },
            paint: {
              'icon-color': 'rgba(250,204,21,0.95)',
            },
          });
        } else {
          map.addLayer({
            id: 'ship-point',
            type: 'circle',
            source: 'ship',
            paint: {
              'circle-radius': 7,
              'circle-color': 'rgba(251,113,133,0.95)',
              'circle-stroke-color': 'rgba(255,255,255,0.85)',
              'circle-stroke-width': 2,
            },
          });

          map.addLayer({
            id: 'others-ships',
            type: 'circle',
            source: 'others',
            paint: {
              'circle-radius': 6,
              'circle-color': 'rgba(250,204,21,0.95)',
              'circle-stroke-color': 'rgba(0,0,0,0.35)',
              'circle-stroke-width': 2,
            },
          });
        }
      };

      // Other ships source
      map.addSource('others', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: otherShips.map((s) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
            properties: { id: s.id },
          })),
        },
      });

      ensureShipLayers();

      // If the style requests the ship icon later, add it and re-install symbol layers.
      map.on('styleimagemissing', (e: any) => {
        if (e?.id !== 'ship-icon') return;
        // icon registration happens elsewhere; just re-check and rebuild layers on next tick
        window.setTimeout(() => {
          try {
            ensureShipLayers();
          } catch {
            // ignore
          }
        }, 0);
      });

      // Heading vector (line forward)
      map.addSource('heading', {
        type: 'geojson',
        data: {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[START[0], START[1]], [START[0], START[1]]] },
          properties: {},
        },
      });

      map.addLayer({
        id: 'heading-line',
        type: 'line',
        source: 'heading',
        paint: {
          'line-color': 'rgba(96,165,250,0.85)',
          'line-width': 3,
          'line-dasharray': [1, 1],
        },
      });
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Update ship + heading + destination on map
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const ship = map.getSource('ship') as maplibregl.GeoJSONSource | undefined;
    if (ship) {
      ship.setData({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [pos.lng, pos.lat] },
        properties: {},
      });
    }

    const destSrc = map.getSource('dest') as maplibregl.GeoJSONSource | undefined;
    if (destSrc) {
      destSrc.setData({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [dest.lng, dest.lat] },
        properties: {},
      });
    }

    const len = 1.3; // degrees-ish, fine for demo zoom
    const rad = (heading * Math.PI) / 180;
    const hx = pos.lng + Math.sin(rad) * len;
    const hy = pos.lat + Math.cos(rad) * len;

    const headingSrc = map.getSource('heading') as maplibregl.GeoJSONSource | undefined;
    if (headingSrc) {
      headingSrc.setData({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[pos.lng, pos.lat], [hx, hy]] },
        properties: {},
      });
    }
  }, [pos, heading, dest]);

  return (
    <div className="view">
      <div className="viewTitle">Navigation</div>
      <div className="viewSub">Destination: <b className="mono">{destLabel}</b></div>

      <div className="navGrid">
        <div>
          <div className="mapWrap">
          <div ref={mapDivRef} className="map" />

          {!mapLoaded ? (
            <div className="mapOverlay">
              <div className="mapOverlayCard">
                <div style={{ fontWeight: 900 }}>Loading map…</div>
                <div style={{ marginTop: 6, opacity: 0.8 }}>If this never finishes, it’s usually a tile/style network issue.</div>
              </div>
            </div>
          ) : null}

          {mapError ? (
            <div className="mapOverlay">
              <div className="mapOverlayCard" style={{ borderColor: 'rgba(251,113,133,0.35)' }}>
                <div style={{ fontWeight: 900, color: 'rgba(255,180,180,0.95)' }}>Map failed to load</div>
                <div className="mono" style={{ marginTop: 6, whiteSpace: 'pre-wrap', fontSize: 11 }}>{mapError}</div>
              </div>
            </div>
          ) : null}

          <div className="mapHud mono">
            <div>POS {pos.lat.toFixed(3)}, {pos.lng.toFixed(3)}</div>
            <div>DST {dest.lat.toFixed(3)}, {dest.lng.toFixed(3)}</div>
            <div>HDG {heading.toString().padStart(3, '0')}°</div>
            <div>THR {throttle}%</div>
          </div>


          <div className="compassWrap">
            <Compass heading={heading} />
          </div>
        </div>

        <div className="collisionUnderMap">
          <div className="collisionTitle">Collision Detection System</div>
          <button
            type="button"
            className={collisionEnabled ? 'toggle on' : 'toggle off'}
            onClick={() => post('setCollision', { enabled: !collisionEnabled }).catch(() => {})}
            disabled={loading}
          >
            {collisionEnabled ? 'Enabled' : 'Disabled'}
          </button>

          <div className={collisionEnabled ? 'status safe' : 'status disabled'}>
            <span className={collisionEnabled ? 'safeDot' : 'dangerDot'} /> {collisionEnabled ? 'SAFE' : 'OFFLINE'}
          </div>
        </div>
      </div>

        <div className="panel">
          <div className="panelTitle">Helm</div>

          <div className="helmGrid">
            <Throttle label="Speed / Throttle" value={throttle} onChange={(v) => setThrottle(clamp(v, 0, 100))} />

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="kpi">
                <Gauge label="Fuel" value={82} min={0} max={100} unit="%" />
              </div>
              <div className="kpi">
                <BarMeter label="Wind" value={38} max={100} />
              </div>
              <div className="kpi">
                <BarMeter label="Depth" value={64} max={100} />
                <div className="gSub mono" style={{ marginTop: 6 }}>~ 64 m</div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
