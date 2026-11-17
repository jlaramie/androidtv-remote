import tls from "node:tls"
import EventEmitter from "node:events"
import * as messages from "./remote-message-manager.js"
import { createFrameReader } from "../framing.js"
import { log } from "../logger.js"
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

interface RemoteManager extends EventEmitter {
  start(): Promise<boolean>
  sendPower(): void
  sendKey(keyCode: number, direction?: number): void
  sendAppLink(link: string): void
  sendText(text: string): void
  stop(): void
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const createRemoteManager = (
  host: string,
  port: number,
  certs: Certificate,
  wantedFeatures: number = messages.DEFAULT_FEATURES,
): RemoteManager => {
  const emitter = new EventEmitter()
  let client: tls.TLSSocket | undefined
  let error: NodeJS.ErrnoException | null = null
  let imeCounter = 0
  let fieldCounter = 0
  let stopped = false
  // What both sides support: the TV says what it offers in RemoteConfigure.code1 (androidtvremote2 does the same).
  let activeFeatures = wantedFeatures

  const start = (): Promise<boolean> =>
    new Promise((resolve, reject) => {
      // See pairing-manager: `family` is forwarded to the socket but absent from
      // tls.ConnectionOptions, so widen the type to accept it.
      const options: tls.ConnectionOptions & { family?: number } = {
        key: certs.key,
        cert: certs.cert,
        port,
        host,
        // Pin to IPv4 for the same reason as pairing: avoid a scopeless IPv6
        // link-local from a resolved hostname that can never route on the LAN.
        family: 4,
        rejectUnauthorized: false,
      }

      log.debug("Start Remote Connect")
      client = tls.connect(options, () => {})

      client.on("timeout", () => {
        log.debug("timeout")
        client?.destroy()
      })

      // The TV pings every ~5s; 10s without data means the link is dead.
      client.setTimeout(10000)

      client.on("secureConnect", () => {
        log.debug(host + " Remote secureConnect")
        resolve(true)
      })

      const frames = createFrameReader((payload) => {
        const message = messages.parse(payload) as unknown as RemoteResponse

        if (!message.remotePingRequest) {
          log.debug(host + " Receive : " + JSON.stringify(message.toJSON()))
        }

        if (message.remoteConfigure) {
          activeFeatures = wantedFeatures & (message.remoteConfigure.code1 ?? 0)
          client?.write(messages.createRemoteConfigure(activeFeatures))
          emitter.emit("ready")
        } else if (message.remoteSetActive) {
          client?.write(messages.createRemoteSetActive(activeFeatures))
        } else if (message.remotePingRequest) {
          client?.write(
            messages.createRemotePingResponse(message.remotePingRequest.val1),
          )
        } else if (message.remoteImeKeyInject) {
          emitter.emit(
            "current_app",
            message.remoteImeKeyInject.appInfo.appPackage,
          )
        } else if (message.remoteImeBatchEdit) {
          imeCounter = message.remoteImeBatchEdit.imeCounter
          fieldCounter = message.remoteImeBatchEdit.fieldCounter
        } else if (message.remoteImeShowRequest) {
          log.debug("Receive IME SHOW REQUEST")
        } else if (message.remoteVoiceBegin) {
          // voice input not implemented
        } else if (message.remoteVoicePayload) {
          // voice input not implemented
        } else if (message.remoteVoiceEnd) {
          // voice input not implemented
        } else if (message.remoteStart) {
          emitter.emit("powered", message.remoteStart.started)
        } else if (message.remoteSetVolumeLevel) {
          emitter.emit("volume", {
            level: message.remoteSetVolumeLevel.volumeLevel,
            maximum: message.remoteSetVolumeLevel.volumeMax,
            muted: message.remoteSetVolumeLevel.volumeMuted,
          })
        } else if (message.remoteSetPreferredAudioDevice) {
          // ignored
        } else if (message.remoteError) {
          emitter.emit(
            "error",
            new Error("Remote error: " + JSON.stringify(message.remoteError)),
          )
        } else {
          log.debug("What else ?")
        }
      })

      client.on("data", (data) => {
        try {
          frames.push(data)
        } catch (err) {
          client?.destroy(err as Error)
        }
      })

      client.on("close", async (hasError) => {
        log.info(host + " Remote Connection closed ", hasError)
        // An explicit stop() must not trigger the auto-reconnect ladder below.
        if (stopped) return
        if (hasError) {
          reject(
            new Error(error?.code ?? "Remote connection closed with error"),
          )
          if (error?.code === "ECONNRESET") {
            emitter.emit("unpaired")
          } else if (error?.code === "ECONNREFUSED") {
            await wait(1000)
            await start().catch((e) => log.error(e))
          } else if (error?.code === "EHOSTDOWN") {
            // device is off — do not reconnect
          } else {
            await wait(1000)
            await start().catch((e) => log.error(e))
          }
        } else {
          await wait(1000)
          await start().catch((e) => log.error(e))
        }
      })

      client.on("error", (err: NodeJS.ErrnoException) => {
        log.error(host, err)
        error = err
      })
    })

  const sendPower = (): void => {
    client?.write(
      messages.createRemoteKeyInject(
        messages.RemoteDirection.SHORT,
        messages.RemoteKeyCode.KEYCODE_POWER,
      ),
    )
  }

  const sendKey = (
    keyCode: number,
    direction: number = messages.RemoteDirection.SHORT,
  ): void => {
    client?.write(messages.createRemoteKeyInject(direction, keyCode))
  }

  const sendAppLink = (link: string): void => {
    client?.write(messages.createRemoteAppLinkLaunchRequest(link))
  }

  const sendText = (text: string): void => {
    client?.write(
      messages.createRemoteImeBatchEdit(imeCounter, fieldCounter, text),
    )
  }

  const stop = (): void => {
    stopped = true
    client?.destroy()
  }

  return Object.assign(emitter, {
    start,
    sendPower,
    sendKey,
    sendAppLink,
    sendText,
    stop,
  })
}

export { createRemoteManager }
export type { RemoteManager }
