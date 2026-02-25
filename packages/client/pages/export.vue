<script setup lang="ts">
import type { ScreenshotSession } from '../logic/screenshot'
import { sleep } from '@antfu/utils'
import { parseRangeString } from '@slidev/parser/utils'
import { useHead } from '@unhead/vue'
import { provideLocal, useElementSize, useStyleTag, watchDebounced } from '@vueuse/core'
import { computed, onMounted, ref, useTemplateRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useDarkMode } from '../composables/useDarkMode'
import { useNav } from '../composables/useNav'
import { patchMonacoColors } from '../composables/usePrintStyles'
import { injectionSlideScale } from '../constants'
import { configs, slideHeight, slidesTitle, slideWidth } from '../env'
import ExportPdfTip from '../internals/ExportPdfTip.vue'
import FormCheckbox from '../internals/FormCheckbox.vue'
import FormItem from '../internals/FormItem.vue'
import PrintSlide from '../internals/PrintSlide.vue'
import SegmentControl from '../internals/SegmentControl.vue'
import { isScreenshotSupported, startScreenshotSession } from '../logic/screenshot'
import { captureDelay, skipExportPdfTip } from '../state'
import Play from './play.vue'

const { slides, isPrintWithClicks, hasNext, go, next, currentSlideNo, clicks, printRange } = useNav()
const router = useRouter()
const { isColorSchemaConfigured, isDark } = useDarkMode()
const { width: containerWidth } = useElementSize(useTemplateRef('export-container'))
const { height: contentHeight } = useElementSize(useTemplateRef('export-content'))
const scale = computed(() => containerWidth.value / slideWidth.value)
const contentMarginBottom = computed(() => `${contentHeight.value * (scale.value - 1)}px`)
const rangesRaw = ref('')
const initialWait = ref(1000)
type ScreenshotResult = { slideIndex: number, clickIndex: number, dataUrl: string }[]
const screenshotSession = ref<ScreenshotSession | null>(null)
const capturedImages = ref<ScreenshotResult | null>(null)
const title = ref(configs.exportFilename || slidesTitle)
const videoInterval = ref(2000)
const videoFps = ref(30)
const videoSize = ref('1920x1080')
const videoFpsOptions = [24, 30, 60]
const videoSizeOptions = [
  '1280x720',
  '1920x1080',
  '2560x1440',
  '3840x2160',
]
const videoSizeSelection = ref(videoSize.value)
const videoSizeCustom = ref('')
const videoExporting = ref(false)
const videoExportError = ref('')
const videoExportStatus = ref('')
const videoExportElapsedMs = ref(0)
const videoExportJobId = ref('')
const videoDownloadReady = ref(false)
const videoDownloadFilename = ref('')
const videoDownloadUrl = computed(() => videoExportJobId.value
  ? `/__slidev/export/video/${videoExportJobId.value}/download`
  : '')
const VIDEO_EXPORT_JOB_STORAGE_KEY = 'slidev.export.video.jobId'

