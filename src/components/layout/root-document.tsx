import { HeadContent, Scripts } from "@tanstack/react-router";
import { ThemeProvider, useTheme } from "next-themes";
import { useEffect } from "react";
import type { ReactNode } from "react";

import { Toaster } from "#/components/ui/sonner";

/**
 * The router removes duplicate head tags by name. It scans back-to-front, which dropped
 * one tag of a light/dark theme-color pair. So the app uses one static meta tag plus this sync instead.
 */
function ThemeColorSync() {
  const { resolvedTheme } = useTheme();
  useEffect(() => {
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", resolvedTheme === "dark" ? "#141A1F" : "#F1F3F4");
  }, [resolvedTheme]);
  return null;
}

/**
 * The HTML document that the root route renders. It lives beside the header, not in
 * `src/routes/__root.tsx`. This keeps that file to routing only.
 */
export function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <ThemeProvider attribute="class" defaultTheme="light">
          <ThemeColorSync />
          {children}
        </ThemeProvider>
        <Scripts />
        <Toaster richColors />
      </body>
    </html>
  );
}
