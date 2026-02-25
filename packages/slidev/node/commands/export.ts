import type { ExportArgs, ResolvedSlidevOptions, SlideInfo, SlidevExportStepInfo, TocItem } from '@slidev/types'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import path, { dirname, relative } from 'node:path'
import process from 'node:process'
import { clearUndefined, ensureSuffix, slash } from '@antfu/utils'
import { outlinePdfFactory } from '@lillallol/outline-pdf'
import { parseRangeString } from '@slidev/parser/core'
import { blue, cyan, dim, green, yellow } from 'ansis'
import { Presets, SingleBar } from 'cli-progress'
import { resolve } from 'mlly'
import * as pdfLib from 'pdf-lib'
import { PDFDocument } from 'pdf-lib'
import { getRoots } from '../resolver'

export interface ExportOptions {
  total: number
  range?: string
  slides: SlideInfo[]
  port?: number
  base?: string
  format?: 'pdf' | 'png' | 'pptx' | 'md' | 'mp4'
  output?: string
  timeout?: number
  wait?: number
  waitUntil: 'networkidle' | 'load' | 'domcontentloaded' | undefined
  dark?: boolean
  routerMode?: 'hash' | 'history'
  width?: number
  height?: number
  withClicks?: boolean
  executablePath?: string
  withToc?: boolean
  /**
   * Render slides slide by slide. Works better with global components, but will break cross slide links and TOC in PDF.
   * @default false
   */
  perSlide?: boolean
  scale?: number
  omitBackground?: boolean
  videoInterval?: number
  videoFps?: number
  videoWidth?: number
  videoHeight?: number
  videoMotionScale?: number
}

interface ExportPngResult {
  slideIndex: number
  buffer: Buffer
  filename: string
}

interface Mp4StepInfo {
  no: number
  clicks: number
  clicksTotal: number
  hasNext: boolean
}

function parseVideoSize(value?: string) {
  if (!value)
    return undefined

  const matched = value.match(/^(\d+)x(\d+)$/i)
  if (!matched)
    throw new Error(`[slidev] Invalid --video-size "${value}". Expected "<width>x<height>", for example "1920x1080"`)

  const width = Number(matched[1])
  const height = Number(matched[2])
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
    throw new Error(`[slidev] Invalid --video-size "${value}". Width and height should be positive integers.`)

  return {
    width,
    height,
  }
}

