import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Air Piano Duel",
  description:
    "A two-player rhythm duel played in the air. Your webcam tracks your hands, an AI builds the chart, and you and a friend go head to head.",
};

export const viewport: Viewport = {
  themeColor: "#07080a",
  width: "device-width",
  initialScale: 1,
  // A fixed broadcast stage; pinch-zoom only ever happens by accident here.
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        {/*
          Both faces are self-hosted and used above the fold — the scorebug and
          the room code are the first things drawn. Preloading them removes the
          swap flash that would otherwise land right as players are reading a
          code aloud to each other.
        */}
        <link
          rel="preload"
          href="/fonts/saira-var-latin.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <link
          rel="preload"
          href="/fonts/anton-latin.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body className="min-h-full antialiased">{children}</body>
    </html>
  );
}
