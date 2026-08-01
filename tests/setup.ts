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
  // @medplum/core imports WebSocket at module load; stub for Node test runs.
  (globalThis as unknown as { WebSocket: typeof WebSocketStub }).WebSocket =
    WebSocketStub;
}
