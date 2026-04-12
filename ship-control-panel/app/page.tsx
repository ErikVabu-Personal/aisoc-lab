import { redirect } from 'next/navigation';
import { isAuthed } from '../lib/auth';
import { logoutAction } from './login/actions';
import { ControlPanelClient } from './components/ControlPanelClient';

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
            <form action={logoutAction}>
              <button className="btn" type="submit" style={{ padding: '10px 12px' }}>
                Logout
              </button>
            </form>
          </div>
        </div>


        <ControlPanelClient />
      </div>
    </div>
  );
}
