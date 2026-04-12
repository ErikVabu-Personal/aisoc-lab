import { loginAction } from './actions';
import { BarMeter, Gauge, LockStatus, SeaState } from '../components/Instruments';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const error = sp.error === '1';

  return (
    <div className="wrap">
      <div className="shell">
        <div className="card holo">
          <div className="title">
            <span className="badge">AEGIR</span>
            <span>SHIP SYSTEMS</span>
          </div>
          <div className="sub">
            Nautical control interface — authorized crew only.
          </div>

          <div className="grid">
            <div className="kpi">
              <BarMeter label="Hull Integrity" value={98} />
            </div>
            <div className="kpi">
              <Gauge label="Reactor Output" value={72} min={0} max={100} unit="%" />
            </div>
            <div className="kpi">
              <LockStatus label="Nav Status" locked={true} />
            </div>
            <div className="kpi">
              <SeaState label="Sea State" level="CALM" />
            </div>
          </div>

          <div className="hr" />

          <div className="sub mono">
            Hint: username <b>administrator</b> / password <b>controlpanel123</b>
          </div>
        </div>

        <div className="card">
          <div className="title">
            <span className="badge">AUTH</span>
            <span>LOGIN</span>
          </div>
          <div className="sub">Enter credentials to access the control panel.</div>

          {error ? <div className="err" style={{ marginTop: 12 }}>Invalid credentials.</div> : null}

          <form className="form" action={loginAction}>
            <input className="input" name="username" placeholder="username" autoComplete="username" />
            <input
              className="input"
              name="password"
              placeholder="password"
              type="password"
              autoComplete="current-password"
            />
            <button className="btn" type="submit">Access Control Panel</button>
          </form>

          <div className="sub" style={{ marginTop: 10 }}>
            &nbsp;
          </div>
        </div>
      </div>
    </div>
  );
}
