import { cookies } from 'next/headers';

async function cookieStore() {
  // Next 15 typing: cookies() may be Promise-like in type defs; normalize.
  return await cookies();
}

const COOKIE_NAME = 'scp_auth';

// Demo-only hardcoded credentials (as requested).
// `administrator` is a deliberately-shared / generic SCP account.
// The demo narrative does NOT lean on the username to identify
// who actually pressed the keys — it leans on cross-source
// correlation: the source IP of failed logins maps to a known
// workstation (BRIDGE-WS), and Windows auth logs on that
// workstation show which human (jack.sparrow) was interactively
// signed in at the time. That correlation is what the agents
// learn from the company-context KB and reproduce at runtime.
export const DEMO_USER = 'administrator';
export const DEMO_PASS = 'pirates';

export async function isAuthed(): Promise<boolean> {
  const store = await cookieStore();
  const c = store.get(COOKIE_NAME)?.value;
  return c === '1';
}

export async function setAuthed(): Promise<void> {
  const store = await cookieStore();
  store.set(COOKIE_NAME, '1', {
    httpOnly: true,
    sameSite: 'lax',
    // In Azure Container Apps you're always behind HTTPS at the edge.
    // Setting secure=true avoids cookies being dropped/ignored.
    secure: true,
    path: '/',
    maxAge: 60 * 60 * 12, // 12h demo session
  });
}

export async function clearAuthed(): Promise<void> {
  const store = await cookieStore();
  store.set(COOKIE_NAME, '0', {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    path: '/',
    maxAge: 0,
  });
}
