# 大文件 SHA-256 计算器

纯前端：对本地 500MB–2GB（实际支持任意大小）文件分片读取并计算整个文件的
SHA-256。**只读取与哈希，不上传、不解析、不存储。**

## 运行

Worker 通过 `importScripts()` 加载哈希模块，需要用 HTTP 打开（`file://` 下会被
CORS 拦截）：

```bash
# 任选其一
python3 -m http.server 8080
npx serve .
```

然后访问 <http://localhost:8080/index.html>。建议使用 Chromium / Edge（支持
BYOB 读取，内存控制最好）；Firefox/Safari 自动回退到默认 reader 路径。

## 功能

- 分片大小可配置：1 / 2 / 4 / 8 / 16 / 32 / 64 MiB。
- 进度条、百分比、已读字节、实时速度（3 秒滑动窗口）、已用时间、预计剩余时间。
- 暂停 / 继续 / 取消。暂停在分片边界生效（最大延迟 ≈ 一片读取耗时）；
  取消调用 `reader.cancel()` 立即中断在途 IO。
- 计算结果一键复制。
- 文件被删除 / 移动 / 截断 / 设备不可读时给出可读、可恢复的中文提示。
- 主线程健康面板：实时 FPS、`PerformanceObserver` 捕获的长任务次数与最长耗时。

## 架构

```
index.html      UI 结构
styles.css      样式
app.js          主线程：仅 UI。接收 Worker 进度消息，rAF 节流渲染
worker.js       Web Worker：全部读取 + 哈希；暂停/继续/取消控制
lib/sha256.js   零依赖增量 SHA-256（update/digest），兼容浏览器与 Node
test/           Node 正确性与端到端测试
```

### 为什么大文件不用 `crypto.subtle.digest`

Web Crypto 的 `digest()` 只能接收一个**完整的** `ArrayBuffer`，没有增量接口。
对 1–2GB 文件整包传入会产生一次与文件等大的内存拷贝，内存随文件大小线性增长，
违背“内存恒定”的验收标准。因此：

- 大文件（> 16MiB）：Worker 内使用 `lib/sha256.js` 的**增量** SHA-256，
  每读一片 `update()` 一次，内部常驻状态 < 1KB，读取缓冲固定为“一个分片”，
  总常驻内存 ≈ 2 倍分片大小（例如 64MiB 分片约 128MiB），与文件大小无关。
- 小文件（≤ 16MiB）：走 `crypto.subtle.digest` Web Crypto 快速通道
  （仍然在 Worker 中，结果区会标注使用的路径）。

### 读取与内存

- 优先 `file.stream().getReader({ mode: 'byob' })`：每片使用固定大小缓冲，
  严格按 BYOB 语义处理“返回缓冲可能被 detach / done 时带回尾部字节”。
- 不支持 BYOB 时回退默认 reader，并用一块固定大小累积缓冲拼满分片再哈希。
- Worker 进度消息节流为 5Hz；主线程再在 `requestAnimationFrame` 内渲染，
  文本更新最多 10Hz，避免无意义 DOM 写入。

### 技术点对照

| 要求 | 实现 |
| --- | --- |
| File API | `<input type="file">` 选择 `File` 对象 |
| Streams API | `file.stream()` + BYOB / 默认 reader |
| Web Crypto | 小文件 `crypto.subtle.digest('SHA-256', ...)`（Worker 内） |
| Web Worker | 全部 IO 与哈希在 `worker.js`，主线程零计算 |
| PerformanceObserver | 观察 `longtask` 条目，计数并记录最长任务 |
| 暂停/继续 | Worker 状态标志，分片边界轮询，暂停期间不发读取请求 |
| 取消 | 标志位 + `reader.cancel()`，立即停止且无结果产出 |
| 内存控制 | 固定分片缓冲 + 增量哈希，不随文件大小增长 |
| 进度节流 | Worker 200ms 节流上报；主线程 rAF 渲染 |
| 文件删除 | 错误名/消息映射（NotFound / NotReadable / unexpected EOF 等） |

## 测试

```bash
node test/verify.mjs        # 哈希正确性（206 项，含标准向量、长度边界、1MiB 数据）+ 吞吐基准
node test/worker-harness.mjs # 模拟 Worker 环境的端到端测试
```

端到端覆盖：大文件增量哈希正确、暂停期间进度停滞且继续后哈希不变、取消立即
停止且无结果/无错误事件、小文件走 Web Crypto、文件不可读时的友好提示。

本机基准（Node v22）：增量 SHA-256 吞吐约 **230 MiB/s**，纯哈希 1GiB ≈ 4.5s；
浏览器中叠加磁盘读取（现代 NVMe + 系统页缓存通常 1GB/s+），1GB 文件整体预期
在数秒到十几秒量级。

## 与系统命令交叉验证

页面得到的哈希应与系统命令一致：

```bash
shasum -a 256 /path/to/file   # macOS
sha256sum /path/to/file       # Linux
```
