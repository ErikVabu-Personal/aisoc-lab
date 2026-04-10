'use client';

import React from 'react';

export function PlaceholderView({ title }: { title: string }) {
  return (
    <div className="view">
      <div className="viewTitle">{title}</div>
      <div className="viewSub">Placeholder — we’ll complete this module later.</div>
      <div className="card" style={{ marginTop: 12 }}>
        <div className="sub">TODO items:</div>
        <div className="sub" style={{ marginTop: 8 }}>
          • Layout / widgets
          <br />• Data bindings
          <br />• Alerting rules
        </div>
      </div>
    </div>
  );
}
