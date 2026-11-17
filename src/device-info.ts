import os from "node:os"

// Client identity sent to the TV in the pairing request and the remote configure handshake. Each AndroidRemote (and
// each pairing or remote session) carries its own: two remotes in one process no longer overwrite each other's.
interface DeviceInfo {
  manufacturer: string
  model: string
}

const defaultDeviceInfo = (): DeviceInfo => ({
  manufacturer: "unknown",
  model: os.hostname() || "androidtv-remote",
})

/** The defaults with whichever fields are given. */
const deviceInfoFrom = (info: { manufacturer?: string | undefined; model?: string | undefined } = {}): DeviceInfo => {
  const out = defaultDeviceInfo()
  if (info.manufacturer) out.manufacturer = info.manufacturer
  if (info.model) out.model = info.model
  return out
}

export { defaultDeviceInfo, deviceInfoFrom }
export type { DeviceInfo }
