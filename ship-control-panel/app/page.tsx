import { redirect } from 'next/navigation';
import { isAuthed } from '../lib/auth';
import { logoutAction } from './login/actions';

export default async function ControlPanelPage() {
  if (!(await isAuthed())) {
    redirect('/login');
  }

  return (
    <div className="wrap">
      <div className="card" style={{ width: 'min(1100px, 100%)' }}>
        <div className="nav">
          <div className="title">
            <span className="badge">CONTROL</span>
            <span>AEGIR // BRIDGE CONSOLE</span>
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <div className="pill mono">MODE: SIMULATION</div>
            <form action={logoutAction}>
              <button className="btn" type="submit" style={{ padding: '10px 12px' }}>
                Logout
              </button>
            </form>
          </div>
        </div>

        <div className="sub">
          Placeholder control panel. Next: wire up modules (navigation, propulsion, comms, alarms) and add live widgets.
        </div>

        <div className="panelGrid">
          <div className="kpi">
            <div className="kpiLabel">Heading</div>
            <div className="kpiValue mono">271°</div>
          </div>
          <div className="kpi">
            <div className="kpiLabel">Speed</div>
            <div className="kpiValue mono">12.4 kn</div>
          </div>
          <div className="kpi">
            <div className="kpiLabel">Depth</div>
            <div className="kpiValue mono">34 m</div>
          </div>
          <div className="kpi">
            <div className="kpiLabel">Radar</div>
            <div className="kpiValue mono">STANDBY</div>
          </div>

          <div className="kpi bigPanel" style={{ minHeight: 240 }}>
            <div className="kpiLabel">Bridge Systems</div>
            <div className="kpiValue" style={{ fontSize: 16, marginTop: 8 }}>
              Modules (placeholder)
            </div>
            <div className="sub" style={{ marginTop: 8 }}>
              • Navigation
              <br />• Propulsion
              <br />• Communications
              <br />• Ballast / Stability
              <br />• Power &amp; Aux
              <br />• Alerting
            </div>
          </div>

          <div className="kpi" style={{ minHeight: 180 }}>
            <div className="kpiLabel">Alerts</div>
            <div className="sub" style={{ marginTop: 8 }}>
              No active alerts.
            </div>
          </div>

          <div className="kpi" style={{ minHeight: 180 }}>
            <div className="kpiLabel">Comms</div>
            <div className="sub" style={{ marginTop: 8 }}>
              Channel: VHF-16 (monitor)
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
