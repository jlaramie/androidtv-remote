import EventEmitter from "node:events"
import { generateCertificate } from "./certificate/certificate-generator.js"
import {
  startPairing,
  PairingError,
  type PairingSession,
  type PairingOptions,
  type PairingResult,
  type PairingErrorReason,
} from "./pairing/pairing-manager.js"
import { createRemoteManager } from "./remote/remote-manager.js"
import {
  RemoteKeyCode,
  RemoteDirection,
} from "./remote/remote-message-manager.js"
import { deviceInfoFrom } from "./device-info.js"
import { setDebug, createLogger } from "./logger.js"
import type {
  AndroidRemoteOptions,
  AndroidRemoteEvents,
  Certificate,
  VolumeState,
} from "./types.js"

interface AndroidRemote extends EventEmitter {
  start(): Promise<boolean>
  sendCode(code: string): boolean
  sendPower(): void
  sendKey(keyCode: number, direction?: number): void
  sendAppLink(link: string): void
  sendText(text: string): void
  getCertificate(): Certificate
  stop(): void
  on<K extends keyof AndroidRemoteEvents>(
    event: K,
    listener: (...args: AndroidRemoteEvents[K]) => void,
  ): this
  once<K extends keyof AndroidRemoteEvents>(
    event: K,
    listener: (...args: AndroidRemoteEvents[K]) => void,
  ): this
  off<K extends keyof AndroidRemoteEvents>(
    event: K,
    listener: (...args: AndroidRemoteEvents[K]) => void,
  ): this
  emit<K extends keyof AndroidRemoteEvents>(
    event: K,
    ...args: AndroidRemoteEvents[K]
  ): boolean
}

const createAndroidRemote = (
  host: string,
  options: AndroidRemoteOptions = {},
): AndroidRemote => {
  // Per instance: one remote's debug option or identity never changes another's. Without `debug`, the process-wide
  // setDebug() applies.
  const log = createLogger(options.debug)
  const deviceInfo = deviceInfoFrom({ manufacturer: options.manufacturer, model: options.model })

  const emitter = new EventEmitter()
  const pairingPort = options.pairing_port ?? 6467
  const remotePort = options.remote_port ?? 6466
  const serviceName = options.service_name ?? "androidtv-remote"
  let cert: Certificate = {
    key: options.cert?.key ?? "",
    cert: options.cert?.cert ?? "",
  }

  let pairing: PairingSession | undefined
  let codeResult: ((r: PairingResult) => void) | undefined
  let remoteManager: ReturnType<typeof createRemoteManager> | undefined

  const start = async (): Promise<boolean> => {
    if (!cert.key || !cert.cert) {
      cert = generateCertificate(serviceName, "CNT", "ST", "LOC", "O", "OU")
      try {
        pairing = await startPairing(host, {
          cert,
          port: pairingPort,
          serviceName,
          clientName: deviceInfo.model,
          timeoutMs: 30_000,
          logger: log,
        })
      } catch (error) {
        log.error(error)
        return false
      }
      const result = new Promise<PairingResult>((resolve) => (codeResult = resolve))
      emitter.emit("secret")
      if ((await result) !== "paired") return false
    }

    remoteManager = createRemoteManager(host, remotePort, cert, { deviceInfo, log })
    remoteManager.on("powered", (powered) => emitter.emit("powered", powered))
    remoteManager.on("volume", (volume) => emitter.emit("volume", volume))
    remoteManager.on("current_app", (app) => emitter.emit("current_app", app))
    remoteManager.on("ready", () => emitter.emit("ready"))
    remoteManager.on("unpaired", () => emitter.emit("unpaired"))
    // Forward protocol errors — upstream emitted these but never re-exposed them.
    remoteManager.on("error", (error) => emitter.emit("error", error))

    await new Promise((resolve) => setTimeout(resolve, 1000))
    return remoteManager.start().catch(() => false)
  }

  /** Sends the code the TV shows; `start()` then resolves with whether pairing (and the remote) succeeded. */
  const sendCode = (code: string): boolean => {
    if (!pairing || !codeResult) return false
    const done = codeResult
    pairing.finish(code).then(done, () => done("tv_refused"))
    return true
  }
  const sendPower = (): void => remoteManager?.sendPower()
  const sendKey = (keyCode: number, direction?: number): void =>
    remoteManager?.sendKey(keyCode, direction)
  const sendAppLink = (link: string): void => remoteManager?.sendAppLink(link)
  const sendText = (text: string): void => remoteManager?.sendText(text)
  const getCertificate = (): Certificate => ({ key: cert.key, cert: cert.cert })
  const stop = (): void => {
    pairing?.cancel()
    remoteManager?.stop()
  }

  return Object.assign(emitter, {
    start,
    sendCode,
    sendPower,
    sendKey,
    sendAppLink,
    sendText,
    getCertificate,
    stop,
  }) as AndroidRemote
}

export { createAndroidRemote, setDebug, RemoteKeyCode, RemoteDirection, startPairing, PairingError }
export type {
  PairingSession,
  PairingOptions,
  PairingResult,
  PairingErrorReason,
  AndroidRemote,
  AndroidRemoteOptions,
  AndroidRemoteEvents,
  Certificate,
  VolumeState,
}
