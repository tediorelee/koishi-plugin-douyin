import { Context } from 'koishi'
import { setTimeout as sleep } from 'node:timers/promises'
import { Diagnostics } from './logger'

export interface ApiConfig {
  apiHost: string
  apiVersion?: 'v4' | 'v5'
  apiKey?: string
  taskTimeout?: number
  pollInterval?: number
}

export interface VideoDetail {
  description: string
  isImage: boolean
  images: string[]
  duration?: number
  cover?: string
  videoUrls: string[]
}

interface V4Response {
  code: number
  data?: {
    desc?: string
    image_data?: { no_watermark_image_list?: string[] }
    music?: { duration?: number }
    cover_data?: { dynamic_cover?: { url_list?: string[] } }
  }
}

interface MediaUrl {
  url?: string
  urls?: string[]
}

interface V5Content {
  platform: string
  content_id: string
  kind: string
  description?: string
  title?: string
  duration_ms?: number | null
  media: {
    video?: MediaUrl | null
    streams?: MediaUrl[]
    images?: MediaUrl[]
    covers?: MediaUrl[]
  }
}

interface V5Failure {
  code?: string
  message?: string
  retry_after?: number
  retryable?: boolean
  details?: Record<string, unknown>
}

interface V5Task {
  task_id: string
  state: string
  data?: V5Content
  error?: V5Failure
}

interface V5Envelope<T> {
  success: boolean
  data: T
  error?: V5Failure | null
  meta?: { request_id?: string }
  httpRequestId?: string
}

export class ApiError extends Error {
  retryAfter?: number
  retryable?: boolean
  details?: Record<string, unknown>
  status?: number
  upstreamRequestId?: string
  taskId?: string
  fromTask?: boolean
  constructor(public code: string, message: string, public requestId?: string) {
    super(message)
    this.name = 'ApiError'
  }
}

const RETRYABLE_CODES = new Set([
  'RATE_LIMITED', 'QUEUE_FULL', 'IDENTITY_POOL_EXHAUSTED', 'ENDPOINT_CIRCUIT_OPEN',
  'UPSTREAM_RISK_CONTROL', 'SIGNING_FAILED', 'INTERNAL', 'DOWNLOADER_UNAVAILABLE',
])

function mediaUrls(media?: MediaUrl | null): string[] {
  return [...new Set([media?.url, ...(media?.urls || [])].filter((url): url is string => {
    if (typeof url !== 'string') return false
    try {
      return ['http:', 'https:'].includes(new URL(url).protocol)
    } catch {
      return false
    }
  }))]
}

export class DouyinApi {
  private host: string
  private controller = new AbortController()
  private rateResumeAt = 0
  readonly version: 'v4' | 'v5'

  constructor(private ctx: Context, private config: ApiConfig, private log: Diagnostics) {
    this.host = config.apiHost.replace(/\/+$/, '')
    this.version = config.apiVersion || 'v4'
    ctx.on('dispose', () => this.controller.abort())
  }

  async parse(url: string, trace: string): Promise<VideoDetail> {
    if (this.version === 'v5') return this.parseV5(url, trace)
    this.log.debug('api.request', { trace, version: 'v4', method: 'GET', path: '/api/hybrid/video_data' })
    const response = await this.ctx.http.get<V4Response>(
      `${this.host}/api/hybrid/video_data?url=${encodeURIComponent(url)}&minimal=true`,
    )
    if (response.code !== 200 || !response.data) {
      throw new ApiError('V4_PARSE_FAILED', '解析失败! 该链接或许不支持')
    }
    this.log.debug('api.response', { trace, version: 'v4', code: response.code })
    const data = response.data
    return {
      description: data.desc || '',
      isImage: !!data.image_data && Object.keys(data.image_data).length > 0,
      images: data.image_data?.no_watermark_image_list || [],
      // V4 保留原来的 music.duration 判断，避免改变旧版本行为。
      duration: data.music?.duration,
      cover: data.cover_data?.dynamic_cover?.url_list?.[0],
      videoUrls: [],
    }
  }

