// Protocol logging is silent by default. The old upstream sprayed console.debug
// on every message, forcing consumers to monkey-patch console to quieten it.
// Here a single `debug` flag (set from AndroidRemote options) gates all output.
let enabled = false

const setDebug = (value: boolean): void => {
  enabled = value
}

const log = {
  debug: (...args: unknown[]): void => {
    if (enabled) console.debug(...args)
  },
  info: (...args: unknown[]): void => {
    if (enabled) console.info(...args)
  },
  error: (...args: unknown[]): void => {
    if (enabled) console.error(...args)
  },
}

interface Logger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  error(...args: unknown[]): void
}

/**
 * A logger for one remote: on or off by its own `debug` option. Without one it follows the process-wide setDebug(), so
 * a CLI's --debug still reaches every remote that did not choose for itself.
 */
const createLogger = (debug?: boolean): Logger => {
  if (debug === undefined) return log
  const on = (fn: (...a: unknown[]) => void) => (...args: unknown[]) => {
    if (debug) fn(...args)
  }
  return { debug: on(console.debug), info: on(console.info), error: on(console.error) }
}

export { log, setDebug, createLogger }
export type { Logger }
