import { loginAction } from './actions';

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
            <span className="badge">DEMO</span>
            <span>AEGIR // SHIP SYSTEMS</span>
          </div>
          <div className="sub">
            Nautical control interface — authorized crew only. This is a placeholder UI for a SOC demo.
          </div>

          <div className="grid">
            <div className="kpi">
              <div className="kpiLabel">Hull Integrity</div>
              <div className="kpiValue">98%</div>
            </div>
            <div className="kpi">
              <div className="kpiLabel">Reactor Output</div>
              <div className="kpiValue">1.2 GW</div>
            </div>
            <div className="kpi">
              <div className="kpiLabel">Nav Status</div>
              <div className="kpiValue">LOCKED</div>
            </div>
            <div className="kpi">
              <div className="kpiLabel">Sea State</div>
              <div className="kpiValue">CALM</div>
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
            Demo authentication only — do not reuse this pattern in production.
          </div>
        </div>
      </div>
    </div>
  );
}
