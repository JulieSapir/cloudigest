export default {
  async fetch(request, env, ctx) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    const [client, server] = new WebSocketPair();
    server.accept();
    server.addEventListener("message", async (msg) => {
      try {
        const data = JSON.parse(msg.data);
        const { url, cursor = 0, state = null } = data;
        if (!url) {
          server.send(JSON.stringify({ error: "URL is required" }));
          return;
        }
        // 发起单次请求，获取资源流
        const response = await fetch(url, {
          headers: {
            Range: `bytes=${cursor}-`,
          },
        });
        if (!response.ok && response.status !== 206) {
          server.send(JSON.stringify({ error: `Fetch failed: ${response.statusText}` }));
          return;
        }
        const reader = response.body.getReader();
        let currentCursor = cursor;
        let sha1State = state || {
          h: [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0],
          len: 0,
          buffer: [], // 用于处理不完整块
        };
        const CHUNK_SIZE = 1024 * 1024; // 1MB 推送一次
        let pendingBuffer = new Uint8Array(sha1State.buffer || []);
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // 合并新数据
          let combined = new Uint8Array(pendingBuffer.length + value.length);
          combined.set(pendingBuffer);
          combined.set(value, pendingBuffer.length);
          let offset = 0;
          while (offset + 64 <= combined.length) {
            // 处理 64 字节的块
            processBlock(combined.subarray(offset, offset + 64), sha1State);
            offset += 64;
            currentCursor += 64;
            sha1State.len += 64;
            // 每达到 1MB 发送一次快照
            if (currentCursor % CHUNK_SIZE === 0) {
              server.send(
                JSON.stringify({
                  status: "processing",
                  cursor: currentCursor,
                  state: {
                    h: Array.from(sha1State.h),
                    len: sha1State.len,
                    // 不传 buffer 因为我们正好在 64 字节边界
                  },
                }),
              );
            }
          }
          pendingBuffer = combined.subarray(offset);
        }
        // 完成计算：处理最后的 padding
        const finalHash = finalizeSHA1(pendingBuffer, sha1State);
        server.send(
          JSON.stringify({
            status: "completed",
            cursor: currentCursor + pendingBuffer.length,
            hash: finalHash,
          }),
        );
        server.close();
      } catch (e) {
        server.send(JSON.stringify({ error: e.message }));
        server.close();
      }
    });
    return new Response(null, { status: 101, webSocket: client });
  },
};
// SHA-1 核心逻辑实现
function processBlock(block, state) {
  const w = new Uint32Array(80);
  for (let i = 0; i < 16; i++) {
    w[i] = (block[i * 4] << 24) | (block[i * 4 + 1] << 16) | (block[i * 4 + 2] << 8) | block[i * 4 + 3];
  }
  for (let i = 16; i < 80; i++) {
    w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
  }
  let [a, b, c, d, e] = state.h;
  for (let i = 0; i < 80; i++) {
    let f, k;
    if (i < 20) {
      f = (b & c) | (~b & d);
      k = 0x5a827999;
    } else if (i < 40) {
      f = b ^ c ^ d;
      k = 0x6ed9eba1;
    } else if (i < 60) {
      f = (b & c) | (b & d) | (c & d);
      k = 0x8f1bbcdc;
    } else {
      f = b ^ c ^ d;
      k = 0xca62c1d6;
    }
    const temp = (rotl(a, 5) + f + e + k + w[i]) | 0;
    e = d;
    d = c;
    c = rotl(b, 30);
    b = a;
    a = temp;
  }
  state.h[0] = (state.h[0] + a) | 0;
  state.h[1] = (state.h[1] + b) | 0;
  state.h[2] = (state.h[2] + c) | 0;
  state.h[3] = (state.h[3] + d) | 0;
  state.h[4] = (state.h[4] + e) | 0;
}
function rotl(n, b) {
  return (n << b) | (n >>> (32 - b));
}
function finalizeSHA1(tail, state) {
  const totalBits = (state.len + tail.length) * 8;
  const paddingNeeded = 64 - ((tail.length + 9) % 64);
  const padded = new Uint8Array(tail.length + 1 + (paddingNeeded === 64 ? 0 : paddingNeeded) + 8);
  padded.set(tail);
  padded[tail.length] = 0x80;
  // 注入长度信息 (64-bit big endian)
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, totalBits & 0xffffffff);
  view.setUint32(padded.length - 8, (totalBits / 0x100000000) >>> 0);
  for (let i = 0; i < padded.length; i += 64) {
    processBlock(padded.subarray(i, i + 64), state);
  }
  return Array.from(state.h)
    .map((x) => (x >>> 0).toString(16).padStart(8, "0"))
    .join("");
}
