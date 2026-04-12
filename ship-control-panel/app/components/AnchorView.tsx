'use client';

import React, { useEffect, useMemo, useState } from 'react';

type AnchorState = 'HOME' | 'PAYING_OUT' | 'HOLDING' | 'DRAGGING';

function nextState(current: AnchorState, action: 'drop' | 'heave'): AnchorState {
  if (action === 'drop') {
    if (current === 'HOME') return 'PAYING_OUT';
    if (current === 'PAYING_OUT') return 'HOLDING';
    if (current === 'HOLDING') return 'HOLDING';
    if (current === 'DRAGGING') return 'HOLDING';
  }
  // heave (pull in)
  if (current === 'HOME') return 'HOME';
  if (current === 'PAYING_OUT') return 'HOME';
  if (current === 'HOLDING') return 'HOME';
  if (current === 'DRAGGING') return 'HOME';
  return 'HOME';
}

function iconFor(s: AnchorState): string {
  switch (s) {
    case 'HOME':
      return '⚓';
    case 'PAYING_OUT':
      return '⬇';
    case 'HOLDING':
      return '⛓';
    case 'DRAGGING':
      return '⚠';
  }
}

export function AnchorView() {
  const [state, setState] = useState<AnchorState>('HOME');
  const [chainPct, setChainPct] = useState(0); // 0..100
  const [lastAction, setLastAction] = useState<string>('');

  // Simulate transitions
  useEffect(() => {
    if (state === 'PAYING_OUT') {
      const t = window.setInterval(() => {
        setChainPct((p) => {
          const next = Math.min(100, p + 4);
          if (next >= 100) {
            setState('HOLDING');
          }
          return next;
        });
      }, 400);
      return () => window.clearInterval(t);
    }
    return;
  }, [state]);

  // Occasional dragging event while holding (demo)
  useEffect(() => {
    if (state !== 'HOLDING') return;
    const t = window.setInterval(() => {
      if (Math.random() < 0.08) {
        setState('DRAGGING');
        setLastAction('Drag detected');
      }
    }, 1500);
    return () => window.clearInterval(t);
  }, [state]);

  const states: Array<{ k: AnchorState; label: string; desc: string }> = useMemo(
    () => [
      { k: 'HOME', label: 'Home', desc: 'Anchor secured in the ship' },
      { k: 'PAYING_OUT', label: 'Paying out', desc: 'Anchor going down' },
      { k: 'HOLDING', label: 'Holding', desc: 'Anchor set, ship secured' },
      { k: 'DRAGGING', label: 'Dragging', desc: 'Anchor set, ship not secured' },
    ],
    [],
  );

  function drop() {
    setLastAction('Drop');
    if (state === 'HOME') {
      setChainPct(0);
      setState('PAYING_OUT');
    } else if (state === 'HOLDING' || state === 'DRAGGING') {
      setState('HOLDING');
    }
  }

  function heave() {
    setLastAction('Heave in');
    setChainPct(0);
    setState('HOME');
  }

  return (
    <div className="view">
      <div className="viewTitle">Anchor</div>
      <div className="viewSub">Anchor status + controls (simulated).</div>

      <div className="panelGrid" style={{ marginTop: 12 }}>
        <div className="kpi bigPanel">
          <div className="panelTitle">Status</div>
          <div className="anchorRow">
            {states.map((s) => {
              const active = s.k === state;
              return (
                <div key={s.k} className={active ? 'anchorState active' : 'anchorState'}>
                  <div className="anchorIcon" aria-hidden>{iconFor(s.k)}</div>
                  <div>
                    <div className="anchorLabel">{s.label}</div>
                    <div className="anchorDesc">{s.desc}</div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="hr" />

          <div className="anchorMeta">
            <div className="pill mono">CHAIN: {chainPct}%</div>
            <div className={state === 'DRAGGING' ? 'pill mono warn' : 'pill mono'}>
              STATE: {state}
            </div>
            {lastAction ? <div className="pill mono">LAST: {lastAction}</div> : null}
          </div>
        </div>

        <div className="kpi">
          <div className="panelTitle">Controls</div>
          <div className="sub" style={{ marginTop: 6 }}>
            Use these controls to pay out (drop) or heave in (pull up) the anchor.
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
            <button className="btn" type="button" onClick={drop}>
              Pay out (drop)
            </button>
            <button className="btn" type="button" onClick={heave}>
              Heave in
            </button>
          </div>

          <div className="sub" style={{ marginTop: 12, opacity: 0.75 }}>
            Note: we can rename “Heave in” to “Retrieve” if you prefer.
          </div>
        </div>
      </div>
    </div>
  );
}