  async download(url: string, detail: VideoDetail, trace: string): Promise<ArrayBuffer> {
    if (this.version === 'v4') {
      this.log.debug('api.request', { trace, version: 'v4', method: 'GET', path: '/api/download' })
      return this.ctx.http.get<ArrayBuffer>(
        `${this.host}/api/download?url=${encodeURIComponent(url)}&prefix=true&with_watermark=true`,
        { responseType: 'arraybuffer' },
      )
    }
    if (!detail.videoUrls.length) throw new ApiError('NO_VIDEO_URL', 'V5 未返回可下载的视频地址')
    const started = Date.now()
    for (const [index, videoUrl] of detail.videoUrls.entries()) {
      this.log.debug('media.download.start', { trace, mirror: index + 1, host: new URL(videoUrl).host })
      try {
        const buffer = await this.ctx.http.get<ArrayBuffer>(videoUrl, {
          responseType: 'arraybuffer',
          timeout: 60_000,
          signal: this.controller.signal,
          // API Key 只发往 V5 服务，绝不转发给媒体 CDN。
          headers: {
            Referer: 'https://www.douyin.com/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          },
        })
        if (!buffer.byteLength) throw new ApiError('EMPTY_VIDEO', '视频下载结果为空')
        this.log.debug('media.download.done', { trace, bytes: buffer.byteLength, elapsedMs: Date.now() - started })
        return buffer
      } catch (error) {
        if (this.controller.signal.aborted) throw error
        if (index + 1 < detail.videoUrls.length) {
          this.log.warn('media.download.mirror_failed', { trace, mirror: index + 1 })
        }
        this.log.error('media.download.error', error, { trace, mirror: index + 1 })
      }
    }
    throw new ApiError('VIDEO_DOWNLOAD_FAILED', '所有视频下载地址均失败，请重试以获取新地址')
  }

  private async requestV5<T>(path: string, deadline: number, trace: string, body?: object): Promise<V5Envelope<T>> {
    for (let attempt = 0; ; attempt++) {
      try {
        if (this.rateResumeAt > Date.now()) {
          const error = new ApiError('RATE_LIMITED', 'V5 当前限流窗口额度已耗尽')
          error.retryAfter = (this.rateResumeAt - Date.now()) / 1000
          await this.backoff(error, attempt, deadline, trace)
        }
        return await this.requestV5Once<T>(path, deadline, trace, body)
      } catch (error) {
        if (!(error instanceof ApiError) || !this.canRetry(error) || attempt >= 2) throw error
        await this.backoff(error, attempt, deadline, trace)
      }
    }
  }

  private async requestV5Once<T>(path: string, deadline: number, trace: string, body?: object): Promise<V5Envelope<T>> {
    const timeout = Math.min(30_000, this.remaining(deadline))
    this.log.debug('api.request', { trace, version: 'v5', method: body ? 'POST' : 'GET', path })
    let responseHeaders: Headers | undefined
    let status: number | undefined
    const options = {
      timeout,
      signal: this.controller.signal,
      headers: {
        ...(this.config.apiKey ? { 'X-API-Key': this.config.apiKey } : {}),
        'Accept-Language': 'zh-CN',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      responseType: async (raw: Response): Promise<V5Envelope<T>> => {
        responseHeaders = raw.headers
        status = raw.status
        return raw.json()
      },
    }
    let response: V5Envelope<T>
    try {
      response = body
        ? await this.ctx.http.post<V5Envelope<T>>(`${this.host}${path}`, body, options)
        : await this.ctx.http.get<V5Envelope<T>>(`${this.host}${path}`, options)
    } catch (error) {
      const failed = (error as { response?: { data?: V5Envelope<T>; headers?: Headers; status?: number } })?.response
      if (failed?.data?.success === false) {
        this.rateHints(failed.headers)
        throw this.failure(failed.data.error, failed.data.meta?.request_id, failed.headers, failed.status)
      }
      if (Date.now() >= deadline) this.remaining(deadline)
      if (status !== undefined) {
        throw new ApiError('INVALID_RESPONSE', 'V5 响应不是有效 JSON，请检查服务地址', responseHeaders?.get('X-Request-ID') || undefined)
      }
      throw error
    }
    this.rateHints(responseHeaders)
    const requestId = responseHeaders?.get('X-Request-ID') || response?.meta?.request_id
    if (!response || typeof response.success !== 'boolean') {
      throw new ApiError('INVALID_RESPONSE', 'V5 响应格式不匹配，请检查 API 版本及服务地址', requestId)
    }
    this.log.debug('api.response', {
      trace, status, success: response.success, requestId, upstreamRequestId: response.meta?.request_id,
      remaining: responseHeaders?.get('X-RateLimit-Remaining'), reset: responseHeaders?.get('X-RateLimit-Reset'),
      serverElapsedMs: responseHeaders?.get('X-Response-Time-Ms'),
    })
    if (!response.success) throw this.failure(response.error, response.meta?.request_id, responseHeaders, status)
    if (!response.data || typeof response.data !== 'object') {
      throw new ApiError('INVALID_RESPONSE', 'V5 返回了空结果或无效结果', response.meta?.request_id)
    }
    return { ...response, httpRequestId: requestId }
  }

  private async parseV5(url: string, trace: string): Promise<VideoDetail> {
    const deadline = Date.now() + (this.config.taskTimeout ?? 120) * 1000
    let resubmittedExpired = false
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.parseV5Task(url, trace, deadline, attempt > 0)
      } catch (error) {
        if (!(error instanceof ApiError) || attempt >= 2) throw error
        if (error.code === 'TASK_NOT_FOUND' && !resubmittedExpired) {
          resubmittedExpired = true
          this.log.warn('api.task.expired', { trace, taskId: error.taskId, requestId: error.requestId })
          continue
        }
        // 只有已明确失败的可重试任务才重提；HTTP 重试由 requestV5 处理。
        if (!error.fromTask || !this.canRetry(error)) throw error
        await this.backoff(error, attempt, deadline, trace)
      }
    }
  }

