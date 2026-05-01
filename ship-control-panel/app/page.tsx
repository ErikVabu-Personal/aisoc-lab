import { redirect } from 'next/navigation';
import { isAuthed, DEMO_USER } from '../lib/auth';
import { logoutAction } from './login/actions';
import { ControlPanelClient } from './components/ControlPanelClient';

export default async function ControlPanelPage() {
  if (!(await isAuthed())) {
    redirect('/login');
  }

  // The demo only has one signed-in identity (DEMO_USER from
  // lib/auth). When this evolves to real per-user sessions, swap the
  // constant for the resolved session user — the rest of the header
  // chrome doesn't care.
  const officerLocal = DEMO_USER;
  const officerInitials = officerLocal
    .split(/[.\-_]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() || '')
    .join('') || 'BO';

  return (
    <div className="wrap">
      <div className="card">
        {/* ── Bridge header — NVISO logo + Cruises subtitle + system label ── */}
        <header className="bridge-header">
          <div className="bridge-brand">
            <span className="brand-mark">
              <img src="/nviso-logo.png" alt="NVISO" />
              <span className="brand-sub">CRUISES</span>
            </span>
            <span className="divider" aria-hidden="true"></span>
            <div className="system">
              <span className="system-title">Bridge &amp; Operations</span>
              <span className="system-sub">Crew Control System · v4.6</span>
            </div>
          </div>

          <div className="bridge-meta">
            <span className="field">
              <span>Vessel</span>
              <span className="v">M/S Aegir</span>
            </span>
            <span className="field">
              <span>Voyage</span>
              <span className="v">CR-2614 · Day 4 of 11</span>
            </span>
            <span className="field">
              <span>Position</span>
              <span className="v">58°18′N · 135°00′W</span>
            </span>
            <span className="field">
              <span>Sea state</span>
              <span className="v">3 · Slight</span>
            </span>
          </div>

          <div className="bridge-officer">
            <div className="avatar" aria-hidden="true">{officerInitials}</div>
            <div>
              <div className="name">{officerLocal}</div>
              <div className="role">Bridge officer</div>
            </div>
            <form action={logoutAction}>
              <button className="logout" type="submit">Sign out</button>
            </form>
          </div>
        </header>

        {/* ── Live status strip — always visible context for the
            officer regardless of which subsystem tab is active ── */}
        <div className="bridge-status">
          <span className="ind ok"><span className="dot"></span>System <span className="v">Nominal</span></span>
          <span className="ind">Heading <span className="v">298°</span></span>
          <span className="ind">Speed <span className="v">21.4 kn</span></span>
          <span className="ind">Wind <span className="v">12 kn / NW</span></span>
          <span className="ind">Engines <span className="v">3 of 4 online</span></span>
          <span className="ind">Stabilisers <span className="v">Auto</span></span>
        </div>

        {/* ── Body — tab strip + selected subsystem view ── */}
        <main className="bridge-body">
          <ControlPanelClient />
        </main>
      </div>
    </div>
  );
}
