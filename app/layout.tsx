import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MAKERS VIBE CODING',
  description: '把一个粗略想法变成精致的应用、网站或原型。',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