  private async parseV5Task(url: string, trace: string, deadline: number, refresh: boolean): Promise<VideoDetail> {
    const response = await this.requestV5<V5Task | V5Content>(
      `/api/v1/parse${refresh ? '?refresh=true' : ''}`, deadline, trace, {
      url,
      include_raw: false,
    })
    if ('media' in response.data) return this.normalizeV5(response.data)
    let task = response.data
    if (typeof task.task_id !== 'string' || !task.task_id) {
      throw new ApiError('INVALID_RESPONSE', 'V5 未返回任务 ID', response.meta?.request_id)
    }
    const taskId = task.task_id
    try {
      return await this.collectV5(task, response.httpRequestId || response.meta?.request_id, deadline, trace)
    } catch (error) {
      if (error instanceof ApiError) error.taskId = taskId
      throw error
    }
  }

  private async collectV5(task: V5Task, requestId: string | undefined, deadline: number, trace: string): Promise<VideoDetail> {
    const taskId = task.task_id
    let delay = this.config.pollInterval ?? 1000
    // 提交接口可能复用已完成/失败的任务，只返回 ID 和状态，不附带结果。
    // 终态摘要需要读取一次详情；若详情仍缺少内容，后续明确报错而不无限重试。
    if ((task.state === 'done' && !task.data) || (task.state === 'failed' && !task.error)) {
      this.log.debug('api.task.fetch_result', { trace, taskId, state: task.state })
      const detail = await this.requestV5<V5Task>(
        `/api/v1/tasks/${encodeURIComponent(taskId)}`, deadline, trace,
      )
      task = detail.data
      requestId = detail.httpRequestId || detail.meta?.request_id
    }
    while (true) {
      this.log.debug('api.task.state', { trace, taskId, state: task.state })
      if (task.state === 'done') {
        if (!task.data) throw new ApiError('INVALID_RESPONSE', 'V5 已完成任务详情未返回内容', requestId)
        return this.normalizeV5(task.data)
      }
      if (task.state === 'failed') {
        const error = this.failure(task.error, requestId)
        error.fromTask = true
        throw error
      }
      if (!['queued', 'running'].includes(task.state)) {
        throw new ApiError('INVALID_RESPONSE', `V5 返回未知任务状态: ${task.state}`)
      }
      await sleep(Math.min(delay, this.remaining(deadline)), undefined, {
        signal: this.controller.signal,
      })
      const polled = await this.requestV5<V5Task>(
        `/api/v1/tasks/${encodeURIComponent(taskId)}`, deadline, trace,
      )
      task = polled.data
      requestId = polled.httpRequestId || polled.meta?.request_id
      delay = Math.min(delay * 2, Math.max(5000, this.config.pollInterval ?? 1000))
    }
  }

