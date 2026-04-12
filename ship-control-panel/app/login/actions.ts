'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { clearAuthed, DEMO_PASS, DEMO_USER, setAuthed } from '../../lib/auth';

function logEvent(event: string, detail: any) {
  // One-line structured JSON for Sentinel / Log Analytics ingestion
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      service: 'ship-control-panel',
      event,
      detail,
    }),
  );
}

export async function loginAction(formData: FormData): Promise<void> {
  const username = String(formData.get('username') ?? '');
  const password = String(formData.get('password') ?? '');

  const h = await headers();
  const clientIp = h.get('x-forwarded-for') ?? h.get('x-real-ip') ?? null;
  const userAgent = h.get('user-agent') ?? null;

  if (username === DEMO_USER && password === DEMO_PASS) {
    await setAuthed();
    logEvent('auth.login.success', { username, clientIp, userAgent });
    redirect('/');
  }

  // ensure logged out
  await clearAuthed();
  logEvent('auth.login.failure', { username, clientIp, userAgent });
  redirect('/login?error=1');
}

export async function logoutAction(): Promise<void> {
  const h = await headers();
  const clientIp = h.get('x-forwarded-for') ?? h.get('x-real-ip') ?? null;
  const userAgent = h.get('user-agent') ?? null;

  await clearAuthed();
  logEvent('auth.logout', { clientIp, userAgent });
  redirect('/login');
}
