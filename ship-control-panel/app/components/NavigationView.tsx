'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { Compass } from './Compass';
import { Throttle } from './Throttle';

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

// Start near Seattle; sail toward Alaska (rough bearing)
const START: [number, number] = [-122.3321, 47.6062];
const TARGET: [number, number] = [-135.0, 58.3];

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
        const dx = TARGET[0] - p.lng;
        const dy = TARGET[1] - p.lat;
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

    map.on('load', () => {
      // Route line (Seattle -> Alaska)
      map.addSource('route', {
        type: 'geojson',
        data: {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [START, TARGET] },
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
      <div className="viewSub">Interactive world map (MapLibre). Ship starts near Seattle and sails toward Alaska.</div>

      <div className="navGrid">
        <div className="mapWrap">
          <div ref={mapDivRef} className="map" />
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

          <Throttle label="Speed / Throttle" value={throttle} onChange={(v) => setThrottle(clamp(v, 0, 100))} />

          <div className="hint" style={{ marginTop: 10 }}>
            Next: real route planning, AIS contacts, and collision alerts.
          </div>
        </div>
      </div>
    </div>
  );
}
