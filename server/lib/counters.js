export function createCounters() {
  const counts = new Map();
  const gauges = new Map();
  return {
    inc(name, by = 1) { counts.set(name, (counts.get(name) || 0) + by); },
    set(name, value) { gauges.set(name, value); },
    snapshot() {
      return { ...Object.fromEntries(counts), ...Object.fromEntries(gauges) };
    }
  };
}