function formatDuration(ms: number) {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`
}

function updateStoredVideoJobId(jobId?: string) {
  videoExportJobId.value = jobId || ''
  if (videoExportJobId.value)
    localStorage.setItem(VIDEO_EXPORT_JOB_STORAGE_KEY, videoExportJobId.value)
  else
    localStorage.removeItem(VIDEO_EXPORT_JOB_STORAGE_KEY)
}

function triggerDownload(url: string) {
  const a = document.createElement('a')
  a.href = url
  a.click()
}

interface VideoExportStatusResponse {
  status?: 'running' | 'done' | 'error'
  error?: string
  durationMs?: number
  filename?: string
  downloadUrl?: string
}

async function queryVideoJobStatus(jobId: string) {
  const statusResponse = await fetch(`/__slidev/export/video/${jobId}`)
  if (statusResponse.status === 404) {
    updateStoredVideoJobId()
    videoDownloadReady.value = false
    throw new Error('Export job not found or expired. Please export again.')
  }
  if (!statusResponse.ok)
    throw new Error(`Failed to query mp4 export status (${statusResponse.status})`)

  const statusData = await statusResponse.json() as VideoExportStatusResponse
  if (Number.isFinite(statusData.durationMs))
    videoExportElapsedMs.value = Number(statusData.durationMs)

  if (statusData.status === 'running')
    videoExportStatus.value = 'exporting'
  else if (statusData.status === 'done')
    videoExportStatus.value = 'done'
  else if (statusData.status === 'error')
    videoExportStatus.value = 'error'
  else
    videoExportStatus.value = statusData.status || ''

  if (statusData.filename)
    videoDownloadFilename.value = statusData.filename

  return statusData
}

async function pollVideoJob(jobId: string, autoDownload = false) {
  while (true) {
    const statusData = await queryVideoJobStatus(jobId)
    if (statusData.status === 'done') {
      videoDownloadReady.value = true
      videoExporting.value = false
      if (autoDownload)
        triggerDownload(statusData.downloadUrl || `/__slidev/export/video/${jobId}/download`)
      break
    }
    if (statusData.status === 'error') {
      videoExporting.value = false
      throw new Error(statusData.error || 'MP4 export failed')
    }
    await sleep(1000)
  }
}

watch(videoSizeSelection, (value) => {
  if (value === 'custom') {
    if (!videoSizeCustom.value)
      videoSizeCustom.value = videoSize.value
    return
  }
  videoSize.value = value
})

watch(videoSizeCustom, (value) => {
  if (videoSizeSelection.value === 'custom')
    videoSize.value = value.trim()
})

if (!videoSizeOptions.includes(videoSize.value)) {
  videoSizeSelection.value = 'custom'
  videoSizeCustom.value = videoSize.value
}

useHead({
  title,
})

provideLocal(injectionSlideScale, scale)

const showExportPdfTip = ref(false)
function pdf() {
  if (skipExportPdfTip.value) {
    doPrint()
  }
  else {
    showExportPdfTip.value = true
  }
}

function doPrint() {
  patchMonacoColors()
  setTimeout(window.print, 100)
}

async function capturePngs() {
  if (screenshotSession.value) {
    screenshotSession.value.dispose()
    screenshotSession.value = null
  }
  if (capturedImages.value)
    return capturedImages.value
  try {
    const scale = 2
    screenshotSession.value = await startScreenshotSession(slideWidth.value * scale, slideHeight.value * scale)
    const result: ScreenshotResult = []

    go(1, 0, true)

    await sleep(initialWait.value + captureDelay.value)
    while (true) {
      if (!screenshotSession.value) {
        break
      }
      result.push({
        slideIndex: currentSlideNo.value - 1,
        clickIndex: clicks.value,
        dataUrl: screenshotSession.value.screenshot(document.getElementById('slide-content')!),
      })
      if (hasNext.value) {
        await sleep(captureDelay.value)
        next()
        await sleep(captureDelay.value)
      }
      else {
        break
      }
    }

    if (screenshotSession.value) {
      screenshotSession.value.dispose()
      capturedImages.value = result
      screenshotSession.value = null
    }
  }
  catch (e) {
    console.error(e)
    capturedImages.value = null
  }
  finally {
    router.push('/export')
  }
  return capturedImages.value
}

async function pptx() {
  const pngs = await capturePngs()
  if (!pngs)
    return
  const pptx = await import('pptxgenjs')
    .then(r => r.default)
    .then(PptxGen => new PptxGen())

  const layoutName = `${slideWidth.value}x${slideHeight.value}`
  pptx.defineLayout({
    name: layoutName,
    width: slideWidth.value / 96,
    height: slideHeight.value / 96,
  })
  pptx.layout = layoutName
  if (configs.author)
    pptx.author = configs.author
  pptx.company = 'Created using Slidev'
  pptx.title = title.value
  if (typeof configs.info === 'string')
    pptx.subject = configs.info

  pngs.forEach(({ slideIndex, dataUrl }) => {
    const slide = pptx.addSlide()
    slide.background = {
      data: dataUrl,
    }

    const note = slides.value[slideIndex].meta.slide.note
    if (note)
      slide.addNotes(note)
  })

  const blob = await pptx.write({
    outputType: 'blob',
    compression: true,
  }) as Blob
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${title.value}.pptx`
  a.click()
}

async function pngsGz() {
  const pngs = await capturePngs()
  if (!pngs)
    return
  const { createTarGzip } = await import('nanotar')
  const data = await createTarGzip(
    pngs.map(({ slideIndex, dataUrl }) => ({
      name: `${slideIndex}.png`,
      data: new Uint8Array(atob(dataUrl.split(',')[1]).split('').map(char => char.charCodeAt(0))),
    })),
  )
  const a = document.createElement('a')
  const blob = new Blob([data], { type: 'application/gzip' })
  a.href = URL.createObjectURL(blob)
  a.download = `${title.value}.tar.gz`
  a.click()
}

async function mp4() {
  if (videoExporting.value)
    return

  videoExporting.value = true
  videoExportError.value = ''
  videoExportStatus.value = 'starting'
  videoExportElapsedMs.value = 0
  videoDownloadReady.value = false
  videoDownloadFilename.value = ''
  updateStoredVideoJobId()

  try {
    const response = await fetch('/__slidev/export/video', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        videoInterval: videoInterval.value,
        videoFps: videoFps.value,
        videoSize: videoSize.value,
        range: rangesRaw.value.trim() || undefined,
        dark: isDark.value,
      }),
    })

    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      throw new Error(data.error || `Failed to start mp4 export (${response.status})`)
    }

    const { jobId } = await response.json() as { jobId: string }
    updateStoredVideoJobId(jobId)
    await pollVideoJob(jobId, true)
  }
  catch (error) {
    console.error(error)
    videoExportError.value = error instanceof Error ? error.message : String(error)
    videoExporting.value = false
  }
}

