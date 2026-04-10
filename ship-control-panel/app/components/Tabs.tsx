'use client';

import React from 'react';

export type TabKey = 'nav' | 'engine' | 'stabilizers' | 'entertainment';

export function Tabs({
  value,
  onChange,
}: {
  value: TabKey;
  onChange: (k: TabKey) => void;
}) {
  const items: Array<{ k: TabKey; label: string }> = [
    { k: 'nav', label: 'Navigation' },
    { k: 'engine', label: 'Engine room' },
    { k: 'stabilizers', label: 'Stabilizers' },
    { k: 'entertainment', label: 'Entertainment' },
  ];

  return (
    <div className="tabs">
      {items.map((it) => (
        <button
          key={it.k}
          type="button"
          className={value === it.k ? 'tab active' : 'tab'}
          onClick={() => onChange(it.k)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