function sleep(ms: number) {
  if (ms <= 0)
    return Promise.resolve()
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

function parseVideoMotionScale(value?: number | string) {
  if (value === undefined || value === null)
    return 1
  const scale = typeof value === 'number' ? value : Number.parseFloat(value)
  if (!Number.isFinite(scale) || scale <= 0)
    throw new Error(`[slidev] Invalid --video-motion-scale "${value}". Expected a number greater than 0.`)
  return scale
}

function addToTree(tree: TocItem[], info: SlideInfo, slideIndexes: Record<number, number>, level = 1) {
  const titleLevel = info.level
  if (titleLevel && titleLevel > level && tree.length > 0 && tree[tree.length - 1].titleLevel < titleLevel) {
    addToTree(tree[tree.length - 1].children, info, slideIndexes, level + 1)
  }
  else {
    tree.push({
      no: info.index,
      children: [],
      level,
      titleLevel: titleLevel ?? level,
      path: String(slideIndexes[info.index + 1]),
      hideInToc: Boolean(info.frontmatter?.hideInToc),
      title: info.title,
    })
  }
}

function makeOutline(tree: TocItem[]): string {
  return tree.map(({ title, path, level, children }) => {
    const rootOutline = title ? `${path}|${'-'.repeat(level - 1)}|${title}` : null

    const childrenOutline = makeOutline(children)

    return childrenOutline.length > 0 ? `${rootOutline}\n${childrenOutline}` : rootOutline
  }).filter(outline => !!outline).join('\n')
}

export interface ExportNotesOptions {
  port?: number
  base?: string
  output?: string
  timeout?: number
  wait?: number
}

function createSlidevProgress(indeterminate = false) {
  function getSpinner(n = 0) {
    return [cyan('●'), green('◆'), blue('■'), yellow('▲')][n % 4]
  }
  let current = 0
  let spinner = 0
  let timer: any

  const progress = new SingleBar({
    clearOnComplete: true,
    hideCursor: true,
    format: `  {spin} ${yellow('rendering')}${indeterminate ? dim(yellow('...')) : ' {bar} {value}/{total}'}`,
    linewrap: false,
    barsize: 30,
  }, Presets.shades_grey)

  return {
    bar: progress,
    start(total: number) {
      progress.start(total, 0, { spin: getSpinner(spinner) })
      timer = setInterval(() => {
        spinner += 1
        progress.update(current, { spin: getSpinner(spinner) })
      }, 200)
    },
    update(v: number) {
      current = v
      progress.update(v, { spin: getSpinner(spinner) })
    },
    stop() {
      clearInterval(timer)
      progress.stop()
    },
  }
}

export async function exportNotes({
  port = 18724,
  base = '/',
  output = 'notes',
  timeout = 30000,
  wait = 0,
}: ExportNotesOptions): Promise<string> {
  const { chromium } = await importPlaywright()
  const browser = await chromium.launch()
  const context = await browser.newContext()
  const page = await context.newPage()

  const progress = createSlidevProgress(true)

  progress.start(1)

  if (!output.endsWith('.pdf'))
    output = `${output}.pdf`

  await page.goto(`http://localhost:${port}${base}presenter/print`, { waitUntil: 'networkidle', timeout })
  await page.waitForLoadState('networkidle')
  await page.emulateMedia({ media: 'screen' })

  if (wait)
    await page.waitForTimeout(wait)

  await page.pdf({
    path: output,
    margin: {
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
    },
    printBackground: true,
    preferCSSPageSize: true,
  })

  progress.stop()
  browser.close()

  return output
}

export async function exportSlides({
  port = 18724,
  total = 0,
  range,
  format = 'pdf',
  output = 'slides',
  slides,
  base = '/',
  timeout = 30000,
  wait = 0,
  dark = false,
  routerMode = 'history',
  width = 1920,
  height = 1080,
  withClicks = false,
  executablePath = undefined,
  withToc = false,
  perSlide = false,
  scale = 1,
  waitUntil,
  omitBackground = false,
  videoInterval = 2000,
  videoFps = 30,
  videoWidth = 1920,
  videoHeight = 1080,
  videoMotionScale = 1,
}: ExportOptions) {
  const pages: number[] = parseRangeString(total, range)

  const { chromium } = await importPlaywright()
  const browser = await chromium.launch({
    executablePath,
  })
  const isMp4 = format === 'mp4'
  const context = await browser.newContext({
    viewport: {
      width: isMp4 ? videoWidth : width,
      // Calculate height for every slides to be in the viewport to trigger the rendering of iframes (twitter, youtube...)
      height: isMp4
        ? videoHeight
        : (perSlide ? height : height * pages.length),
    },
    deviceScaleFactor: isMp4 ? 1 : scale,
  })
  const page = await context.newPage()
  const progress = createSlidevProgress(isMp4 || !perSlide)
  progress.start(isMp4 ? 1 : pages.length)

  if (format === 'pdf') {
    await genPagePdf()
  }
  else if (format === 'png') {
    await genPagePng(output)
  }
  else if (format === 'md') {
    await genPageMd()
  }
  else if (format === 'pptx') {
    const buffers = await genPagePng(false)
    await genPagePptx(buffers)
  }
  else if (format === 'mp4') {
    await genPageMp4()
  }
  else {
    throw new Error(`[slidev] Unsupported exporting format "${format}"`)
  }

  progress.stop()
  browser.close()

  const relativeOutput = slash(relative('.', output))
  return relativeOutput.startsWith('.') ? relativeOutput : `./${relativeOutput}`

  async function waitForSlideStabilized(slide: ReturnType<typeof page.locator>) {
    // Wait for slides to be loaded
    {
      const elements = slide.locator('.slidev-slide-loading')
      const count = await elements.count()
      for (let index = 0; index < count; index++)
        await elements.nth(index).waitFor({ state: 'detached' })
    }
    // Check for "data-waitfor" attribute and wait for given element to be loaded
    {
      const elements = slide.locator('[data-waitfor]')
      const count = await elements.count()
      for (let index = 0; index < count; index++) {
        const element = elements.nth(index)
        const attribute = await element.getAttribute('data-waitfor')
        if (attribute) {
          await element.locator(attribute).waitFor({ state: 'visible' }).catch((e) => {
            console.error(e)
            process.exitCode = 1
          })
        }
      }
    }
    // Wait for frames to load
    {
      const frames = page.frames()
      await Promise.all(frames.map(frame => frame.waitForLoadState()))
    }
    // Wait for Mermaid graphs to be rendered
    {
      const container = slide.locator('#mermaid-rendering-container')
      const count = await container.count()
      if (count > 0) {
        while (true) {
          const element = container.locator('div').first()
          if (await element.count() === 0)
            break
          await element.waitFor({ state: 'detached' })
        }
        await container.evaluate(node => node.style.display = 'none')
      }
    }
    // Hide Monaco aria container
    {
      const elements = slide.locator('.monaco-aria-container')
      const count = await elements.count()
      for (let index = 0; index < count; index++) {
        const element = elements.nth(index)
        await element.evaluate(node => node.style.display = 'none')
      }
    }
  }

  async function go(no: number | string, clicks?: string) {
    const query = new URLSearchParams()
    if (withClicks)
      query.set('print', 'clicks')
    else
      query.set('print', 'true')
    if (range)
      query.set('range', range)
    if (clicks)
      query.set('clicks', clicks)

    const url = routerMode === 'hash'
      ? `http://localhost:${port}${base}?${query}#${no}`
      : `http://localhost:${port}${base}${no}?${query}`
    await page.goto(url, {
      waitUntil,
      timeout,
    })
    if (waitUntil)
      await page.waitForLoadState(waitUntil)
    await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light', media: 'screen' })
    const slide = no === 'print'
      ? page.locator('body')
      : page.locator(`[data-slidev-no="${no}"]`)
    await slide.waitFor()
    await waitForSlideStabilized(slide)

    // Wait for the given time
    if (wait)
      await page.waitForTimeout(wait)
  }

  async function goPlay(no: number, clicks = 0) {
    const query = new URLSearchParams()
    query.set('embedded', 'true')
    if (clicks)
      query.set('clicks', `${clicks}`)

    const url = routerMode === 'hash'
      ? `http://localhost:${port}${base}?${query}#${no}`
      : `http://localhost:${port}${base}${no}?${query}`
    await page.goto(url, {
      waitUntil,
      timeout,
    })
    if (waitUntil)
      await page.waitForLoadState(waitUntil)

    await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light', media: 'screen' })
    const slide = page.locator(`[data-slidev-no="${no}"]`)
    await slide.waitFor()
    await waitForSlideStabilized(slide)
    await waitForStepSettled()
  }

  async function getSlidesIndex() {
    const clicksBySlide: Record<string, number> = {}
    const slides = page.locator('.print-slide-container')
    const count = await slides.count()
    for (let i = 0; i < count; i++) {
      const id = (await slides.nth(i).getAttribute('id')) || ''
      const path = Number(id.split('-')[0])
      clicksBySlide[path] = (clicksBySlide[path] || 0) + 1
    }

    const slideIndexes = Object.fromEntries(Object.entries(clicksBySlide)
      .reduce<[string, number][]>((acc, [path, clicks], i) => {
        acc.push([path, clicks + (acc[i - 1]?.[1] ?? 0)])
        return acc
      }, []))
    return slideIndexes
  }

  function getClicksFromUrl(url: string) {
    return url.match(/clicks=([1-9]\d*)/)?.[1]
  }

  async function genPageWithClicks(
    fn: (no: number, clicks?: string) => Promise<any>,
    no: number,
    clicks?: string,
  ) {
    await fn(no, clicks)
    if (withClicks) {
      await page.keyboard.press('ArrowRight', { delay: 100 })
      const _clicks = getClicksFromUrl(page.url())
      if (_clicks && clicks !== _clicks)
        await genPageWithClicks(fn, no, _clicks)
    }
  }

  async function genPagePdfPerSlide() {
    const buffers: Buffer[] = []
    const genPdfBuffer = async (i: number, clicks?: string) => {
      await go(i, clicks)
      const pdf = await page.pdf({
        width,
        height,
        margin: {
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
        },
        pageRanges: '1',
        printBackground: true,
        preferCSSPageSize: true,
      })
      buffers.push(pdf)
    }
    let idx = 0
    for (const i of pages) {
      await genPageWithClicks(genPdfBuffer, i)
      progress.update(++idx)
    }

    let mergedPdf = await PDFDocument.create({})
    for (const pdfBytes of buffers) {
      const pdf = await PDFDocument.load(pdfBytes)
      const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices())
      copiedPages.forEach((page) => {
        mergedPdf.addPage(page)
      })
    }

    // Edit generated PDF: add metadata and (optionally) TOC
    addPdfMetadata(mergedPdf)

    if (withToc)
      mergedPdf = await addTocToPdf(mergedPdf)

    const buffer = await mergedPdf.save()
    await fs.writeFile(output, buffer)
  }

  async function genPagePdfOnePiece() {
    await go('print')
    await page.pdf({
      path: output,
      width,
      height,
      margin: {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
      },
      printBackground: true,
      preferCSSPageSize: true,
    })

    // Edit generated PDF: add metadata and (optionally) TOC
    let pdfData = await fs.readFile(output)
    let pdf = await PDFDocument.load(pdfData)

    addPdfMetadata(pdf)

    if (withToc)
      pdf = await addTocToPdf(pdf)

    pdfData = Buffer.from(await pdf.save())
    await fs.writeFile(output, pdfData)
  }

  async function genPagePngOnePiece(writeToDisk: string | false) {
    const result: ExportPngResult[] = []
    await go('print')
    const slideContainers = page.locator('.print-slide-container')
    const count = await slideContainers.count()

    for (let i = 0; i < count; i++) {
      const id = (await slideContainers.nth(i).getAttribute('id')) || ''
      const slideNo = +id.split('-')[0]

      // Only process slides that are in the specified range
      if (!pages.includes(slideNo))
        continue

      progress.update(result.length + 1)

      const buffer = await slideContainers.nth(i).screenshot({
        omitBackground,
      })
      const filename = `${withClicks ? id : slideNo}.png`
      result.push({ slideIndex: slideNo - 1, buffer, filename })
      if (writeToDisk)
        await fs.writeFile(path.join(writeToDisk, filename), buffer)
    }
    return result
  }

  async function genPagePngPerSlide(writeToDisk: string | false) {
    const result: ExportPngResult[] = []
    const genScreenshot = async (no: number, clicks?: string) => {
      await go(no, clicks)
      const buffer = await page.screenshot({
        omitBackground,
      })
      const filename = `${no.toString().padStart(2, '0')}${clicks ? `-${clicks}` : ''}.png`
      result.push({ slideIndex: no - 1, buffer, filename })
      if (writeToDisk) {
        await fs.writeFile(
          path.join(writeToDisk, filename),
          buffer,
        )
      }
    }
    for (const no of pages)
      await genPageWithClicks(genScreenshot, no)
    return result
  }

  function genPagePdf() {
    if (!output.endsWith('.pdf'))
      output = `${output}.pdf`
    return perSlide
      ? genPagePdfPerSlide()
      : genPagePdfOnePiece()
  }

  async function genPagePng(writeToDisk: string | false) {
    if (writeToDisk) {
      await fs.rm(writeToDisk, { force: true, recursive: true })
      await fs.mkdir(writeToDisk, { recursive: true })
    }
    return perSlide
      ? genPagePngPerSlide(writeToDisk)
      : genPagePngOnePiece(writeToDisk)
  }

  async function genPageMd() {
    const pngs = await genPagePng(dirname(output))
    const content = slides
      .filter(({ index }) => pages.includes(index + 1))
      .map(({ title, index, note }) =>
        pngs.filter(({ slideIndex }) => slideIndex === index)
          .map(({ filename }) => `![${title || (index + 1)}](./${filename})\n\n`)
          .join('')
          + (note ? `${note.trim()}\n\n` : ''),
      )
      .join('---\n\n')
    await fs.writeFile(ensureSuffix('.md', output), content)
  }

  // Ported from https://github.com/marp-team/marp-cli/blob/main/src/converter.ts
  async function genPagePptx(pngs: ExportPngResult[]) {
    const { default: PptxGenJS } = await import('pptxgenjs')
    const pptx = new PptxGenJS()

    const layoutName = `${width}x${height}`
    pptx.defineLayout({
      name: layoutName,
      width: width / 96,
      height: height / 96,
    })
    pptx.layout = layoutName

    const titleSlide = slides[0]
    pptx.author = titleSlide?.frontmatter?.author
    pptx.company = 'Created using Slidev'
    if (titleSlide?.title)
      pptx.title = titleSlide?.title
    if (titleSlide?.frontmatter?.info)
      pptx.subject = titleSlide?.frontmatter?.info

    pngs.forEach(({ slideIndex, buffer }) => {
      const slide = pptx.addSlide()
      slide.background = {
        data: `data:image/png;base64,${buffer.toString('base64')}`,
      }

      const note = slides[slideIndex].note
      if (note)
        slide.addNotes(note)
    })

    const buffer = await pptx.write({
      outputType: 'nodebuffer',
    }) as Buffer
    if (!output.endsWith('.pptx'))
      output = `${output}.pptx`
    await fs.writeFile(output, buffer)
  }

  function getStepKey(step: Pick<Mp4StepInfo, 'no' | 'clicks'>) {
    return `${step.no}-${step.clicks}`
  }

  async function getStepInfo() {
    return await page.evaluate(() => {
      const bridge = window.__slidev_export__
      if (typeof bridge?.getStepInfo === 'function')
        return bridge.getStepInfo()

      const nav = window.__slidev__?.nav
      const currentSlideNo = nav?.currentSlideNo
      const clicks = nav?.clicks
      const clicksTotal = nav?.clicksTotal
      const hasNext = nav?.hasNext
      return {
        no: (typeof currentSlideNo === 'object' && currentSlideNo && 'value' in currentSlideNo)
          ? Number(currentSlideNo.value ?? 0)
          : Number(currentSlideNo ?? 0),
        clicks: (typeof clicks === 'object' && clicks && 'value' in clicks)
          ? Number(clicks.value ?? 0)
          : Number(clicks ?? 0),
        clicksTotal: (typeof clicksTotal === 'object' && clicksTotal && 'value' in clicksTotal)
          ? Number(clicksTotal.value ?? 0)
          : Number(clicksTotal ?? 0),
        hasNext: (typeof hasNext === 'object' && hasNext && 'value' in hasNext)
          ? Boolean(hasNext.value)
          : Boolean(hasNext),
      } satisfies SlidevExportStepInfo
    })
  }

  async function nextStep() {
    return await page.evaluate(async () => {
      const bridge = window.__slidev_export__
      if (typeof bridge?.nextStep === 'function') {
        await bridge.nextStep()
        return true
      }

      const nav = window.__slidev__?.nav
      if (typeof nav?.next === 'function') {
        await nav.next()
        return true
      }

      return false
    })
  }

  async function getTransitionSettleBudget() {
    return await page.evaluate(() => {
      const raw = getComputedStyle(document.documentElement)
        .getPropertyValue('--slidev-transition-duration')
        .trim()

      const parseMs = (value: string) => {
        if (!value)
          return 0
        if (value.endsWith('ms'))
          return Number.parseFloat(value.slice(0, -2)) || 0
        if (value.endsWith('s'))
          return (Number.parseFloat(value.slice(0, -1)) || 0) * 1000
        return Number.parseFloat(value) || 0
      }

      // Keep this bounded to avoid long waits caused by custom/infinite animations.
      return Math.max(120, Math.min(3000, parseMs(raw) + 300))
    })
  }

  async function waitForStepSettled(timeout = 10000) {
    const settleBudget = await getTransitionSettleBudget()

    await sleep(settleBudget)

    await page.waitForFunction(() => {
      const root = document.querySelector('#slideshow') as Element | null
      if (!root)
        return true
      return !root.querySelector('[class*="-enter-active"], [class*="-leave-active"]')
    }, undefined, { timeout: Math.min(timeout, settleBudget + 2000) }).catch(() => {})

    await page.evaluate(async () => {
      await new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      )
    })
  }

  async function waitForFfmpeg() {
    const child = spawn('ffmpeg', ['-version'], { stdio: 'ignore' })
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => {
        if (code === 0)
          resolve()
        else
          reject(new Error('ffmpeg exited with non-zero code'))
      })
    }).catch(() => {
      throw new Error('[slidev] MP4 export requires ffmpeg. Please install ffmpeg and try again.')
    })
  }

  async function genPageMp4() {
    if (withClicks === false)
      throw new Error('[slidev] MP4 export always includes clicks. Remove --with-clicks=false to continue.')

    if (!Number.isInteger(videoFps) || videoFps < 1 || videoFps > 60)
      throw new Error(`[slidev] Invalid video fps "${videoFps}". Expected an integer between 1 and 60.`)
    if (!Number.isInteger(videoInterval) || videoInterval < 0)
      throw new Error(`[slidev] Invalid video interval "${videoInterval}". Expected a non-negative integer.`)

    if (!output.endsWith('.mp4'))
      output = `${output}.mp4`

    const debugMp4 = process.env.SLIDEV_EXPORT_DEBUG_MP4 === 'true'
    // Capture-side motion dilation. >1 means slower visual motion while recording,
    // so high-resolution exports can collect more unique frames per transition.
    const motionScale = parseVideoMotionScale(videoMotionScale)
    // Encoding-side timeline compression to restore the intended playback pace
    // after capture-side motion dilation.
    const playbackSpeedup = motionScale > 1 ? motionScale : 1

    const startSlideNo = pages[0] ?? 1
    const endSlideNo = pages[pages.length - 1] ?? startSlideNo
    const isContiguousRange = pages.every((value, index) => index === 0 || value === pages[index - 1] + 1)
    if (!isContiguousRange)
      throw new Error('[slidev] MP4 export currently requires a contiguous --range (for example: "1-5").')

    await waitForFfmpeg()
    await goPlay(startSlideNo, 0)

    if (motionScale > 1) {
      const applied = await page.evaluate((scale) => {
        const root = document.documentElement
        const raw = getComputedStyle(root)
          .getPropertyValue('--slidev-transition-duration')
          .trim()

        const parseMs = (value: string) => {
          if (!value)
            return 0
          if (value.endsWith('ms'))
            return Number.parseFloat(value.slice(0, -2)) || 0
          if (value.endsWith('s'))
            return (Number.parseFloat(value.slice(0, -1)) || 0) * 1000
          return Number.parseFloat(value) || 0
        }

        const transitionMs = parseMs(raw)
        if (transitionMs > 0)
          root.style.setProperty('--slidev-transition-duration', `${transitionMs * scale}ms`)

        const applyAnimationRate = () => {
          document.getAnimations().forEach((animation) => {
            if (!(animation as any).__slidev_export_original_rate)
              (animation as any).__slidev_export_original_rate = animation.playbackRate || 1
            const baseRate = (animation as any).__slidev_export_original_rate || 1
            animation.playbackRate = baseRate / scale
          })
        }

        applyAnimationRate()
        // Some animations start lazily during interaction; keep normalizing their
        // playbackRate while exporting.
        const timer = window.setInterval(applyAnimationRate, 250)

        const win = window as any
        const previousCleanup = win.__slidev_export_motion_cleanup__
        if (typeof previousCleanup === 'function') {
          previousCleanup()
        }

        win.__slidev_export_motion_cleanup__ = () => {
          clearInterval(timer)
        }

        return {
          transitionMs,
          appliedTransitionMs: transitionMs > 0 ? transitionMs * scale : 0,
        }
      }, motionScale)

      if (debugMp4) {
        process.stderr.write(`[slidev] mp4 motion scale x${motionScale}\n`)
        process.stderr.write(`[slidev] mp4 timeline speedup x${playbackSpeedup}\n`)
        if (applied.transitionMs > 0)
          process.stderr.write(`[slidev] mp4 transition duration ${Math.round(applied.transitionMs)}ms -> ${Math.round(applied.appliedTransitionMs)}ms\n`)
      }
    }

    const ffmpegArgs = [
      '-y',
      '-f',
      'image2pipe',
      '-framerate',
      `${videoFps}`,
      '-vcodec',
      'png',
      '-i',
      '-',
      '-an',
      '-c:v',
      'libx264',
      // Reduce encoder-side backpressure when exporting high-resolution videos.
      '-preset',
      'veryfast',
    ]

    if (playbackSpeedup > 1) {
      // Render with slower motion, then speed up the timeline back to target pace.
      ffmpegArgs.push(
        '-vf',
        `setpts=PTS/${playbackSpeedup}`,
        '-r',
        `${videoFps}`,
      )
    }

    ffmpegArgs.push(
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      output,
    )

    const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['pipe', 'ignore', 'pipe'],
    })

    let ffmpegLogs = ''
    ffmpeg.stderr?.on('data', (chunk) => {
      ffmpegLogs += chunk.toString()
    })

    const ffmpegDone = new Promise<void>((resolve, reject) => {
      ffmpeg.once('error', reject)
      ffmpeg.once('close', (code) => {
        if (code === 0)
          resolve()
        else
          reject(new Error(ffmpegLogs.trim() || `[slidev] ffmpeg exited with code ${code}`))
      })
    })

    const target = page.locator('#slide-content')
    await target.waitFor()

    async function writeFrame(buffer: Buffer) {
      if (!ffmpeg.stdin.write(buffer))
        await once(ffmpeg.stdin, 'drain')
    }

    // Clip to the transformed slide content bounds to avoid 1px side seams
    // caused by sub-pixel edges when capturing the outer container.
    const clip = await page.evaluate(() => {
      const element = document.querySelector('#slide-content')
      if (!element)
        return null
      const rect = element.getBoundingClientRect()
      const left = Math.ceil(rect.left)
      const top = Math.ceil(rect.top)
      const right = Math.floor(rect.right)
      const bottom = Math.floor(rect.bottom)
      const width = right - left
      const height = bottom - top
      if (width <= 0 || height <= 0)
        return null
      return { x: left, y: top, width, height }
    })

    async function captureFrame() {
      if (clip) {
        return await page.screenshot({
          type: 'png',
          clip,
        })
      }
      return await target.screenshot({ type: 'png' })
    }

    const startedAt = Date.now()
    const frameInterval = 1000 / videoFps
    let writtenFrames = 0
    let nextFrameTime = 0

    async function catchUpFrames(buffer: Buffer) {
      const now = Date.now()
      const elapsedMs = now - startedAt
      const expectedFrames = Math.max(1, Math.floor(elapsedMs * videoFps / 1000))
      while (writtenFrames < expectedFrames) {
        await writeFrame(buffer)
        writtenFrames += 1
      }
    }

    async function captureAndWriteFrame() {
      const frame = await captureFrame()
      await writeFrame(frame)
      writtenFrames += 1
      await catchUpFrames(frame)

      const elapsedMs = Date.now() - startedAt
      nextFrameTime = (writtenFrames + 1) * frameInterval
      const sleepMs = nextFrameTime - elapsedMs
      if (sleepMs > 0)
        await sleep(sleepMs)

      return frame
    }

    async function captureForDuration(durationMs: number) {
      if (durationMs <= 0)
        return

      const deadline = Date.now() + durationMs
      while (Date.now() < deadline)
        await captureAndWriteFrame()
    }

    let captureError: unknown
    try {
      const initialFrame = await captureFrame()
      await writeFrame(initialFrame)
      writtenFrames += 1
      await catchUpFrames(initialFrame)

      while (true) {
        // Keep the interval anchored after each step animation settles.
        await waitForStepSettled()
        // We are capturing slowed motion, then compressing time in ffmpeg via setpts.
        // Scale capture duration so the final encoded video keeps the same interval.
        await captureForDuration(videoInterval * playbackSpeedup)

        const step = await getStepInfo()
        if (debugMp4)
          process.stderr.write(`[slidev] mp4 step ${step.no}-${step.clicks}/${step.clicksTotal} hasNext=${step.hasNext}\n`)
        const canAdvanceInRange = step.no < endSlideNo
          || (step.no === endSlideNo && step.clicks < step.clicksTotal)
        if (!step.hasNext || !canAdvanceInRange)
          break

        const previousStamp = getStepKey(step)
        const advanced = await nextStep()
        if (!advanced)
          throw new Error('[slidev] Failed to trigger next step in browser context.')

        let changed = false
        const transitionTimeoutMs = Math.min(10000, Math.max(2000, timeout))
        const transitionDeadline = Date.now() + transitionTimeoutMs

        while (Date.now() < transitionDeadline) {
          await captureAndWriteFrame()
          const current = await getStepInfo()
          if (getStepKey(current) !== previousStamp) {
            changed = true
            break
          }
        }

        if (!changed)
          throw new Error(`[slidev] Failed to advance from step ${previousStamp}`)

        // Capture through the expected transition tail before entering the next interval.
        const transitionBudget = await getTransitionSettleBudget()
        await captureForDuration(transitionBudget)
      }

      const lastFrame = await captureFrame()
      await writeFrame(lastFrame)
      writtenFrames += 1
      await catchUpFrames(lastFrame)
      ffmpeg.stdin.end()
      await ffmpegDone
    }
    catch (error) {
      captureError = error
    }

    if (captureError) {
      ffmpeg.stdin.end()
      await ffmpegDone.catch(() => {})
      throw captureError
    }
  }

  // Adds metadata (title, author, keywords) to PDF document, mutating it
  function addPdfMetadata(pdf: PDFDocument): void {
    const titleSlide = slides[0]
    if (titleSlide?.title)
      pdf.setTitle(titleSlide.title)
    if (titleSlide?.frontmatter?.info)
      pdf.setSubject(titleSlide.frontmatter.info)
    if (titleSlide?.frontmatter?.author)
      pdf.setAuthor(titleSlide.frontmatter.author)
    if (titleSlide?.frontmatter?.keywords) {
      if (Array.isArray(titleSlide?.frontmatter?.keywords))
        pdf.setKeywords(titleSlide?.frontmatter?.keywords)
      else
        pdf.setKeywords(titleSlide?.frontmatter?.keywords.split(','))
    }
  }

  async function addTocToPdf(pdf: PDFDocument): Promise<PDFDocument> {
    const outlinePdf = outlinePdfFactory(pdfLib)
    const slideIndexes = await getSlidesIndex()

    const tocTree = slides.filter(slide => slide.title)
      .reduce((acc: TocItem[], slide) => {
        addToTree(acc, slide, slideIndexes)
        return acc
      }, [])

    const outline = makeOutline(tocTree)

    return await outlinePdf({ outline, pdf })
  }
}

