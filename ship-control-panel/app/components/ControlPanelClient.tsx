'use client';

import React, { useState } from 'react';
import { Tabs, type TabKey } from './Tabs';
import { NavigationView } from './NavigationView';
import { EngineRoomView } from './EngineRoomView';
import { PlaceholderView } from './PlaceholderView';
import { ClimateView } from './ClimateView';
import { ConnectivityView } from './ConnectivityView';
import { AnchorView } from './AnchorView';
import { EntertainmentView } from './EntertainmentView';
import { SecurityView } from './SecurityView';

export function ControlPanelClient() {
  const [tab, setTab] = useState<TabKey>('nav');

  return (
    <>
      <Tabs value={tab} onChange={setTab} />
      <div>
        {tab === 'nav' ? <NavigationView /> : null}
        {tab === 'engine' ? <EngineRoomView /> : null}
        {tab === 'stabilizers' ? <AnchorView /> : null}
        {tab === 'security' ? <SecurityView /> : null}
        {tab === 'entertainment' ? <EntertainmentView /> : null}
        {tab === 'climate' ? <ClimateView /> : null}
        {tab === 'connectivity' ? <ConnectivityView /> : null}
      </div>
    </>
  );
}
