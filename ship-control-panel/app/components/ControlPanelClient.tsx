'use client';

import React, { useState } from 'react';
import { Tabs, type TabKey } from './Tabs';
import { NavigationView } from './NavigationView';
import { EngineRoomView } from './EngineRoomView';
import { PlaceholderView } from './PlaceholderView';
import { ClimateView } from './ClimateView';
import { ConnectivityView } from './ConnectivityView';

export function ControlPanelClient() {
  const [tab, setTab] = useState<TabKey>('nav');

  return (
    <>
      <Tabs value={tab} onChange={setTab} />
      <div style={{ marginTop: 12 }}>
        {tab === 'nav' ? <NavigationView /> : null}
        {tab === 'engine' ? <EngineRoomView /> : null}
        {tab === 'stabilizers' ? <PlaceholderView title="Stabilizers" /> : null}
        {tab === 'entertainment' ? <PlaceholderView title="Entertainment" /> : null}
        {tab === 'climate' ? <ClimateView /> : null}
        {tab === 'connectivity' ? <ConnectivityView /> : null}
      </div>
    </>
  );
}
