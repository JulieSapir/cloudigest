<div align="right">
<a title="简体中文" href="README.md"><img src="https://img.shields.io/badge/-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-A31F34?style=for-the-badge" alt="简体中文"></a>
<a title="English" href="README_en.md"><img src="https://img.shields.io/badge/-English-545759?style=for-the-badge" alt="English"></a>
</div>

# Cloudigest 流式哈希计算服务

这是一个基于 Cloudflare Workers/Snippets 的轻量哈希计算服务，通过 HTTP GET 请求驱动，利用 Server-Sent Events (SSE) 推送中间状态和最终结果，可对远程 URL 指向的任意资源进行流式、高效的多哈希计算。  
所有算法均在单个JS脚本内实现，零依赖，适合大文件、长时间任务和断点续算场景。

## 特性

- 使用 **SSE** 推送处理进度与最终哈希
- 通过查询参数 `url` 指定待计算资源
- 深度内存优化，2 MB 环境下也能稳定运行
- 一次遍历同时计算三种哈希：`SHA-1`、`SHA-256`、`MD5`
- 每累计约 1 MB 数据推送一次进度快照
- 支持 `cursor` + `state` 断点续算
- 源站不支持 `Range` 时自动丢弃前置字节继续处理
- 最终输出小写十六进制摘要

## 请求格式

向 Workers/Snippets 地址发送 **GET** 请求，携带以下查询参数：

| 参数     | 必填 | 说明                                                                |
| -------- | ---- | ------------------------------------------------------------------- |
| `url`    | 是   | 目标资源地址（需可公开访问）                                        |
| `cursor` | 否   | 起始字节偏移，默认 `0`，表示从文件开头处理                          |
| `state`  | 否   | 上一次收到的内部状态 JSON 字符串，用于断点续算（建议进行 URL 编码） |

示例：

```text
https://your-worker.example.com/?url=https://example.com/file.bin&cursor=0
```

> **注意：** 当 `cursor > 0` 时，必须提供有效的 `state`，否则会返回错误。

## 响应格式（SSE 流）

服务返回 `Content-Type: text/event-stream`，每一帧为一个 SSE 事件。

### 处理中（进度快照）

每处理约 1 MB 数据会发送一次：

```text
data: {"status":"processing","cursor":1048576,"state":{"sha1":{"h":[...],"len":1048576},"sha256":{"h":[...],"len":1048576},"md5":{"h":[...],"len":1048576},"buffer":[...]}}
```

JSON 字段说明：

- `status`：`"processing"`
- `cursor`：当前已处理的总字节数（包含 `state` 中记录的已处理长度）
- `state`：内部状态对象，用于断点续算，包含：
  - `sha1` / `sha256` / `md5`：算法内部状态，各含 `h`（整数数组）和 `len`（已处理字节数）
  - `buffer`：当前未对齐的尾部字节数组（长度 < 64）

### 完成

```text
data: {"status":"completed","cursor":1234567,"hashes":{"sha1":"da39a3ee5e...","sha256":"e3b0c44298...","md5":"d41d8cd98f..."}}
```

- `hashes` 中每个摘要为小写十六进制字符串（sha1 40 位，sha256 64 位，md5 32 位）

### 错误

```text
data: {"error":"错误描述"}
```

## state 结构

`state` 对象用于还原计算进度，格式如下：

```json
{
  "sha1": {
    "h": [1732584193, -271733879, -1732584194, 271733878, -1009589776],
    "len": 0
  },
  "sha256": {
    "h": [1779033703, -1150833019, 1013904242, -1521486534, 1359893119, -1694144372, 528734635, 1541459225],
    "len": 0
  },
  "md5": {
    "h": [1732584193, -271733879, -1732584194, 271733878],
    "len": 0
  },
  "buffer": []
}
```

- `h` 不为最终哈希值，而是算法内部寄存器状态。
- `buffer` 保存尚未对齐到 64 字节边界的数据。

> 客户端需将完整的 `state` JSON 字符串作为查询参数回传；建议先进行 `encodeURIComponent` 编码。

## 使用示例（浏览器端）

### 新任务

```js
const url = "https://example.com/largefile.zip";
const eventSource = new EventSource(`https://your-worker.example.com/?url=${encodeURIComponent(url)}&cursor=0`);

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(data);
  if (data.status === "processing") {
    localStorage.setItem("hash_cursor", data.cursor);
    localStorage.setItem("hash_state", JSON.stringify(data.state));
  } else if (data.status === "completed") {
    console.log("SHA-1  :", data.hashes.sha1);
    console.log("SHA-256:", data.hashes.sha256);
    console.log("MD5    :", data.hashes.md5);
    eventSource.close();
  } else if (data.error) {
    console.error("Error:", data.error);
    eventSource.close();
  }
};

eventSource.onerror = (err) => {
  console.error("SSE error", err);
};
```

### 断点续算

如果连接中断或需要从某个进度继续，取出保存的 `cursor` 和 `state`：

```js
const savedCursor = localStorage.getItem("hash_cursor");
const savedState = localStorage.getItem("hash_state");

const resumeUrl = new URL("https://your-worker.example.com/");
resumeUrl.searchParams.set("url", "https://example.com/largefile.zip");
resumeUrl.searchParams.set("cursor", savedCursor);
resumeUrl.searchParams.set("state", savedState); // 浏览器自动编码

const eventSource = new EventSource(resumeUrl.toString());
// ... 处理事件同上
```

## 工作流程

1. 客户端通过 GET 请求传入 `url`、`cursor`、`state`。
2. Worker 向目标资源发起 HTTP 请求：
   - 若 `cursor > 0`，带上 `Range: bytes=${cursor}-` 头；
   - 若源站不支持 `Range`（返回 200 而非 206），Worker 会自动丢弃前 `cursor` 字节后再继续处理。
3. 以 64 字节块为单位流式读取数据，同时喂入三个哈希计算器。
4. 每累积约 1 MB 数据，通过 SSE 发送一次 `processing` 快照，包含当前 `cursor` 和 `state`。
5. 读取完毕后进行补位，生成最终摘要，发送 `completed` 事件并关闭流。
6. 任务完成，连接自动结束；若发生异常则发送 `error`。

## 兼容性与说明

- 若源站支持 `Range`，返回 `206 Partial Content`，实现精确续传。
- 若源站不支持 `Range`，Worker 会读取并丢弃前 `cursor` 字节，继续处理；若内容不足则会报错。
- 单次请求处理一个任务，完成后自动关闭连接，无长连接保持。
