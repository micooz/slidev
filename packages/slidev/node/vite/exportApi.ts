import type { ExportArgs, ResolvedSlidevOptions } from '@slidev/types'
import type { Plugin, ViteDevServer } from 'vite'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { basename, resolve } from 'node:path'
import { getBodyJson } from '../utils'

interface VideoExportJob {
  status: 'running' | 'done' | 'error'
  file?: string
  error?: string
  startedAt: number
  completedAt?: number
  durationMs?: number
}

const VIDEO_EXPORT_JOB_TTL_MS = 10 * 60 * 1000

function formatTimestamp(date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function sanitizePart(value: string) {
  return value
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function getServerPort(server: ViteDevServer) {
  const address = server.httpServer?.address()
  if (address && typeof address === 'object')
    return address.port
  return server.config.server.port
}

export function createExportApiPlugin(
  options: ResolvedSlidevOptions,
): Plugin {
  const videoExportJobs = new Map<string, VideoExportJob>()

  function resolveJobResponse(job: VideoExportJob, jobId?: string) {
    const now = Date.now()
    const resolvedDurationMs = job.status === 'running'
      ? Math.max(0, now - job.startedAt)
      : (job.durationMs ?? Math.max(0, (job.completedAt ?? now) - job.startedAt))

    return {
      ...(jobId ? { jobId } : {}),
      ...job,
      durationMs: resolvedDurationMs,
      filename: job.file ? basename(job.file) : undefined,
      downloadUrl: jobId && job.status === 'done' ? `/__slidev/export/video/${jobId}/download` : undefined,
    }
  }

  function cleanupJobs() {
    const now = Date.now()
    for (const [id, job] of videoExportJobs.entries()) {
      if (job.status === 'running')
        continue
      const completedAt = job.completedAt ?? job.startedAt
      if (now - completedAt > VIDEO_EXPORT_JOB_TTL_MS)
        videoExportJobs.delete(id)
    }
  }

  function getDefaultOutputBase() {
    const base = options.data.config.exportFilename || `${basename(options.entry, '.md')}-export`
    return sanitizePart(base) || 'slidev-export'
  }

  function buildOutputFilename(payload: {
    range?: string
    videoFps?: number
    videoSize?: string
  }, jobId: string) {
    const outputBase = getDefaultOutputBase()
    const rangePart = sanitizePart(payload.range?.trim() || 'all')
    const fpsPart = Number.isFinite(payload.videoFps) ? `${Math.round(Number(payload.videoFps))}fps` : '30fps'
    const sizePart = sanitizePart(payload.videoSize || '1920x1080') || '1920x1080'
    const timestamp = formatTimestamp()
    const shortJobId = jobId.slice(0, 8)
    return `${outputBase}-${rangePart}-${fpsPart}-${sizePart}-${timestamp}-${shortJobId}.mp4`
  }

  function listJobs() {
    return [...videoExportJobs.entries()]
      .map(([jobId, job]) => resolveJobResponse(job, jobId))
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  return {
    name: 'slidev:export-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        cleanupJobs()

        const videoMatch = req.url?.match(/^\/__slidev\/export\/video(?:\/([^/]+)(?:\/(download))?)?$/)
        if (!videoMatch)
          return next()

        const [, jobId, action] = videoMatch
        if (req.method === 'GET' && jobId === 'jobs' && action !== 'download') {
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ jobs: listJobs() }))
          return
        }

        if (req.method === 'POST' && !jobId) {
          try {
            const rawPayload = await getBodyJson(req)
            const payload = (rawPayload && typeof rawPayload === 'object' ? rawPayload : {}) as {
              videoInterval?: number
              videoFps?: number
              videoSize?: string
              range?: string
              dark?: boolean
            }

            const port = getServerPort(server)
            if (!port)
              throw new Error('Unable to resolve dev server port for exporting')

            const id = randomUUID()
            const filename = buildOutputFilename(payload, id)
            const output = resolve(options.userRoot, filename)
            const startedAt = Date.now()
            videoExportJobs.set(id, {
              status: 'running',
              file: output,
              startedAt,
            })

            const args: ExportArgs = {
              entry: options.entry,
              format: 'mp4',
              output,
            }

            if (Number.isFinite(payload.videoInterval))
              args['video-interval'] = Number(payload.videoInterval)
            if (Number.isFinite(payload.videoFps))
              args['video-fps'] = Number(payload.videoFps)
            if (typeof payload.videoSize === 'string')
              args['video-size'] = payload.videoSize
            if (typeof payload.range === 'string' && payload.range.trim())
              args.range = payload.range.trim()
            if (typeof payload.dark === 'boolean')
              args.dark = payload.dark

            ;(async () => {
              try {
                const { exportSlides, getExportOptions } = await import('../commands/export')
                await exportSlides({
                  port,
                  base: server.config.base || '/',
                  ...getExportOptions(args, options),
                })
                const completedAt = Date.now()
                videoExportJobs.set(id, {
                  status: 'done',
                  file: output,
                  startedAt,
                  completedAt,
                  durationMs: Math.max(0, completedAt - startedAt),
                })
              }
              catch (error) {
                const completedAt = Date.now()
                videoExportJobs.set(id, {
                  status: 'error',
                  error: error instanceof Error ? error.message : String(error),
                  file: output,
                  startedAt,
                  completedAt,
                  durationMs: Math.max(0, completedAt - startedAt),
                })
              }
            })()

            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ jobId: id }))
            return
          }
          catch (error) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }))
            return
          }
        }

        if (req.method === 'GET' && jobId && action !== 'download') {
          const job = videoExportJobs.get(jobId)
          if (!job) {
            res.statusCode = 404
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Export job not found' }))
            return
          }

          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(resolveJobResponse(job, jobId)))
          return
        }

        if (req.method === 'GET' && jobId && action === 'download') {
          const job = videoExportJobs.get(jobId)
          if (!job || job.status !== 'done' || !job.file) {
            res.statusCode = 404
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Export file not ready' }))
            return
          }

          res.statusCode = 200
          res.setHeader('Content-Type', 'video/mp4')
          res.setHeader('Content-Disposition', `attachment; filename="${basename(job.file)}"`)
          createReadStream(job.file).pipe(res)
          return
        }

        return next()
      })
    },
  }
}