onMounted(async () => {
  const savedJobId = localStorage.getItem(VIDEO_EXPORT_JOB_STORAGE_KEY)
  if (!savedJobId)
    return

  updateStoredVideoJobId(savedJobId)
  videoExportError.value = ''
  try {
    const statusData = await queryVideoJobStatus(savedJobId)
    if (statusData.status === 'running') {
      videoExporting.value = true
      await pollVideoJob(savedJobId, false)
    }
    else if (statusData.status === 'done') {
      videoDownloadReady.value = true
      videoExporting.value = false
    }
    else if (statusData.status === 'error') {
      videoExporting.value = false
      videoExportError.value = statusData.error || 'MP4 export failed'
    }
  }
  catch (error) {
    videoExportError.value = error instanceof Error ? error.message : String(error)
  }
})

useStyleTag(computed(() => screenshotSession.value?.isActive
  ? `
html {
  cursor: none;
  margin-bottom: 20px;
}
body {
  pointer-events: none;
}`
  : `
:root {
  --slidev-slide-scale: ${scale.value};
}
`))

// clear captured images when settings changed
watch(
  [
    isDark,
    printRange,
    isPrintWithClicks,
  ],
  () => capturedImages.value = null,
)

watchDebounced(
  [slides, rangesRaw],
  () => printRange.value = parseRangeString(slides.value.length, rangesRaw.value),
  { debounce: 300 },
)

// clear captured images when HMR
if (import.meta.hot) {
  import.meta.hot.on('vite:beforeUpdate', () => {
    capturedImages.value = null
  })
}
</script>

