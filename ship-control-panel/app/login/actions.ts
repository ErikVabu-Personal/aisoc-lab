'use server';

import { redirect } from 'next/navigation';
import { clearAuthed, DEMO_PASS, DEMO_USER, setAuthed } from '../../lib/auth';

export async function loginAction(formData: FormData): Promise<void> {
  const username = String(formData.get('username') ?? '');
  const password = String(formData.get('password') ?? '');

  if (username === DEMO_USER && password === DEMO_PASS) {
    await setAuthed();
    redirect('/');
  }

  // ensure logged out
  await clearAuthed();
  redirect('/login?error=1');
}

export async function logoutAction(): Promise<void> {
  await clearAuthed();
  redirect('/login');
}
