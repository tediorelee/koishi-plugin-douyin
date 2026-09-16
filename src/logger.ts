import { Context, Logger } from 'koishi'

export interface LogConfig {
  logEnabled?: boolean
  logMode?: 'production' | 'development'
  apiKey?: string
}

export function redact(text: string, apiKey?: string): string {
  if (apiKey) text = text.split(apiKey).join('[REDACTED]')
  return text
    .replace(/dtk_[a-zA-Z0-9_-]+/g, '[REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/g, (value) => {
      try {
        const url = new URL(value)
        return `${url.origin}${url.pathname}${url.search ? '?[REDACTED]' : ''}`
      } catch {
        return '[URL]'
      }
    })
}

function productionReason(fields: Record<string, unknown>): string {
  const code = String(fields.code || '')
  if (code === 'UNAUTHENTICATED' || fields.status === 401) return 'API 密钥无效或已过期，请检查密钥配置'
  if (code === 'FORBIDDEN' || fields.status === 403) return '权限不足，请检查 API 密钥是否具有抖音读取权限'
  if (code === 'RATE_LIMITED' || fields.status === 429) return '请求过于频繁，请稍后再试'
  if (['QUEUE_FULL', 'IDENTITY_POOL_EXHAUSTED', 'ENDPOINT_CIRCUIT_OPEN', 'INTERNAL', 'DOWNLOADER_UNAVAILABLE'].includes(code)) return '解析服务暂时繁忙或不可用，请稍后再试'
  if (['UPSTREAM_RISK_CONTROL', 'SIGNING_FAILED', 'UPSTREAM_CHANGED'].includes(code)) return '抖音端暂时无法解析，请稍后再试；持续失败时请联系管理员'
  if (code === 'TASK_TIMEOUT') return '解析等待超时，请稍后再试或增加任务等待时间'
  if (code === 'TASK_NOT_FOUND') return '解析任务已过期，请重新发送链接'
  if (code === 'TASK_CANCELLED') return '解析任务已取消，请重新发送链接'
  if (code === 'INVALID_RESPONSE') return '解析服务返回的数据不完整或格式不匹配，请检查 API 版本及服务状态'
  if (['VIDEO_DOWNLOAD_FAILED', 'EMPTY_VIDEO', 'NO_VIDEO_URL', 'NO_MEDIA', 'NO_IMAGE_URL'].includes(code)) return '无法获取媒体文件，请稍后再试并检查网络连接'
  if (['NOT_FOUND', 'CONTENT_NOT_FOUND'].includes(code)) return '作品不存在或已被删除'
  if (['PRIVATE_CONTENT', 'CONTENT_PRIVATE'].includes(code)) return '作品未公开，无法读取'
  if (['V4_PARSE_FAILED', 'INVALID_URL', 'UNSUPPORTED_CONTENT', 'UNSUPPORTED_PLATFORM', 'UNSUPPORTED_TYPE', 'INVALID_PARAMETER', 'INVALID_PARAMS', 'METHOD_NOT_SUPPORTED'].includes(code)) return '链接无效或暂不支持，请发送公开的抖音视频或图集链接'
  if (code === 'NOT_CONFIGURED') return '解析服务尚未配置完成，请联系管理员'
  return '处理未成功，请稍后再试；持续失败时请开启开发日志排查'
}

function productionMessage(event: string, fields: Record<string, unknown>): string | undefined {
  const seconds = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? `${(value / 1000).toFixed(1)} 秒` : '片刻'
  let message: string
  switch (event) {
    case 'plugin.started': message = `抖音解析已启用（${fields.apiVersion === 'v5' ? 'V5' : 'V4'}）`; break
    case 'parse.sent': message = `${fields.type === 'image_album' ? '图集' : '视频'}已发送${typeof fields.elapsedMs === 'number' ? `，耗时 ${seconds(fields.elapsedMs)}` : ''}`; break
    case 'video.skipped': message = `视频超过时长限制（${fields.maxDuration} 秒），仅发送预览`; break
    case 'api.retry': message = `暂时无法解析，${seconds(fields.delayMs)}后自动重试（第 ${fields.attempt} 次）`; break
    case 'api.task.expired': message = '解析任务已过期，正在重新解析'; break
    case 'media.download.mirror_failed': message = '视频下载地址不可用，正在尝试备用地址'; break
    // 生产模式只保留备用地址提示和最终失败，避免同一次下载重复报错。
    case 'media.download.error': return
    case 'parse.failed': message = `解析或发送失败：${productionReason(fields)}`; break
    default: message = '抖音解析运行提示，请开启开发日志查看详情'
  }
  return `${message}${fields.trace ? `（编号 ${fields.trace}）` : ''}`
}

export class Diagnostics {
  private logger: Logger
  private enabled: boolean
  private development: boolean

  constructor(ctx: Context, private config: LogConfig) {
    this.enabled = config.logEnabled !== false
    this.development = config.logMode === 'development'
    this.logger = ctx.logger('douyin').extend(this.development ? 'development' : 'production')
    this.logger.level = this.development ? Logger.DEBUG : Logger.INFO
  }

  info(event: string, fields: Record<string, unknown> = {}) {
    this.write('info', event, fields)
  }

  warn(event: string, fields: Record<string, unknown> = {}) {
    this.write('warn', event, fields)
  }

  debug(event: string, fields: Record<string, unknown> = {}) {
    if (this.development) this.write('debug', event, fields)
  }

  error(event: string, error: unknown, fields: Record<string, unknown> = {}) {
    const detail = error as Error & {
      code?: string; requestId?: string; upstreamRequestId?: string; taskId?: string
      retryAfter?: number; retryable?: boolean; details?: Record<string, unknown>
      status?: number; response?: { status?: number }
    }
    this.write('error', event, {
      ...fields,
      name: detail?.name,
      code: detail?.code,
      requestId: detail?.requestId,
      upstreamRequestId: detail?.upstreamRequestId,
      taskId: detail?.taskId,
      status: detail?.status ?? detail?.response?.status,
      retryAfter: detail?.retryAfter,
      retryable: detail?.retryable,
      details: detail?.details,
      message: detail?.message || String(error),
      ...(this.development ? { stack: detail?.stack } : {}),
    })
  }

  private write(level: 'info' | 'warn' | 'error' | 'debug', event: string, fields: Record<string, unknown>) {
    if (!this.enabled) return
    if (!this.development) {
      const message = productionMessage(event, fields)
      if (message) this.logger[level]('%s', redact(message, this.config.apiKey))
      return
    }
    const data = JSON.stringify(fields, (_key, value) => {
      return typeof value === 'string' ? redact(value, this.config.apiKey) : value
    })
    this.logger[level]('%s %s', event, data)
  }
}