<template>
  <Play v-if="screenshotSession?.isActive" />
  <div
    v-else
    class="fixed inset-0 flex flex-col md:flex-row md:gap-8 print:position-unset print:inset-0 print:block print:min-h-max justify-center of-hidden bg-main"
  >
    <div class="print:hidden min-w-fit flex flex-wrap md:flex-nowrap md:of-y-auto md:flex-col gap-2 p-6 max-w-100">
      <h1 class="text-3xl md:my-4 flex items-center gap-2 w-full">
        <RouterLink to="/" class="i-carbon:previous-outline op-70 hover:op-100" />
        Browser Exporter
        <sup op50 italic text-sm>Experimental</sup>
      </h1>
      <div flex="~ col gap-2">
        <h2>Options</h2>
        <FormItem title="Title">
          <input v-model="title" type="text">
        </FormItem>
        <FormItem title="Range">
          <input v-model="rangesRaw" type="text" :placeholder="`1-${slides.length}`">
        </FormItem>
        <FormItem title="Color Mode">
          <SegmentControl
            v-model="isDark"
            :options="[
              { value: false, label: 'Light' },
              { value: true, label: 'Dark' },
            ]"
            :disabled="isColorSchemaConfigured"
          />
        </FormItem>
        <FormItem title="With clicks">
          <FormCheckbox v-model="isPrintWithClicks" />
        </FormItem>
      </div>
      <div class="flex-grow" />
      <div class="min-w-fit" flex="~ col gap-3">
        <div border="~ main rounded-lg" p3 flex="~ col gap-2">
          <h2>Export as Vector File</h2>
          <div class="flex flex-col gap-2 min-w-max">
            <button class="slidev-form-button" @click="pdf">
              PDF
            </button>
          </div>
        </div>

        <div border="~ main rounded-lg" p3 flex="~ col gap-2">
          <h2>Export as Video</h2>
          <div class="flex flex-col gap-2 min-w-max">
            <FormItem title="Interval" class="w-full" help="Wait time (ms) after each click/slide transition animation has finished.">
              <input v-model.number="videoInterval" type="number" step="100" min="0">
            </FormItem>
            <FormItem title="FPS" class="w-full">
              <select v-model.number="videoFps">
                <option v-for="fps in videoFpsOptions" :key="fps" :value="fps">
                  {{ fps }}
                </option>
              </select>
            </FormItem>
            <FormItem title="Resolution" class="w-full !items-start">
              <div class="flex flex-col gap-2 w-full">
                <select v-model="videoSizeSelection">
                  <option v-for="size in videoSizeOptions" :key="size" :value="size">
                    {{ size }}
                  </option>
                  <option value="custom">
                    Custom
                  </option>
                </select>
                <input
                  v-if="videoSizeSelection === 'custom'"
                  v-model="videoSizeCustom"
                  type="text"
                  placeholder="e.g. 3440x1440"
                >
              </div>
            </FormItem>
            <button class="slidev-form-button" :disabled="videoExporting" @click="mp4">
              {{ videoExporting ? 'Exporting MP4...' : 'MP4' }}
            </button>
            <div v-if="videoExportStatus" class="text-sm op70">
              Status: {{ videoExportStatus }}
            </div>
            <div v-if="videoExportStatus" class="text-xs op60">
              Elapsed: {{ formatDuration(videoExportElapsedMs) }}
            </div>
            <div v-if="videoExportError" class="text-sm text-red-500">
              {{ videoExportError }}
            </div>
            <button
              v-if="videoDownloadReady && videoDownloadUrl"
              class="slidev-form-button flex items-center justify-center gap-2"
              @click="triggerDownload(videoDownloadUrl)"
            >
              <span class="i-carbon:download inline-block text-lg" />
              Download MP4
            </button>
            <div v-if="videoDownloadReady && videoDownloadFilename" class="text-xs op60 break-all">
              File: {{ videoDownloadFilename }}
            </div>
          </div>
        </div>

        <div border="~ main rounded-lg" p3 flex="~ col gap-2" :class="isScreenshotSupported ? '' : 'border-orange'">
          <h2>Export as Images</h2>
          <div v-if="!isScreenshotSupported" class="min-w-full w-0 text-orange/100 p-1 mb-2 bg-orange/10 rounded">
            <span class="i-carbon:warning-alt inline-block mb--.5" />
            Your browser may not support image capturing.
            If you encounter issues, please use a modern Chromium-based browser,
            or export via the CLI.
          </div>
          <div class="flex flex-col gap-2 min-w-max">
            <button class="slidev-form-button" @click="pptx">
              PPTX
            </button>
            <button class="slidev-form-button" @click="pngsGz">
              PNGs.gz
            </button>
          </div>
          <div w-full h-1px border="t main" my2 />
          <div class="relative flex flex-col gap-2 flex-nowrap">
            <div class="flex flex-col gap-2 min-w-max">
              <button v-if="capturedImages" class="slidev-form-button flex justify-center items-center gap-2" @click="capturedImages = null">
                <span class="i-carbon:trash-can inline-block text-xl" />
                Clear Captured Images
              </button>
              <button v-else class="slidev-form-button flex justify-center items-center gap-2" @click="capturePngs">
                <div class="i-carbon:drop-photo inline-block text-xl" />
                Pre-capture slides as Images
              </button>
              <FormItem title="Delay" description="Delay between capturing each slide in milliseconds.<br>Increase this value if slides are captured incompletely. <br>(Not related to PDF export)">
                <input v-model="captureDelay" type="number" step="50" min="50">
              </FormItem>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div id="export-container" ref="export-container" relative>
      <div print:hidden fixed right-5 bottom-5 px2 py0 z-label slidev-glass-effect>
        <span op75>Rendering as {{ capturedImages ? 'Captured Images' : 'DOM' }} </span>
      </div>
      <div v-show="!capturedImages" id="export-content" ref="export-content">
        <PrintSlide v-for="route, index in slides" :key="index" :hidden="!printRange.includes(index + 1)" :route />
      </div>
      <div v-if="capturedImages" id="export-content-images" class="print:hidden grid">
        <div v-for="png, i of capturedImages" :key="i" class="print-slide-container">
          <img :src="png.dataUrl">
        </div>
      </div>
    </div>
    <div id="twoslash-container" />
    <ExportPdfTip v-model="showExportPdfTip" @print="doPrint" />
  </div>
</template>

<style scoped>
@media not print {
  #export-container {
    scrollbar-width: thin;
    scroll-behavior: smooth;
    --uno: w-full overflow-x-hidden overflow-y-auto max-h-full max-w-300 p-6;
  }

  #export-content {
    transform: v-bind('`scale(${scale})`');
    margin-bottom: v-bind('contentMarginBottom');
    --uno: origin-tl;
  }

  #export-content,
  #export-content-images {
    --uno: flex flex-col gap-2;
  }
}

@media print {
  #export-content {
    transform: scale(1);
    display: block !important;
  }
}

label {
  --uno: text-xl flex gap-2 items-center select-none;

  span {
    --uno: flex-grow;
  }

  input[type='text'],
  input[type='number'],
  select {
    --uno: border border-main rounded px-2 py-1 w-full;
  }
}

h2 {
  --uno: font-500 op-70;
}

#export-content {
  --uno: pointer-events-none;
}
</style>

<style>
@media print {
  html,
  body,
  #app {
    overflow: unset !important;
  }
}

@media not print {
  #export-content-images .print-slide-container,
  #export-content .print-slide-container {
    --uno: border border-main rounded-md shadow of-hidden;
  }
}
</style>
