import asyncio
import codecs
import contextlib
import json
import logging
import sys
from urllib.parse import urlparse, urlencode
import httpx

try:
    from aioquic.asyncio import connect as aioquic_connect
    from aioquic.asyncio.protocol import QuicConnectionProtocol
    from aioquic.h3.connection import H3_ALPN, H3Connection
    from aioquic.h3.events import DataReceived, HeadersReceived
    from aioquic.quic.configuration import QuicConfiguration

    AIOQUIC_AVAILABLE = True
except ImportError:
    AIOQUIC_AVAILABLE = False
    aioquic_connect = None
    QuicConnectionProtocol = object
    H3_ALPN = None
    H3Connection = None
    DataReceived = None
    HeadersReceived = None
    QuicConfiguration = None
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("taskworker")


class ResumableStreamClosed(Exception):
    """
    服务端按策略主动结束 SSE，或者流在已有上下文时自然结束。
    客户端应使用当前 cursor/state 原协议继续重连。
    """

    pass


class SSEParser:
    """
    简单 SSE parser，兼容 HTTP/1.1、HTTP/2、HTTP/3 的 chunk/text 流。
    """

    def __init__(self):
        self._buffer = ""
        self._data_lines = []

    def feed(self, text: str):
        events = []
        self._buffer += text
        while True:
            pos = self._buffer.find("\n")
            if pos == -1:
                break
            line = self._buffer[:pos]
            self._buffer = self._buffer[pos + 1 :]
            if line.endswith("\r"):
                line = line[:-1]
            # 空行表示一个 SSE event 结束
            if line == "":
                if self._data_lines:
                    events.append("\n".join(self._data_lines))
                    self._data_lines.clear()
                continue
            # SSE 注释行，例如 ": keep-alive"
            if line.startswith(":"):
                continue
            if ":" in line:
                field, value = line.split(":", 1)
                if value.startswith(" "):
                    value = value[1:]
            else:
                field, value = line, ""
            if field == "data":
                self._data_lines.append(value)
        return events

    def close(self):
        events = []
        if self._buffer:
            events.extend(self.feed("\n"))
        if self._data_lines:
            events.append("\n".join(self._data_lines))
            self._data_lines.clear()
        return events


def _authority_from_url(parsed):
    host = parsed.hostname or ""
    try:
        host_ascii = host.encode("idna").decode("ascii")
    except UnicodeError:
        host_ascii = host
    # IPv6 authority 需要 []
    if ":" in host_ascii and not host_ascii.startswith("["):
        host_ascii = f"[{host_ascii}]"
    if parsed.port:
        return f"{host_ascii}:{parsed.port}"
    return host_ascii


