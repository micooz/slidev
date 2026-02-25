export interface SlidevExportStepInfo {
  no: number
  clicks: number
  clicksTotal: number
  hasNext: boolean
}

export interface SlidevExportBridge {
  hasNextStep?: () => boolean
  nextStep?: () => Promise<void> | void
  goStep?: (no: number, clicks: number) => Promise<void> | void
  getStepStamp?: () => string
  getStepInfo?: () => SlidevExportStepInfo
}

declare global {
  interface Window {
    __slidev_export__?: SlidevExportBridge
  }
}
