import tls from "node:tls"
import * as messages from "./pairing-message-manager.js"
import { createFrameReader } from "../framing.js"
import { generateCertificate } from "../certificate/certificate-generator.js"
import { pairingSecret, type RsaKey } from "./secret.js"
import { log as defaultLog, type Logger } from "../logger.js"
import type { Certificate } from "../types.js"

interface PairingResponse {
  status: number
  pairingRequestAck?: unknown
  pairingOption?: unknown
  pairingConfigurationAck?: unknown
  pairingSecretAck?: unknown
  toJSON(): unknown
}

/** How a code ended: accepted, rejected (start again for a new code), or refused by the TV for another reason. */
type PairingResult = "paired" | "wrong_code" | "tv_refused"

type PairingErrorReason = "unreachable" | "refused" | "timeout" | "cancelled"

/** Pairing could not reach the point where the TV shows its code, or a step ran out of time. */
class PairingError extends Error {
  constructor(
    readonly reason: PairingErrorReason,
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = "PairingError"
  }
}

interface PairingOptions {
  /** The client certificate to pair; a new self-signed one is generated when absent. */
  cert?: Certificate
  /** Default 6467. */
  port?: number
  /** Shown on the TV's pairing screen. Default "androidtv-remote". */
  serviceName?: string
  /** This client's name, sent in the pairing request. */
  clientName?: string
  /** Until the TV shows its code. Default 10 s. */
  timeoutMs?: number
  signal?: AbortSignal
  /** This pairing's logger (default: the process-wide one, off unless setDebug(true)). */
  logger?: Logger
}

/** A pairing in progress: the TV is showing its code. */
interface PairingSession {
  /** The certificate the TV pairs with; keep it, and reuse it for every remote connection. */
  readonly certificate: Certificate
  /** Sends the 6-character code. Rejects with PairingError (timeout, cancelled) when there is no answer. */
  finish(code: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<PairingResult>
  /** Abandons the pairing; the TV closes its code screen. */
  cancel(): void
}

const STATUS = messages.Status as Record<string, number>
const STATUS_OK = STATUS.STATUS_OK as number
const STATUS_BAD_SECRET = STATUS.STATUS_BAD_SECRET as number

// Transient connect-stage failures worth retrying: a dozing TV (Wi-Fi power-save) drops off the network and reports
// these until it wakes. Anything past a live TLS session is terminal.
const RETRYABLE_CONNECT_CODES = new Set(["EHOSTUNREACH", "EHOSTDOWN", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET"])
const MAX_CONNECT_ATTEMPTS = 5
const RETRY_DELAY_MS = 1000
const DEFAULT_START_TIMEOUT_MS = 10_000
const DEFAULT_FINISH_TIMEOUT_MS = 10_000

const wait = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(t)
      resolve()
    })
  })

interface Connected {
  socket: tls.TLSSocket
  /** Receives every message after the code is shown. */
  onMessage(fn: (m: PairingResponse) => void): void
}

/** One connection attempt, up to the code being shown. */
const connectForCode = (
  host: string,
  certificate: Certificate,
  o: { port: number; serviceName: string; clientName: string | undefined },
  onSocket: (s: tls.TLSSocket) => void,
  log: Logger,
) =>
  new Promise<Connected>((resolve, reject) => {
    let secure = false
    let shown = false
    let sockError: NodeJS.ErrnoException | undefined
    let handler: ((m: PairingResponse) => void) | undefined
    // `family` is a net-level lookup option that tls.connect forwards to the socket; pin IPv4 (see remote-manager).
    const options: tls.ConnectionOptions & { family?: number } = {
      key: certificate.key,
      cert: certificate.cert,
      port: o.port,
      host,
      family: 4,
      rejectUnauthorized: false,
    }
    const socket = tls.connect(options)
    onSocket(socket)
    const frames = createFrameReader((payload) => {
      const message = messages.parse(payload) as unknown as PairingResponse
      log.debug("Pairing receive: " + JSON.stringify(message.toJSON()))
      if (shown) {
        handler?.(message)
        return
      }
      if (message.status !== STATUS_OK) {
        socket.destroy()
        reject(new PairingError("refused", `The TV refused the pairing (status ${message.status})`))
      } else if (message.pairingRequestAck) socket.write(messages.createPairingOption())
      else if (message.pairingOption) socket.write(messages.createPairingConfiguration())
      else if (message.pairingConfigurationAck) {
        shown = true
        resolve({ socket, onMessage: (fn) => (handler = fn) })
      }
    })
    socket.on("secureConnect", () => {
      secure = true
      socket.write(messages.createPairingRequest(o.serviceName, o.clientName))
    })
    socket.on("data", (data) => {
      try {
        frames.push(data)
      } catch (error) {
        socket.destroy(error as Error)
      }
    })
    socket.on("error", (error: NodeJS.ErrnoException) => {
      sockError = error
      log.error(error)
    })
    socket.on("close", () => {
      if (shown) return
      const code = sockError?.code
      const error = new PairingError(
        secure ? "refused" : "unreachable",
        secure ? "The TV closed the pairing connection" : `Cannot reach the TV (${code ?? "closed"})`,
        code,
      )
      const retryable = !secure && code !== undefined && RETRYABLE_CONNECT_CODES.has(code)
      reject(Object.assign(error, { retryable }))
    })
  })

