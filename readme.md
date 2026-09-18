# koishi-plugin-douyin

[![npm](https://img.shields.io/npm/v/koishi-plugin-douyin?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-douyin)

发送抖音分享链接，自动解析并发送视频或图集。需要搭配自部署的 [Douyin_TikTok_Download_API](https://github.com/Evil0ctal/Douyin_TikTok_Download_API)，支持 V5，兼容旧 V4。

## 配置

- `apiHost`：API 服务根地址，不要附加 `/api/v1`。
- `apiVersion`：与服务版本一致；默认 `v4`，使用 V5 时选 `v5`。
- `apiKey`：V5 服务的密钥，需要 `douyin:read` 权限；V4 不需要。
- `maxDuration`：视频时长上限，默认 90 秒，超出只发送预览。
  V5 未返回有效时长时也只发送预览，请打开抖音客户端查看。
- `forward`：合并消息发送，仅支持 OneBot。

V5 解析默认最多等待 120 秒，超时时可增加 `taskTimeout`。旧 V4 用户无需更改配置。

## 日志

在 Koishi 日志中查看。默认 `production`，显示简短中文结果和错误提示；排查问题时切换为 `development`，查看详细过程。关闭 `logEnabled` 可停用插件日志。
