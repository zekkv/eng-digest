import { createCsrfMiddleware, createStart } from "@tanstack/react-start";

/** TanStack Start instance. Server functions are same-origin RPC, and CSRF middleware guards them. */
export const startInstance = createStart(() => {
  const csrfMiddleware = createCsrfMiddleware({
    filter: context => context.handlerType === "serverFn",
  });
  return { requestMiddleware: [csrfMiddleware] };
});