if AIOQUIC_AVAILABLE:

    class H3SSEClientProtocol(  # pyright: ignore[reportRedeclaration]
        QuicConnectionProtocol  # pyright: ignore[reportGeneralTypeIssues]
    ):
        """
        最小 HTTP/3 SSE client protocol。
        只实现 GET + 流式读取 response data。
        """

        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._http = H3Connection(self._quic)  # pyright: ignore[reportOptionalCall]
            self._stream_queues = {}

        async def get_bytes(self, url: str, headers=None):
            parsed = urlparse(url)
            stream_id = self._quic.get_next_available_stream_id()
            queue = asyncio.Queue()
            self._stream_queues[stream_id] = queue
            path = parsed.path or "/"
            if parsed.query:
                path += "?" + parsed.query
            authority = _authority_from_url(parsed)
            request_headers = [
                (b":method", b"GET"),
                (b":scheme", parsed.scheme.encode("ascii")),
                (b":authority", authority.encode("ascii")),
                (b":path", path.encode("utf-8")),
            ]
            for name, value in (headers or {}).items():
                lower_name = name.lower()
                # HTTP/3 中 Host 使用 :authority
                if lower_name == "host":
                    continue
                request_headers.append(
                    (
                        lower_name.encode("ascii"),
                        str(value).encode("utf-8"),
                    )
                )
            self._http.send_headers(
                stream_id=stream_id,
                headers=request_headers,
                end_stream=True,
            )
            self.transmit()
            got_final_response = False
            try:
                while True:
                    event = await queue.get()
                    if event is None:
                        break
                    if isinstance(event, BaseException):
                        raise event
                    if isinstance(
                        event, HeadersReceived  # pyright: ignore[reportArgumentType]
                    ):
                        header_map = dict(event.headers)
                        raw_status = header_map.get(b":status")
                        if raw_status is not None:
                            status_code = int(raw_status.decode("ascii"))
                            # 忽略 1xx
                            if status_code < 200:
                                continue
                            got_final_response = True
                            if status_code != 200:
                                raise Exception(
                                    f"HTTP/3 connection failed: HTTP {status_code}"
                                )
                            logger.info("Connected via HTTP/3")
                        if event.stream_ended:
                            break
                    elif isinstance(
                        event, DataReceived  # pyright: ignore[reportArgumentType]
                    ):
                        if event.data:
                            yield event.data
                        if event.stream_ended:
                            break
            finally:
                self._stream_queues.pop(stream_id, None)
            if not got_final_response:
                raise Exception("HTTP/3 stream closed before response headers")

        def quic_event_received(self, event):
            for http_event in self._http.handle_event(event):
                stream_id = getattr(http_event, "stream_id", None)
                if stream_id is None:
                    continue
                queue = self._stream_queues.get(stream_id)
                if queue is None:
                    continue
                queue.put_nowait(http_event)
                if getattr(http_event, "stream_ended", False):
                    queue.put_nowait(None)

        def connection_lost(self, exc):
            for queue in list(self._stream_queues.values()):
                if exc is None:
                    queue.put_nowait(
                        ResumableStreamClosed(
                            "HTTP/3 connection closed cleanly by peer"
                        )
                    )
                else:
                    queue.put_nowait(exc)
            super().connection_lost(exc)

else:

    class H3SSEClientProtocol:
        pass


