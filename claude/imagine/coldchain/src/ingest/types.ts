import type { RawReading } from './clock'

export interface DeviceBatch {
  containerId: string
  fleet: string
  region: string
  firmware: string
  receivedAt: number
  readings: RawReading[]
}
