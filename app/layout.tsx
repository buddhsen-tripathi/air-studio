import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Air Studio — play instruments in the air",
  description:
    "Play drums, keys and strings in front of your webcam using hand tracking, with an AI that arranges the instrument layout for any song you name.",
};

export const viewport: Viewport = {
  themeColor: "#08090c",
  width: "device-width",
  initialScale: 1,
  // The studio is a fixed stage; pinch-zooming it only ever happens by accident.
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-full antialiased">{children}</body>
    </html>
  );
}