class CloudigestTaskWorker:
    def __init__(
        self,
        sse_url: str,
        target_url: str,
        prefer_http3: bool = True,
        connect_timeout: float = 8.0,
        max_retries: int = 10,
        resumable_reconnect_delay: float = 0.2,
        error_reconnect_delay: float = 1.0,
    ):
        self.sse_url = sse_url
        self.target_url = target_url
        self.cursor = 0
        self.state = None
        self.final_hashes = None
        self.prefer_http3 = prefer_http3
        self.connect_timeout = connect_timeout
        self.max_retries = max_retries
        self.resumable_reconnect_delay = resumable_reconnect_delay
        self.error_reconnect_delay = error_reconnect_delay
        # 首次 HTTP/3 明确不可用后，本次任务内固定降级，避免反复等待 UDP/QUIC 超时
        self._http3_disabled = False

    def _build_request_url(self):
        params = {
            "url": self.target_url,
            "cursor": str(self.cursor),
        }
        if self.state:
            params["state"] = json.dumps(self.state)
        parsed = urlparse(self.sse_url)
        scheme = parsed.scheme
        if scheme not in ["http", "https"]:
            raise Exception(f"Unsupported connection scheme: {scheme}")
        base_url = parsed._replace(
            scheme=scheme,
            query="",
            fragment="",
        ).geturl()
        query_string = urlencode(params)
        request_url = f"{base_url}?{query_string}"
        return request_url, base_url, scheme

    def _handle_sse_data(self, data_str: str) -> bool:
        data_str = data_str.strip()
        if not data_str:
            return False
        data = json.loads(data_str)
        if "error" in data:
            logger.error(f"Received error from server: {data['error']}")
            raise Exception(data["error"])
        status = data.get("status")
        if status == "processing":
            self.cursor = data.get("cursor", self.cursor)
            self.state = data.get("state", self.state)
            sha1_len = (
                self.state.get("sha1", {}).get("len", "N/A") if self.state else "N/A"
            )
            logger.info(f"Progress update: cursor={self.cursor}, len={sha1_len}")
            return False
        if status == "completed":
            self.cursor = data.get("cursor", self.cursor)
            self.final_hashes = data.get("hashes")
            logger.info(
                f"Task completed successfully! "
                f"Cursor={self.cursor}, Hashes={self.final_hashes}"
            )
            return True
        logger.warning(f"Unknown message status received: {data}")
        return False

    async def _consume_sse_http3(self, request_url: str):
        if not AIOQUIC_AVAILABLE:
            raise RuntimeError(
                "HTTP/3 requested but aioquic is not installed. "
                "Install it with: pip install aioquic"
            )
        parsed = urlparse(request_url)
        if parsed.scheme != "https":
            raise RuntimeError("HTTP/3 only supports https URLs")
        host = parsed.hostname
        if not host:
            raise RuntimeError("Invalid HTTP/3 host")
        port = parsed.port or 443
        configuration = QuicConfiguration(
            is_client=True,
            alpn_protocols=H3_ALPN,
        )  # pyright: ignore[reportOptionalCall]
        connection_cm = aioquic_connect(
            host,
            port,
            configuration=configuration,
            create_protocol=H3SSEClientProtocol,
        )  # pyright: ignore[reportOptionalCall]
        protocol = None
        try:
            protocol = await asyncio.wait_for(
                connection_cm.__aenter__(),
                timeout=self.connect_timeout,
            )
            parser = SSEParser()
            decoder = codecs.getincrementaldecoder("utf-8")()
            async for (
                chunk
            ) in protocol.get_bytes(  # pyright: ignore[reportAttributeAccessIssue]
                request_url,
                headers={
                    "accept": "text/event-stream",
                    "cache-control": "no-cache",
                    "user-agent": "cloudigest-taskworker/1.0",
                },
            ):
                text = decoder.decode(chunk)
                for data_str in parser.feed(text):
                    if self._handle_sse_data(data_str):
                        return
            tail = decoder.decode(b"", final=True)
            for data_str in parser.feed(tail):
                if self._handle_sse_data(data_str):
                    return
            for data_str in parser.close():
                if self._handle_sse_data(data_str):
                    return
            if self.final_hashes is None:
                raise ResumableStreamClosed(
                    f"HTTP/3 SSE stream ended before completed "
                    f"(cursor={self.cursor})"
                )
        finally:
            if protocol is not None:
                with contextlib.suppress(Exception):
                    await connection_cm.__aexit__(None, None, None)

    async def _consume_sse_httpx(self, request_url: str, http2: bool):
        timeout = httpx.Timeout(
            connect=self.connect_timeout,
            read=None,
            write=self.connect_timeout,
            pool=self.connect_timeout,
        )
        parser = SSEParser()
        async with httpx.AsyncClient(
            timeout=timeout,
            http2=http2,
            headers={
                "accept": "text/event-stream",
                "cache-control": "no-cache",
                "user-agent": "cloudigest-taskworker/1.0",
            },
        ) as client:
            async with client.stream("GET", request_url) as response:
                if response.status_code != 200:
                    logger.error(f"HTTP connection failed: HTTP {response.status_code}")
                    raise Exception(
                        f"HTTP connection failed: HTTP {response.status_code}"
                    )
                mode = "HTTP/2 preferred" if http2 else "HTTP/1.1 forced"
                logger.info(f"Connected via {response.http_version} ({mode})")
                async for text in response.aiter_text():
                    for data_str in parser.feed(text):
                        if self._handle_sse_data(data_str):
                            return
        for data_str in parser.close():
            if self._handle_sse_data(data_str):
                return
        if self.final_hashes is None:
            raise ResumableStreamClosed(
                f"SSE stream ended before completed " f"(cursor={self.cursor})"
            )

    async def _consume_sse_httpx_auto(self):
        """
        HTTP/2 -> HTTP/1.1 自动降级。
        httpx 在 http2=True 时会通过 ALPN 自动协商：
        - 服务端支持 h2：使用 HTTP/2
        - 服务端不支持 h2：使用 HTTP/1.1
        注意：每次 fallback 前都会重建 URL，确保 cursor/state 最新。
        """
        request_url, _, _ = self._build_request_url()
        try:
            await self._consume_sse_httpx(request_url, http2=True)
        except ImportError as e:
            logger.warning(
                f"HTTP/2 support is not installed: {e}. "
                f"Downgrading to HTTP/1.1. "
                f"Install with: pip install 'httpx[http2]'"
            )
            request_url, _, _ = self._build_request_url()
            await self._consume_sse_httpx(request_url, http2=False)
        except httpx.RemoteProtocolError as e:
            logger.warning(
                f"HTTP protocol error with HTTP/2 preferred mode: {e}. "
                f"Retrying with forced HTTP/1.1..."
            )
            request_url, _, _ = self._build_request_url()
            await self._consume_sse_httpx(request_url, http2=False)

    async def _consume_once(self, request_url: str, scheme: str):
        """
        协议自动升降级：
        HTTPS:
            HTTP/3 -> HTTP/2 -> HTTP/1.1
        HTTP:
            HTTP/2 if possible -> HTTP/1.1
        注意：
        - HTTP/3 定时/干净断开属于可恢复断流，不降级。
        - 只有 HTTP/3 在没有任何进度前失败，才认为当前环境 H3 不可用。
        """
        if self.prefer_http3 and scheme == "https" and not self._http3_disabled:
            if AIOQUIC_AVAILABLE:
                http3_start_cursor = self.cursor
                try:
                    logger.info("Trying HTTP/3 first...")
                    await self._consume_sse_http3(request_url)
                    return
                except ResumableStreamClosed:
                    # 服务端定时滚动断开 / 干净 EOF，不降级
                    raise
                except Exception as e:
                    if self.final_hashes is not None:
                        return
                    # 已经取得进度，则视为可恢复中断，不立即降级
                    if self.cursor > http3_start_cursor:
                        raise ResumableStreamClosed(
                            f"HTTP/3 interrupted after progress: {e}"
                        ) from e
                    # 没有任何进度前失败，才认为 HTTP/3 不可用
                    self._http3_disabled = True
                    logger.warning(
                        f"HTTP/3 unavailable before progress: {e}. "
                        f"Downgrading to HTTP/2/HTTP/1.1..."
                    )
            else:
                self._http3_disabled = True
                logger.info(
                    "HTTP/3 skipped because aioquic is not installed. "
                    "Install with: pip install aioquic"
                )
        await self._consume_sse_httpx_auto()

    async def run(self):
        retries = 0
        while self.final_hashes is None:
            start_cursor = self.cursor
            try:
                request_url, base_url, scheme = self._build_request_url()
                logger.info(
                    f"Connecting to Cloudigest SSE at {base_url} "
                    f"(cursor={self.cursor})..."
                )
                await self._consume_once(request_url, scheme)
                retries = 0
            except ResumableStreamClosed as e:
                logger.info(
                    f"SSE stream closed normally/resumably at "
                    f"cursor={self.cursor}. "
                    f"Reconnecting with current cursor/state... ({e})"
                )
                retries = 0
                await asyncio.sleep(self.resumable_reconnect_delay)
                continue
            except Exception as e:
                made_progress = self.cursor > start_cursor
                if made_progress:
                    retries = 0
                    logger.warning(
                        f"Connection interrupted after progress "
                        f"({start_cursor} -> {self.cursor}): {e}. "
                        f"Resuming shortly..."
                    )
                else:
                    retries += 1
                    logger.warning(
                        f"Connection lost or task interrupted: {e}. "
                        f"Reconnecting shortly..."
                    )
                    if retries > self.max_retries:
                        logger.error("Max retries exceeded. Exiting.")
                        raise
                await asyncio.sleep(self.error_reconnect_delay)
        return self.final_hashes


def main():
    if len(sys.argv) < 3:
        print("Usage: python main.py <sse_url> <target_url>")
        sys.exit(1)
    sse_url = sys.argv[1]
    target_url = sys.argv[2]
    parsed_sse = urlparse(sse_url)
    if parsed_sse.scheme not in ["http", "https"]:
        logger.error("Invalid URL scheme. Must be http:// or https://")
        sys.exit(1)
    try:
        final_hashes = asyncio.run(
            CloudigestTaskWorker(
                sse_url=sse_url,
                target_url=target_url,
                prefer_http3=True,
            ).run()
        )
        print(f"RESULT_HASH:{json.dumps(final_hashes)}")
    except Exception as e:
        logger.error(f"Task submission failed: {e}")
        sys.exit(2)


if __name__ == "__main__":
    main()
