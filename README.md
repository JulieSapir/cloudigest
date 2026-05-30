# Cloudigest 流式哈希计算服务

这是一个基于 Cloudflare Workers/Snippets 的 WebSocket 工具，可对远程 URL 指向的任意二进制或文本资源进行流式读取，并同时计算 `SHA-1`、`SHA-256`、`MD5`。
所有算法均在脚本内实现，适合大文件、长耗时任务和断点续算场景。

## 特性

- 支持 WebSocket 连接
- 通过 `url` 指定待计算资源
- 按 64 字节块流式处理，低内存优势
- 一次遍历同时计算三种哈希：`SHA-1`、`SHA-256`、`MD5`
- 每累计约 1MB 数据推送一次进度快照
- 支持通过 `cursor + state` 进行断点续算
- 源站不支持 `Range` 时可自动丢弃前置字节继续处理
- 最终输出小写十六进制摘要

## 请求格式

客户端需要通过 WebSocket 发送**文本 JSON**消息：

```json
{
  "url": "https://example.com/file.bin",
  "cursor": 0,
  "state": null
}
```

### 字段说明

- `url`：必填，目标资源地址
- `cursor`：可选，默认 `0`，表示从哪个字节偏移继续处理
- `state`：可选，上一轮返回的内部状态，用于断点续算

### `state` 结构

`state` 为服务端返回的内部快照，建议原样保存并原样回传：

```json
{
  "sha1": { "h": [int, int, int, int, int], "len": 0 },
  "sha256": { "h": [int, int, int, int, int, int, int, int], "len": 0 },
  "md5": { "h": [int, int, int, int], "len": 0 }
}
```

> 注意：`h` 不是最终哈希值，而是算法内部状态。

## 响应格式

### 处理中

每处理约 1MB 数据，会返回一次快照：

```json
{
  "status": "processing",
  "cursor": 1048576,
  "state": {
    "sha1": { "h": [int, int, int, int, int], "len": 1048576 },
    "sha256": { "h": [int, int, int, int, int, int, int, int], "len": 1048576 },
    "md5": { "h": [int, int, int, int], "len": 1048576 }
  }
}
```

### 完成

```json
{
  "status": "completed",
  "cursor": 1234567,
  "hashes": {
    "sha1": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "sha256": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "md5": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  }
}
```

### 错误

```json
{
  "error": "..."
}
```

## 使用示例

下面是一个浏览器端示例：

```js
const ws = new WebSocket("wss://your-worker-snippet.example.com");

ws.onopen = () => {
  ws.send(
    JSON.stringify({
      url: "https://example.com/file.zip",
      cursor: 0,
      state: null,
    }),
  );
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(data);
  if (data.status === "processing") {
    localStorage.setItem("hash_cursor", String(data.cursor));
    localStorage.setItem("hash_state", JSON.stringify(data.state));
  }
  if (data.status === "completed") {
    console.log("SHA-1  :", data.hashes.sha1);
    console.log("SHA-256:", data.hashes.sha256);
    console.log("MD5    :", data.hashes.md5);
  }
};

ws.onerror = console.error;
```

## 断点续算

如果连接中断，可以把上一次保存的 `cursor` 和 `state` 重新发给服务端：

```json
{
  "url": "https://example.com/file.zip",
  "cursor": 1048576,
  "state": { "...": "..." }
}
```

## 工作流程

1. 客户端发送目标 URL。
2. Worker 使用 `Range: bytes=${cursor}-` 请求远程资源。
3. 数据以 64 字节块分别进入 SHA-1 / SHA-256 / MD5 计算器。
4. 每累计约 1MB 发送一次进度快照。
5. 读取结束后进行 padding 并输出最终摘要。
6. 发送完成结果后关闭 WebSocket。

## 兼容性与说明

- 如果源站支持 `Range`，通常会返回 `206 Partial Content`。
- 如果源站不支持 `Range`，Worker 会自动读取并丢弃前 `cursor` 字节，再继续处理。
- 如果源站内容不足以跳过到指定 `cursor`，会返回错误。
- 返回的摘要均为**小写十六进制字符串**。
- `sha1` 结果长度为 40 位，`sha256` 为 64 位，`md5` 为 32 位。
- 该实现基于 Cloudflare Workers 的 `fetch`、`WebSocketPair` 和标准 Web API，无需额外依赖。
- 单个连接通常只处理一个任务，完成后会自动关闭连接。
