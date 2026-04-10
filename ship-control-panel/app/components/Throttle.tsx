'use client';

import React from 'react';

export function Throttle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number; // 0..100
  onChange: (v: number) => void;
}) {
  return (
    <div className="throttle">
      <div className="thLabel">{label}</div>
      <div className="thBody">
        {/* Invisible slider on top for drag/touch */}
        <input
          className="thSlider"
          type="range"
          min={0}
          max={100}
          value={value}
          onChange={(e) => onChange(parseInt(e.target.value, 10))}
        />
        <div className="thTrack" />
        <div className="thHandle" style={{ bottom: `${value}%` }}>
          <div className="thVal mono">{value}%</div>
        </div>
      </div>
    </div>
  );
}
