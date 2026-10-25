// oxlint-disable node/no-process-env

// Hermetic API keys. The digest clients read process.env directly, so unit tests
// never depend on the developer's `.env`.
process.env.OPENROUTER_API_KEY ??= "test-openrouter-key";
process.env.TAVILY_API_KEY ??= "test-tavily-key";
// Unit tests use fake hosts; skip the real DNS guard.
process.env.DIGEST_DNS_CHECK ??= "0";

if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