/** Races `p` against a timeout and an abort signal; `onGiveUp` runs when either wins. */
const bounded = <T>(p: Promise<T>, ms: number, signal: AbortSignal | undefined, onGiveUp: () => void): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    // `p` may still reject after we gave up on it (its socket is destroyed then): that is expected, not unhandled.
    p.catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    }
    const give = (error: PairingError) => {
      settle()
      onGiveUp()
      reject(error)
    }
    const onAbort = () => give(new PairingError("cancelled", "Pairing was cancelled"))
    if (signal?.aborted) {
      onAbort()
      return
    }
    timer = setTimeout(() => give(new PairingError("timeout", "The TV did not answer in time")), ms)
    signal?.addEventListener("abort", onAbort, { once: true })
    p.then(
      (v) => {
        settle()
        resolve(v)
      },
      (e: unknown) => {
        settle()
        reject(e)
      },
    )
  })

/**
 * Starts pairing with the TV at `host`: resolves once the TV shows its 6-character code. Rejects with PairingError:
 * `unreachable` (no connection, after riding out a dozing TV's transient errors), `refused`, `timeout` or `cancelled`.
 */
const startPairing = async (host: string, options: PairingOptions = {}): Promise<PairingSession> => {
  const log = options.logger ?? defaultLog
  const certificate =
    options.cert?.cert && options.cert.key
      ? { cert: options.cert.cert, key: options.cert.key }
      : generateCertificate(options.serviceName ?? "androidtv-remote", "CNT", "ST", "LOC", "O", "OU")
  const o = {
    port: options.port ?? 6467,
    serviceName: options.serviceName ?? "androidtv-remote",
    clientName: options.clientName,
  }
  let current: tls.TLSSocket | undefined
  let givenUp = false
  const attempt = async (): Promise<Connected> => {
    for (let n = 1; ; n++) {
      try {
        return await connectForCode(host, certificate, o, (s) => (current = s), log)
      } catch (error) {
        const { retryable } = error as { retryable?: boolean }
        if (!retryable || n >= MAX_CONNECT_ATTEMPTS || givenUp) throw error
        log.debug(`${host} pairing connect failed; retry ${n}/${MAX_CONNECT_ATTEMPTS - 1}`)
        await wait(RETRY_DELAY_MS, options.signal)
      }
    }
  }
  const connected = await bounded(attempt(), options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS, options.signal, () => {
    givenUp = true
    current?.destroy()
  })
  const { socket } = connected
  let finished = false

  const finish = async (code: string, f: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<PairingResult> => {
    if (finished || socket.destroyed) return "tv_refused"
    finished = true
    // Node types modulus/exponent as optional; both are present for the RSA certificates used in pairing.
    const secret = pairingSecret(
      socket.getCertificate() as unknown as RsaKey,
      socket.getPeerCertificate() as unknown as RsaKey,
      code.trim(),
    )
    if (!secret) {
      socket.destroy()
      return "wrong_code"
    }
    const answer = new Promise<PairingResult>((resolve) => {
      connected.onMessage((message) => {
        if (message.pairingSecretAck) resolve("paired")
        else if (message.status === STATUS_BAD_SECRET) resolve("wrong_code")
        else if (message.status !== STATUS_OK) resolve("tv_refused")
        else return
        socket.end()
      })
      socket.once("close", () => resolve("tv_refused"))
    })
    socket.write(messages.createPairingSecret(secret))
    return bounded(answer, f.timeoutMs ?? DEFAULT_FINISH_TIMEOUT_MS, f.signal, () => socket.destroy())
  }

  return {
    certificate,
    finish,
    cancel: () => {
      finished = true
      socket.destroy()
    },
  }
}

export { startPairing, PairingError }
export type { PairingSession, PairingOptions, PairingResult, PairingErrorReason }
