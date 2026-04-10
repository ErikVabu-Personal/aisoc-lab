import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Aegir — Ship Control Panel',
  description: 'Nautical-themed demo control panel',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
