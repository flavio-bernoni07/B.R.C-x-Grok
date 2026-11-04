import type { Metadata } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

// Satoshi (Fontshare, FFL licence in ./fonts): the HeyHandy brand face. Bold for headlines, Medium for body.
const satoshi = localFont({
  variable: "--font-satoshi",
  display: "swap",
  src: [
    { path: "./fonts/Satoshi-Medium.woff2", weight: "500", style: "normal" },
    { path: "./fonts/Satoshi-Bold.woff2", weight: "700", style: "normal" },
    { path: "./fonts/Satoshi-Black.woff2", weight: "900", style: "normal" },
  ],
});

export const metadata: Metadata = {
  title: "B.R.C x Grok",
  description: "Riso Scotti back office: orders checked by code, invoices matched against what shipped, claims answered with sources.",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html className={satoshi.variable} lang="en">
      <body className="font-medium text-ink">
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
