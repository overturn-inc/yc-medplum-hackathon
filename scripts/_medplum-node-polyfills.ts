/**
 * `@medplum/core` reads `globalThis.WebSocket` at module load time (for its
 * subscriptions client), which is not defined when running plain scripts
 * under Node versions without a global WebSocket. Mirrors the same stub used
 * by `tests/setup.ts` for the vitest process. Must be imported before any
 * module that transitively imports `@medplum/core` (e.g. `@/server/fhir-plane`).
 */
if (typeof globalThis.WebSocket === "undefined") {
  class WebSocketStub {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = WebSocketStub.CLOSED;
    close() {}
    send() {}
    addEventListener() {}
    removeEventListener() {}
  }
  (globalThis as unknown as { WebSocket: typeof WebSocketStub }).WebSocket =
    WebSocketStub;
}
