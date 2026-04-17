import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MRI X Jas Helper — AI Radiology Assistant",
  description: "Medical-grade AI assistant for MRI and X-ray analysis. Accurate, affordable, always available.",
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-[#F8FAFC] text-[#0F172A] font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
