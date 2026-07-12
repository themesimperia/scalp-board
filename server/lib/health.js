export function healthPayload(startTs, counters, extra = {}) {
  return {
    status: "ok",
    uptimeMs: Date.now() - startTs,
    counters: counters.snapshot(),
    ts: Date.now(),
    ...extra
  };
}

export function handleHealthRequest(req, res, getPayload) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(getPayload()));
}
