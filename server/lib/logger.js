import pino from "pino";

export function createLogger(service, destination) {
  return pino({ base: { service }, timestamp: pino.stdTimeFunctions.isoTime }, destination);
}
