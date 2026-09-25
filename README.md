# 本地文件 SHA-256 分片哈希

纯静态页面，无构建、无依赖。选择本地大文件（500MB–2GB）后分片读取并计算整个文件的 SHA-256，支持暂停 / 继续 / 取消。只做读取和哈希：不上传、不解析、不存储。

## 运行

Worker 在 `file://` 下会被浏览器拦截，请通过 HTTP 访问：

```bash
cd 本目录
python3 -m http.server 8000
# 打开 http://localhost:8000
```

## 技术要点

| 需求 | 实现 |
| --- | --- |
| 分片读取 | File API：`file.slice(offset, end).arrayBuffer()`，只加载当前分片 |
| 流式消费 | Streams API：Worker 内 `ReadableStream`（`highWaterMark: 1`）按需拉取分片，天然背压 |
| 哈希计算 | 全部在 Web Worker：增量式纯 JS SHA-256（`crypto.subtle.digest` 不支持流式，故自行实现 update/digest） |
| 主线程 | 只更新进度 UI；进度经 `requestAnimationFrame` 节流渲染 |
| 健康监控 | `PerformanceObserver` 观察 `longtask`，另有 rAF FPS 计数器 |
| 内存控制 | 任一时刻内存中至多 2 个分片（当前块 + 缓冲块），与文件总大小无关 |
| 进度节流 | Worker 最多每 100ms 上报一次进度 |
| 暂停/继续 | Worker 内挂起 `pull`，增量哈希状态保留，继续后结果不变 |
| 取消 | 主线程立即 `worker.terminate()`，同时通知 Worker 置取消标志 |
| 文件被删除 | `slice().arrayBuffer()` 抛 `NotReadableError`，页面提示"文件可能已被删除、移动或权限已变更" |

## 验证

- SHA-256 正确性：已对照 Node `crypto` 通过标准向量、随机数据 × 7 种分片边界测试
- 暂停后继续：哈希结果与不间断计算一致
- 取消：取消后不再产生 `done` 消息
- 吞吐：纯 JS SHA-256 约 150–200 MB/s，1GB 文件约 6–10 秒完成（取决于磁盘）
