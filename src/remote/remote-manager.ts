import tls from "node:tls"
import EventEmitter from "node:events"
import * as messages from "./remote-message-manager.js"
import { createFrameReader } from "../framing.js"
import { log as defaultLog, type Logger } from "../logger.js"
import { defaultDeviceInfo, type DeviceInfo } from "../device-info.js"
import type { Certificate } from "../types.js"

interface RemoteResponse {
  remotePingRequest?: { val1: number }
  remoteConfigure?: { code1?: number }
  remoteSetActive?: unknown
  remoteImeKeyInject?: { appInfo: { appPackage: string } }
  remoteImeBatchEdit?: { imeCounter: number; fieldCounter: number }
  remoteImeShowRequest?: unknown
  remoteVoiceBegin?: unknown
  remoteVoicePayload?: unknown
  remoteVoiceEnd?: unknown
  remoteStart?: { started: boolean }
  remoteSetVolumeLevel?: {
    volumeLevel: number
    volumeMax: number
    volumeMuted: boolean
  }
  remoteSetPreferredAudioDevice?: unknown
  remoteError?: unknown
  toJSON(): unknown
}

/**
 * - `connecting`: a connection is being opened.
 * - `ready`: the TV configured the session; keys can be sent.
 * - `backoff`: the connection dropped; the next attempt waits (1 s, 2 s, 4 s … up to 60 s).
 * - `unpaired`: the TV refused our certificate before configuring a session; it no longer reconnects (pair again).
 * - `stopped`: stop() was called.
 */
type RemoteState = "connecting" | "ready" | "backoff" | "unpaired" | "stopped"

interface RemoteManager extends EventEmitter {
  /** Connects, and keeps reconnecting until stop(). Resolves on the first TLS connection, rejects if it fails. */
  start(): Promise<boolean>
  readonly state: RemoteState
  /** The TV's last reported power state on this session; undefined until it reports one. */
  readonly isOn: boolean | undefined
  sendPower(): boolean
  /** Sends a key; false when the session is not ready (nothing is sent). */
  sendKey(keyCode: number, direction?: number): boolean
  sendAppLink(link: string): boolean
  sendText(text: string): boolean
  stop(): void
}

interface RemoteManagerOptions {
  /** The features to ask for; the TV's offer narrows them. Default 622 (messages.DEFAULT_FEATURES). */
  features?: number
  deviceInfo?: DeviceInfo
  log?: Logger
  /** Reconnect delays, in ms, by consecutive failure; the last repeats. Default 1 s doubling to 60 s. */
  backoffMs?: readonly number[]
}

const DEFAULT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000] as const

/**
 * How a TV turns away a certificate it doesn't know: it resets the connection right after the handshake, or fails the
 * handshake with a TLS alert. Only meaningful before the TV configured the session; a reset later (a TV rebooting) is
 * an ordinary drop.
 */
const refusesCertificate = (error: NodeJS.ErrnoException | undefined): boolean =>
  error?.code === "ECONNRESET" || /^ERR_SSL_|ALERT|CERT/.test(error?.code ?? "")

