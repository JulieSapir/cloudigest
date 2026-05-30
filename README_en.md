<div align="right">
<a title="简体中文" href="README.md"><img src="https://img.shields.io/badge/-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-545759?style=for-the-badge" alt="简体中文"></a>
<a title="English" href="README_en.md"><img src="https://img.shields.io/badge/-English-A31F34?style=for-the-badge" alt="English" /></a>
</div>

# Cloudigest Streaming Hash Calculation Service

This is a lightweight hash calculation service based on Cloudflare Workers/Snippets, driven by HTTP GET requests. It uses Server-Sent Events (SSE) to push intermediate states and final results, enabling streaming and efficient multi‑hash computation for any resource pointed to by a remote URL.  
All algorithms are implemented in a single JavaScript script with zero dependencies, making it suitable for large files, long‑running tasks, and resumable computation scenarios.

## Features

- Uses **SSE** to push processing progress and final hashes
- Specify the target resource via the `url` query parameter
- Deep memory optimization – runs stably even in a 2 MB environment
- Computes three hashes simultaneously in a single pass: `SHA-1`, `SHA-256`, `MD5`
- Sends a progress snapshot every ~1 MB of accumulated data
- Supports resumable computation via `cursor` + `state`
- Automatically discards leading bytes when the origin does not support `Range`
- Final output is lowercase hexadecimal digest

## Request Format

Send a **GET** request to the Workers/Snippets endpoint with the following query parameters:

| Parameter | Required | Description                                                                                                |
| --------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `url`     | Yes      | Target resource URL (must be publicly accessible)                                                          |
| `cursor`  | No       | Starting byte offset, default `0` (process from the beginning of the file)                                 |
| `state`   | No       | Internal state JSON string received from a previous response, used for resuming (URL encoding recommended) |

Example:

```text
https://your-worker.example.com/?url=https://example.com/file.bin&cursor=0
```

> **Note:** When `cursor > 0`, a valid `state` must be provided, otherwise an error is returned.

## Response Format (SSE Stream)

The service responds with `Content-Type: text/event-stream`. Each frame is an SSE event.

### In‑Progress (Progress Snapshot)

Sent approximately every 1 MB of processed data:

```text
data: {"status":"processing","cursor":1048576,"state":{"sha1":{"h":[...],"len":1048576},"sha256":{"h":[...],"len":1048576},"md5":{"h":[...],"len":1048576},"buffer":[...]}}
```

JSON fields:

- `status`: `"processing"`
- `cursor`: Total number of bytes processed so far (including the length recorded in `state`)
- `state`: Internal state object for resuming computation. Contains:
  - `sha1` / `sha256` / `md5`: Internal algorithm state, each containing `h` (array of integers) and `len` (bytes processed)
  - `buffer`: Current unaligned trailing bytes (length < 64)

### Completion

```text
data: {"status":"completed","cursor":1234567,"hashes":{"sha1":"da39a3ee5e...","sha256":"e3b0c44298...","md5":"d41d8cd98f..."}}
```

- Each digest in `hashes` is a lowercase hexadecimal string (SHA‑1: 40 characters, SHA‑256: 64 characters, MD5: 32 characters)

### Error

```text
data: {"error":"Error description"}
```

## `state` Structure

The `state` object is used to restore computation progress and has the following format:

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

- `h` is not the final hash value, but the internal register state of each algorithm.
- `buffer` holds data that has not yet been aligned to a 64‑byte boundary.

> The client must return the complete `state` JSON string as a query parameter; it is recommended to encode it with `encodeURIComponent` first.

## Usage Example (Browser)

### New Task

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

### Resuming Computation

If the connection is interrupted or you need to continue from a certain progress, retrieve the saved `cursor` and `state`:

```js
const savedCursor = localStorage.getItem("hash_cursor");
const savedState = localStorage.getItem("hash_state");

const resumeUrl = new URL("https://your-worker.example.com/");
resumeUrl.searchParams.set("url", "https://example.com/largefile.zip");
resumeUrl.searchParams.set("cursor", savedCursor);
resumeUrl.searchParams.set("state", savedState); // browser automatically encodes it

const eventSource = new EventSource(resumeUrl.toString());
// ... handle events as above
```

## Workflow

1. The client sends a GET request with `url`, `cursor`, and `state`.
2. The Worker makes an HTTP request to the target resource:
   - If `cursor > 0`, it includes the `Range: bytes=${cursor}-` header.
   - If the origin does not support `Range` (returns 200 instead of 206), the Worker automatically discards the first `cursor` bytes before continuing.
3. Data is read streamingly in 64‑byte chunks and fed into all three hash calculators simultaneously.
4. Every ~1 MB of accumulated data, a `processing` snapshot containing the current `cursor` and `state` is sent via SSE.
5. After reading all data, padding is applied, the final digests are generated, and a `completed` event is sent; then the stream is closed.
6. The task finishes and the connection ends automatically. If an error occurs, an `error` event is sent.

## Compatibility Notes

- If the origin supports `Range` and returns `206 Partial Content`, exact resumption is achieved.
- If the origin does not support `Range`, the Worker reads and discards the first `cursor` bytes before continuing; an error is raised if the content is shorter than `cursor`.
- Each request processes one task. The connection is automatically closed after completion – no long‑lived connection is maintained.
