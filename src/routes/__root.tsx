import { createRootRoute, Outlet } from "@tanstack/react-router";

import { Header } from "#/components/layout/header";
import { RootDocument } from "#/components/layout/root-document";
import { RootErrorPage, RootNotFoundPage } from "#/components/pages/error";
// oxlint-disable-next-line import/no-unassigned-import
import "../globals.css";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        name: "theme-color",
        content: "#F1F3F4",
      },
      {
        name: "color-scheme",
        content: "light dark",
      },
      {
        title: "eng-digest",
      },
    ],
    links: [{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }],
  }),
  shellComponent: ({ children }) => <RootDocument>{children}</RootDocument>,
  component: () => (
    <>
      <Header />
      <Outlet />
    </>
  ),
  errorComponent: RootErrorPage,
  notFoundComponent: RootNotFoundPage,
});
