import * as React from "react";
import { Link } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";

import { Button } from "#/components/ui/button";

interface ErrorPageProps {
  error: unknown;
  reset?: () => void;
  title?: string;
  description?: string;
}

function rawMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}

export function ErrorPage({
  error,
  reset,
  title = "Something went wrong",
  description = "The page couldn't be shown. Try again — if it keeps failing, the server log has the details.",
}: ErrorPageProps) {
  const message = rawMessage(error);

  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-md flex-col justify-center px-6 py-16">
      <div className="w-full space-y-8">
        <div className="space-y-3">
          <p className="font-mono text-xs tracking-caps text-muted-foreground uppercase">Error</p>
          <h1 className="font-heading text-2xl font-semibold tracking-tight md:text-3xl">
            {title}
          </h1>
          <p className="leading-relaxed text-muted-foreground">{description}</p>
        </div>

        {message !== "" && (
          <details className="font-mono text-xs text-muted-foreground">
            <summary className="cursor-pointer">Error details</summary>
            <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-border bg-card p-4 break-words whitespace-pre-wrap">
              {message}
            </pre>
          </details>
        )}

        <div className="flex flex-col items-start gap-3">
          {reset && (
            <Button type="button" variant="link" size="sm" onClick={reset}>
              Try again
            </Button>
          )}
          <Button variant="link" size="sm" nativeButton={false} render={<Link to="/" />}>
            Back to home
          </Button>
        </div>
      </div>
    </main>
  );
}

/** The root route's error boundary. It renders inside the root shell's document. */
export function RootErrorPage(props: ErrorComponentProps) {
  React.useEffect(() => {
    // oxlint-disable-next-line no-console
    console.error(props.error);
  }, [props.error]);

  return <ErrorPage error={props.error} reset={props.reset} />;
}

/** The root route's 404 page. There is nothing to report. The address matched no route. */
export function RootNotFoundPage() {
  return (
    <ErrorPage
      error={null}
      title="404 - Not Found"
      description="The address didn't match a page here. Head back to the digest."
    />
  );
}