export function getExportOptions(args: ExportArgs, options: ResolvedSlidevOptions, outFilename?: string): Omit<ExportOptions, 'port' | 'base'> {
  const config = {
    ...options.data.config.export,
    ...args,
    ...clearUndefined({
      waitUntil: args['wait-until'],
      withClicks: args['with-clicks'],
      executablePath: args['executable-path'],
      withToc: args['with-toc'],
      perSlide: args['per-slide'],
      omitBackground: args['omit-background'],
      videoInterval: args['video-interval'],
      videoFps: args['video-fps'],
      videoSize: args['video-size'],
      videoMotionScale: args['video-motion-scale'],
    }),
  }
  const {
    entry,
    output,
    format,
    timeout,
    wait,
    waitUntil,
    range,
    dark,
    withClicks,
    executablePath,
    withToc,
    perSlide,
    scale,
    omitBackground,
    videoInterval,
    videoFps,
    videoSize,
    videoMotionScale,
  } = config
  const parsedVideoSize = parseVideoSize(videoSize)
  outFilename = output || outFilename || options.data.config.exportFilename || `${path.basename(entry, '.md')}-export`
  return {
    output: outFilename,
    slides: options.data.slides,
    total: options.data.slides.length,
    range,
    format: (format || 'pdf') as 'pdf' | 'png' | 'pptx' | 'md' | 'mp4',
    timeout: timeout ?? 30000,
    wait: wait ?? 0,
    waitUntil: waitUntil === 'none' ? undefined : (waitUntil ?? 'networkidle') as 'networkidle' | 'load' | 'domcontentloaded',
    dark: dark || options.data.config.colorSchema === 'dark',
    routerMode: options.data.config.routerMode,
    width: options.data.config.canvasWidth,
    height: Math.round(options.data.config.canvasWidth / options.data.config.aspectRatio),
    withClicks: withClicks ?? ['pptx', 'mp4'].includes(String(format)),
    executablePath,
    withToc: withToc || false,
    perSlide: perSlide || false,
    scale: scale || 2,
    omitBackground: omitBackground ?? false,
    videoInterval: videoInterval ?? 2000,
    videoFps: videoFps ?? 30,
    videoWidth: parsedVideoSize?.width ?? 1920,
    videoHeight: parsedVideoSize?.height ?? 1080,
    videoMotionScale: videoMotionScale ?? 1,
  }
}

async function importPlaywright(): Promise<typeof import('playwright-chromium')> {
  const { userRoot, userWorkspaceRoot } = await getRoots()

  // 1. resolve from user root
  try {
    return await import(await resolve('playwright-chromium', { url: userRoot }))
  }
  catch { }

  // 2. resolve from user workspace root
  if (userWorkspaceRoot !== userRoot) {
    try {
      return await import(await resolve('playwright-chromium', { url: userWorkspaceRoot }))
    }
    catch { }
  }

  // 3. resolve from global registry
  const { resolveGlobal } = await import('resolve-global')
  try {
    const imported = await import(resolveGlobal('playwright-chromium'))
    return imported.default ?? imported
  }
  catch { }

  // 4. resolve from current @slidev/cli installation
  try {
    return await import('playwright-chromium')
  }
  catch { }

  throw new Error('The exporting for Slidev is powered by Playwright, please install it via `npm i -D playwright-chromium`')
}
