// Off-main-thread clock: posts a tick every `interval` ms.
// A worker timer keeps a stable cadence even when the main thread is busy,
// which is what keeps screen capture smooth (technique from gifcap).
self.onmessage = (e: MessageEvent<number>) => {
  setInterval(() => (self as unknown as Worker).postMessage(null), e.data);
};