const createRemoteManager = (
  host: string,
  port: number,
  certs: Certificate,
  options: RemoteManagerOptions = {},
): RemoteManager => {
  const wantedFeatures = options.features ?? messages.DEFAULT_FEATURES
  const deviceInfo = options.deviceInfo ?? defaultDeviceInfo()
  const log = options.log ?? defaultLog
  const backoff = options.backoffMs?.length ? options.backoffMs : DEFAULT_BACKOFF_MS
  const emitter = new EventEmitter()
  let client: tls.TLSSocket | undefined
  let imeCounter = 0
  let fieldCounter = 0
  let state: RemoteState = "connecting"
  let isOn: boolean | undefined
  let failures = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  // What both sides support: the TV says what it offers in RemoteConfigure.code1 (androidtvremote2 does the same).
  let activeFeatures = wantedFeatures

  const setState = (next: RemoteState) => {
    if (state === next) return
    state = next
    emitter.emit("state", next)
  }

  const write = (bytes: Uint8Array): boolean => {
    if (state !== "ready" || !client || client.destroyed) return false
    client.write(bytes)
    return true
  }

  const handle = (message: RemoteResponse) => {
    if (!message.remotePingRequest) log.debug(host + " Receive : " + JSON.stringify(message.toJSON()))
    if (message.remoteConfigure) {
      activeFeatures = wantedFeatures & (message.remoteConfigure.code1 ?? 0)
      client?.write(messages.createRemoteConfigure(activeFeatures, deviceInfo))
      failures = 0
      setState("ready")
      emitter.emit("ready")
    } else if (message.remoteSetActive) {
      client?.write(messages.createRemoteSetActive(activeFeatures))
    } else if (message.remotePingRequest) {
      client?.write(messages.createRemotePingResponse(message.remotePingRequest.val1))
    } else if (message.remoteImeKeyInject) {
      emitter.emit("current_app", message.remoteImeKeyInject.appInfo.appPackage)
    } else if (message.remoteImeBatchEdit) {
      imeCounter = message.remoteImeBatchEdit.imeCounter
      fieldCounter = message.remoteImeBatchEdit.fieldCounter
    } else if (message.remoteStart) {
      isOn = message.remoteStart.started
      emitter.emit("powered", message.remoteStart.started)
    } else if (message.remoteSetVolumeLevel) {
      emitter.emit("volume", {
        level: message.remoteSetVolumeLevel.volumeLevel,
        maximum: message.remoteSetVolumeLevel.volumeMax,
        muted: message.remoteSetVolumeLevel.volumeMuted,
      })
    } else if (message.remoteError) {
      emitter.emit("error", new Error("Remote error: " + JSON.stringify(message.remoteError)))
    }
    // IME show requests, voice and preferred-audio-device messages are not used.
  }

  const scheduleReconnect = () => {
    if (state === "stopped" || state === "unpaired") return
    const delay = backoff[Math.min(failures, backoff.length - 1)] as number
    failures++
    setState("backoff")
    log.debug(`${host} reconnecting in ${delay} ms`)
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      connect().catch((e) => log.error(e))
    }, delay)
    retryTimer.unref?.()
  }

  const connect = (): Promise<boolean> =>
    new Promise((resolve, reject) => {
      if (state === "stopped") return resolve(false)
      setState("connecting")
      let error: NodeJS.ErrnoException | undefined
      let configured = false
      // See pairing-manager: `family` is forwarded to the socket but absent from tls.ConnectionOptions. Pin IPv4 so a
      // resolved hostname can't yield a scopeless IPv6 link-local address that never routes on the LAN.
      const tlsOptions: tls.ConnectionOptions & { family?: number } = {
        key: certs.key,
        cert: certs.cert,
        port,
        host,
        family: 4,
        rejectUnauthorized: false,
      }
      log.debug("Start Remote Connect")
      const socket = tls.connect(tlsOptions)
      client = socket
      // The TV pings every ~5 s; 10 s without data means the link is dead.
      socket.setTimeout(10_000)
      socket.on("timeout", () => {
        log.debug(host + " timeout")
        socket.destroy()
      })
      socket.on("secureConnect", () => {
        log.debug(host + " Remote secureConnect")
        resolve(true)
      })
      const frames = createFrameReader((payload) => {
        const message = messages.parse(payload) as unknown as RemoteResponse
        if (message.remoteConfigure) configured = true
        handle(message)
      })
      socket.on("data", (data) => {
        try {
          frames.push(data)
        } catch (err) {
          socket.destroy(err as Error)
        }
      })
      socket.on("error", (err: NodeJS.ErrnoException) => {
        log.error(host, err)
        error = err
      })
      socket.on("close", (hasError) => {
        log.info(host + " Remote Connection closed ", hasError)
        if (client === socket) client = undefined
        reject(new Error(error?.code ?? "Remote connection closed"))
        if (state === "stopped") return
        if (!configured && refusesCertificate(error)) {
          // The TV no longer knows our certificate (reset, or the pairing removed there): retrying cannot help.
          log.info(host + " The TV refused our certificate: pair again")
          setState("unpaired")
          emitter.emit("unpaired")
          return
        }
        scheduleReconnect()
      })
    })

  const stop = (): void => {
    setState("stopped")
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = undefined
    client?.destroy()
  }

  // Getters must be defined, not assigned: Object.assign would copy their value once.
  Object.defineProperties(emitter, {
    state: { get: () => state, enumerable: true },
    isOn: { get: () => isOn, enumerable: true },
  })
  return Object.assign(emitter, {
    start: connect,
    sendPower: () =>
      write(messages.createRemoteKeyInject(messages.RemoteDirection.SHORT, messages.RemoteKeyCode.KEYCODE_POWER)),
    sendKey: (keyCode: number, direction: number = messages.RemoteDirection.SHORT) =>
      write(messages.createRemoteKeyInject(direction, keyCode)),
    sendAppLink: (link: string) => write(messages.createRemoteAppLinkLaunchRequest(link)),
    sendText: (text: string) => write(messages.createRemoteImeBatchEdit(imeCounter, fieldCounter, text)),
    stop,
  }) as RemoteManager
}

export { createRemoteManager, DEFAULT_BACKOFF_MS, refusesCertificate }
export type { RemoteManager, RemoteManagerOptions, RemoteState }
