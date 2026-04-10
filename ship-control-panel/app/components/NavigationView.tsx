'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';

import { Compass } from './Compass';
import { Throttle } from './Throttle';
import { BarMeter, Gauge } from './Instruments';

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

// Start near Seattle; sail toward Alaska.
// We use a hand-crafted "water-ish" route that stays mostly on sea lanes (demo-only).
const START: [number, number] = [-122.3321, 47.6062];
const TARGET: [number, number] = [-135.0, 58.3];

const ROUTE: Array<[number, number]> = [
  // Seattle → Strait of Juan de Fuca
  [-122.3321, 47.6062],
  [-122.90, 48.05],
  [-123.35, 48.25],
  [-123.80, 48.45],
  [-124.35, 48.80],

  // Offshore Pacific (stay west of Vancouver Island)
  [-125.20, 49.60],
  [-126.30, 50.60],
  [-127.60, 51.70],
  [-129.00, 52.90],

  // Approach toward Haida Gwaii / Gulf of Alaska
  [-130.80, 54.30],
  [-132.50, 55.80],
  [-134.00, 57.00],
  [-135.00, 58.30],
];

export function NavigationView() {
  const [heading, setHeading] = useState(315);
  const [throttle, setThrottle] = useState(35);

  const mapRef = useRef<maplibregl.Map | null>(null);
  const mapDivRef = useRef<HTMLDivElement | null>(null);

  const [pos, setPos] = useState<{ lng: number; lat: number }>({ lng: START[0], lat: START[1] });

  // Move ship gradually toward Alaska; throttle controls speed.
  useEffect(() => {
    const t = window.setInterval(() => {
      setPos((p) => {
        // Follow the route polyline by moving toward the next waypoint.
        const coords = ROUTE;

        // Find nearest segment start index (cheap) so we can progress.
        let idx = 0;
        let best = Number.POSITIVE_INFINITY;
        for (let i = 0; i < coords.length; i++) {
          const dx0 = coords[i][0] - p.lng;
          const dy0 = coords[i][1] - p.lat;
          const d0 = dx0 * dx0 + dy0 * dy0;
          if (d0 < best) {
            best = d0;
            idx = i;
          }
        }
        const nextWp = coords[Math.min(idx + 1, coords.length - 1)];

        const dx = nextWp[0] - p.lng;
        const dy = nextWp[1] - p.lat;
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
      // Route line (Seattle -> Alaska)
      map.addSource('route', {
        type: 'geojson',
        data: {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: ROUTE },
          properties: {},
        },
      });
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        paint: {
          'line-color': 'rgba(34,211,238,0.75)',
          'line-width': 4,
          'line-blur': 0.5,
        },
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

      map.addLayer({
        id: 'ship-point',
        type: 'circle',
        source: 'ship',
        paint: {
          'circle-radius': 6,
          'circle-color': 'rgba(230,243,255,0.95)',
          'circle-stroke-color': 'rgba(34,211,238,0.65)',
          'circle-stroke-width': 3,
        },
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

  // Update ship + heading on map
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
  }, [pos, heading]);

  return (
    <div className="view">
      <div className="viewTitle">Navigation</div>
      <div className="viewSub">Destination: <b>ALASKA</b></div>

      <div className="navGrid">
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
            <div>HDG {heading.toString().padStart(3, '0')}°</div>
            <div>THR {throttle}%</div>
          </div>

          <div className="compassWrap">
            <Compass heading={heading} />
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

          <div className="hint" style={{ marginTop: 10 }}>
            Next: real route planning, AIS contacts, and collision alerts.
          </div>
        </div>
      </div>
    </div>
  );
}
