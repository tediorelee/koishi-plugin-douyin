import { Context, Schema, h } from 'koishi'
import { ApiConfig, ApiError, DouyinApi } from './api'
import { Diagnostics, LogConfig, redact } from './logger'

export const name = 'douyin'

export const usage = `
## 解析群聊中抖音链接

考虑到解析速度+请求次数, 更换解析API为"Douyin_TikTok_Download_API"

参考地址：https://github.com/Evil0ctal/Douyin_TikTok_Download_API

默认使用 V4 旧接口。接入 V5 时，请切换 API 版本、填写服务根地址与具有 douyin:read 权限的 API Key。
日志默认使用生产模式，开发模式会增加请求阶段、任务状态、下载耗时与脱敏错误堆栈。

### 使用方法

请在app中复制链接, 然后发送到群聊中即可解析，支持如下链接:

<pre>
2.89 复制打开抖音，看看【海报新闻的作品】对话一夜涨粉8万的00后脑瘫主播“汤米”：自己手抖...
https://v.douyin.com/i5cseJ9a/ 10/23 r@E.uF nQX:/
</pre>
`;

export interface Config extends ApiConfig, LogConfig {
  maxDuration: string,
  forward: boolean
}

export const Config = Schema.object({
  apiHost: Schema.string().default('http://192.168.2.167:16252').description('填写你的API前缀'),
  apiVersion: Schema.union(['v4', 'v5']).default('v4').description('API 版本（默认保留 V4 旧接口）'),
  apiKey: Schema.string().role('secret').default('').description('V5 API Key（需要 douyin:read 权限；V4 不使用）'),
  taskTimeout: Schema.number().min(1).max(600).default(120).description('V5 解析任务最大等待时间（秒）'),
  pollInterval: Schema.number().min(100).max(10000).default(1000).description('V5 任务状态初始轮询间隔（毫秒），等待中逐步放慢'),
  maxDuration: Schema.string().default('90').description('允许下载的最大视频长度(秒)，否则仅发送预览图，避免bot卡住'),
  forward: Schema.boolean().default(false).description('以合并消息发送解析内容（仅支持 OneBot 适配器,其它平台开启不生效）'),
  logEnabled: Schema.boolean().default(true).description('输出插件日志（通过 Koishi 日志系统查看）'),
  logMode: Schema.union(['production', 'development']).default('production').description('生产模式记录结果和异常；开发模式增加请求过程、任务状态和错误堆栈'),
})

export function apply(ctx: Context, config: Config) {

  const log = new Diagnostics(ctx, config)
  const api = new DouyinApi(ctx, config, log)
  let sequence = 0
  log.info('plugin.started', { apiVersion: api.version, logMode: config.logMode || 'production' })

  ctx.middleware(async (session, next) => {
    const urls = session.content?.match(/https?:\/\/[^\s<>"']+/g) || []
    const url = urls.map(value => value.replace(/&amp;/g, '&')).find(value => {
      try {
        const host = new URL(value).hostname
        return host === 'douyin.com' || host.endsWith('.douyin.com')
      } catch {
        return false
      }
    })
    if (!url) return next()
    const trace = String(++sequence)
    const started = Date.now()
    log.debug('parse.start', { trace, apiVersion: api.version, platform: session.platform })

    try {
      const detail = await api.parse(url, trace)
      const isTypeImage = detail.isImage
      log.debug('parse.detail', { trace, isTypeImage, imageCount: detail.images.length, duration: detail.duration })

      // 按发送顺序收集解析内容
      const parts: (string | h)[] = ['抖音解析：\n' + detail.description];

      if (isTypeImage) {
        // 图集：每张图作为一个片段
        for (const item of detail.images) {
          parts.push(h('img', { src: item }));
        }
      } else {
        // 下载视频
        if (detail.duration > Number(config.maxDuration)) {
          // 视频过长，仅发送预览图
          log.info('video.skipped', { trace, duration: detail.duration, maxDuration: config.maxDuration })
          parts.push('视频过长~ 请打开抖音客户端查看');
          if (detail.cover) parts.push(h('img', { src: detail.cover }));
        } else {
          const videoBuffer = await api.download(url, detail, trace)
          parts.push(h.video(videoBuffer, 'video/mp4'));
        }
      }

      if (config.forward && session.platform === 'onebot') {
        // OneBot 下以合并转发消息发送全部内容
        await session.send(h('message', {
          forward: true,
          children: parts.map(part => h('message', part)),
        }));
      } else if (isTypeImage && detail.images.length > 3) {
        // 保留原有行为：图集超过 3 张时合并为转发消息
        await session.send(parts[0]);
        await session.send(h('message', { forward: true, children: parts.slice(1) }));
      } else {
        // 逐条发送
        for (const part of parts) {
          await session.send(part);
        }
      }
      log.info('parse.sent', { trace, apiVersion: api.version, type: isTypeImage ? 'image_album' : 'video', parts: parts.length, elapsedMs: Date.now() - started })
    } catch(err) {
      log.error('parse.failed', err, { trace, apiVersion: api.version, elapsedMs: Date.now() - started })
      if (err instanceof ApiError && err.code === 'V4_PARSE_FAILED') return err.message
      return `发生错误! 请重试; ${redact(String(err), config.apiKey)}`;
    }
  });
}
