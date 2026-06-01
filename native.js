export default {
  async fetch(request, env, ctx) {
    const requestUrl = new URL(request.url);
    const url = requestUrl.searchParams.get("url");
    if (!url) return jsonError("URL is required", 400);
    const abortController = new AbortController();
    if (request.signal) {
      request.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    }
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const sendRaw = (text) => controller.enqueue(encoder.encode(text));
        const sendComment = (text = "") => sendRaw(`: ${text}\n\n`);
        const sendSSE = (data) => sendRaw(`data: ${JSON.stringify(data)}\n\n`);
        (async () => {
          let writers = [];
          try {
            sendComment("open");
            const upstream = await fetch(url, { signal: abortController.signal });
            if (upstream.status !== 200) {
              sendSSE({ error: `Fetch failed: HTTP ${upstream.status} ${upstream.statusText}` });
              return;
            }
            if (!upstream.body) {
              sendSSE({ error: "Upstream response has no body" });
              return;
            }
            const md5 = new crypto.DigestStream("MD5");
            const sha1 = new crypto.DigestStream("SHA-1");
            const sha256 = new crypto.DigestStream("SHA-256");
            const md5w = md5.getWriter();
            const sha1w = sha1.getWriter();
            const sha256w = sha256.getWriter();
            writers = [md5w, sha1w, sha256w];
            const reader = upstream.body.getReader();
            const HEARTBEAT_INTERVAL = 10 * 1024 * 1024;
            let processed = 0;
            let lastBeat = 0;
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const len = value ? value.byteLength : 0;
              if (!len) continue;
              await Promise.all([md5w.write(value), sha1w.write(value), sha256w.write(value)]);
              processed += len;
              if (processed - lastBeat >= HEARTBEAT_INTERVAL) {
                sendComment("ping");
                lastBeat = processed;
              }
            }
            await Promise.all([md5w.close(), sha1w.close(), sha256w.close()]);
            writers = [];
            const [md5d, sha1d, sha256d] = await Promise.all([md5.digest, sha1.digest, sha256.digest]);
            sendSSE({
              status: "completed",
              size: processed,
              hashes: {
                md5: toHex(md5d),
                sha1: toHex(sha1d),
                sha256: toHex(sha256d),
              },
            });
          } catch (e) {
            for (const w of writers) {
              try {
                await w.abort(e);
              } catch {}
            }
            try {
              sendSSE({ error: e?.message || String(e) });
            } catch {}
          } finally {
            try {
              controller.close();
            } catch {}
          }
        })();
      },
      cancel() {
        abortController.abort();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
};
function jsonError(error, status = 400) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}
