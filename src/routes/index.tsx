import { createFileRoute } from "@tanstack/react-router";

import { ErrorPage } from "#/components/pages/error";
import { DigestPage, DigestPageSkeleton } from "#/features/digest/components/page";
import { getDigest } from "#/features/digest/server-fns";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "eng-digest" },
      {
        name: "description",
        content:
          "A daily digest of engineering blog posts with summaries, key points, and jargon decoded.",
      },
    ],
  }),
  loader: async () => getDigest({ data: {} }),
  pendingComponent: DigestPageSkeleton,
  errorComponent: ({ error, reset }) => (
    <ErrorPage
      error={error}
      reset={reset}
      title="The digest didn't load"
      description="The server may be unreachable or its cache unreadable. Check your connection, then try again."
    />
  ),
  component: () => {
    return <DigestPage data={Route.useLoaderData()} />;
  },
});
