import { cookies } from 'next/headers';

async function cookieStore() {
  // Next 15 typing: cookies() may be Promise-like in type defs; normalize.
  return await cookies();
}

const COOKIE_NAME = 'scp_auth';

// Demo-only hardcoded credentials (as requested)
export const DEMO_USER = 'administrator';
export const DEMO_PASS = 'controlpanel123';

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
