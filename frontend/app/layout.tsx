import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Mark it Down",
  description:
    "Convert Word, PowerPoint and PDF documents into Markdown. No AI is used.",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