  private normalizeV5(content: V5Content): VideoDetail {
    if (!content.media || content.platform !== 'douyin' || !['video', 'image_album'].includes(content.kind)) {
      throw new ApiError('UNSUPPORTED_CONTENT', '该链接不是支持的抖音视频或图集')
    }
    const media = content.media
    const images = (media.images || []).map(image => mediaUrls(image)[0]).filter(Boolean)
    if (content.kind === 'image_album' && !images.length) {
      throw new ApiError('NO_IMAGE_URL', 'V5 未返回图集地址')
    }
    return {
      description: content.description || content.title || '',
      isImage: content.kind === 'image_album',
      images,
      duration: content.duration_ms == null ? undefined : content.duration_ms / 1000,
      cover: (media.covers || []).flatMap(cover => mediaUrls(cover))[0],
      videoUrls: [...new Set([
        ...mediaUrls(media.video),
        ...(media.streams || []).flatMap(stream => mediaUrls(stream)),
      ])],
    }
  }

  private remaining(deadline: number): number {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new ApiError('TASK_TIMEOUT', 'V5 解析任务等待超时，请稍后重试或增加任务等待时间')
    return remaining
  }

  private canRetry(error: ApiError) {
    return error.retryable !== false && RETRYABLE_CODES.has(error.code)
  }

  private async backoff(error: ApiError, attempt: number, deadline: number, trace: string) {
    const delayMs = (error.retryAfter ?? 2 ** attempt) * 1000
    // 等待提示超过总预算时保留原错误及恢复提示，不能提前重试。
    if (delayMs >= this.remaining(deadline)) throw error
    this.log.warn('api.retry', { trace, code: error.code, requestId: error.requestId, taskId: error.taskId, attempt: attempt + 1, delayMs })
    await sleep(delayMs, undefined, { signal: this.controller.signal })
  }

  private rateHints(headers?: Headers) {
    if (!headers || headers.get('X-RateLimit-Remaining') !== '0') return
    const reset = Number(headers.get('X-RateLimit-Reset')) * 1000
    if (Number.isFinite(reset) && reset > Date.now()) this.rateResumeAt = reset
  }

  private failure(error?: V5Failure | null, requestId?: string, headers?: Headers, status?: number) {
    const result = new ApiError(error?.code || 'V5_API_ERROR', error?.message || 'V5 API 请求失败', headers?.get('X-Request-ID') || requestId)
    const retryAfter = error?.retry_after ?? (headers?.has('Retry-After') ? Number(headers.get('Retry-After')) : undefined)
    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) result.retryAfter = retryAfter
    result.retryable = error?.retryable
    result.details = error?.details
    result.status = status
    result.upstreamRequestId = requestId
    return result
  }
}
