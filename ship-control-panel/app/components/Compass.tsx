'use client';

import React from 'react';

export function Compass({ heading }: { heading: number }) {
  return (
    <div className="compass" title="Compass">
      <div className="compassRing" />
      <div className="compassRose" style={{ transform: `rotate(${-heading}deg)` }}>
        <div className="compassN">N</div>
        <div className="compassE">E</div>
        <div className="compassS">S</div>
        <div className="compassW">W</div>
        {Array.from({ length: 24 }).map((_, i) => (
          <div
            key={i}
            className={i % 6 === 0 ? 'tick major' : 'tick'}
            style={{ transform: `rotate(${i * 15}deg)` }}
          />
        ))}
      </div>
      <div className="compassNeedle" />
      <div className="compassReadout mono">{heading.toString().padStart(3, '0')}°</div>
    </div>
  );
}
