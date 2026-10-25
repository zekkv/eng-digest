import * as Sentry from "@sentry/tanstackstart-react";

const sentryDsn = process.env.VITE_SENTRY_DSN;

if (!sentryDsn) {
  console.warn("VITE_SENTRY_DSN is not defined. Sentry is disabled.");
}

if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    // Sentry v11 collects every data category by default. Keep the previous
    // no-PII posture: no user identifiers, cookies, request bodies or DB payloads.
    dataCollection: { userInfo: false, cookies: false, httpBodies: [], databaseQueryData: false },
    // Keep server traces at 10% in production to control volume and cost.
    // Raise to 1.0 temporarily for debugging, then lower before shipping.
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1,
    integrations: [],
  });
}
