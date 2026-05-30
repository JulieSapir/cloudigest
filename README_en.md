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
