import type { ReactNode } from 'react';
import './style.css';

export const metadata = {
  title: 'SightBridge',
  description: 'Self-hosted real-time video support platform',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
