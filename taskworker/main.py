import asyncio
import json
import logging
import sys
from urllib.parse import urlparse, urlencode, quote
import httpx

# 设置日志格式，确保坦诚清晰、结果导向的追踪
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("taskworker")


class CloudigestTaskWorker:
    def __init__(self, sse_url: str, target_url: str):
        self.sse_url = sse_url
        self.target_url = target_url
        self.cursor = 0
        self.state = None
        self.final_hashes = None

    async def run(self):
        retries = 0
        max_retries = 10

        while self.final_hashes is None:
            try:
                # 构造 SSE 查询 URL
                params = {
                    "url": self.target_url,
                    "cursor": str(self.cursor),
                }
                if self.state:
                    params["state"] = json.dumps(self.state)

                # 将 WebSocket 链接协议(ws/wss)自动转换为 HTTP 链接协议(http/https)
                parsed = urlparse(self.sse_url)
                scheme = parsed.scheme
                if scheme == "ws":
                    scheme = "http"
                elif scheme == "wss":
                    scheme = "https"

                # 如果传入的就是 http 或 https 协议，则保持原样
                if scheme not in ["http", "https"]:
                    logger.error(f"Unsupported connection scheme: {scheme}")
                    raise Exception(f"Unsupported connection scheme: {scheme}")

                # 重新组合 URL 并拼接 query parameters
                base_url = parsed._replace(scheme=scheme).geturl().split("?")[0]
                query_string = urlencode(params)
                request_url = f"{base_url}?{query_string}"

                logger.info(
                    f"Connecting to Cloudigest SSE at {base_url} (cursor={self.cursor})..."
                )

                # 使用 httpx 客户端进行异步 SSE 数据流式读取
                async with httpx.AsyncClient(timeout=None) as client:
                    async with client.stream("GET", request_url) as response:
                        if response.status_code != 200:
                            logger.error(
                                f"HTTP connection failed: HTTP {response.status_code}"
                            )
                            raise Exception(
                                f"HTTP connection failed: HTTP {response.status_code}"
                            )

                        async for line in response.aiter_lines():
                            # 按照 SSE 协议解析 "data: <json>"
                            if line.startswith("data: "):
                                data_str = line[len("data: ") :].strip()
                                data = json.loads(data_str)

                                if "error" in data:
                                    logger.error(
                                        f"Received error from server: {data['error']}"
                                    )
                                    raise Exception(data["error"])

                                status = data.get("status")
                                if status == "processing":
                                    self.cursor = data.get("cursor", self.cursor)
                                    self.state = data.get("state", self.state)
                                    sha1_len = (
                                        self.state.get("sha1", {}).get("len", "N/A")
                                        if self.state
                                        else "N/A"
                                    )
                                    logger.info(
                                        f"Progress update: cursor={self.cursor}, len={sha1_len}"
                                    )
                                elif status == "completed":
                                    self.cursor = data.get("cursor", self.cursor)
                                    self.final_hashes = data.get("hashes")
                                    logger.info(
                                        f"Task completed successfully! Cursor={self.cursor}, Hashes={self.final_hashes}"
                                    )
                                    break
                                else:
                                    logger.warning(
                                        f"Unknown message status received: {line}"
                                    )

            except (
                httpx.HTTPError,
                ConnectionRefusedError,
                OSError,
                Exception,
            ) as e:
                logger.warning(
                    f"Connection lost or task interrupted: {e}. Reconnecting shortly..."
                )
                retries += 1
                if retries > max_retries:
                    logger.error("Max retries exceeded. Exiting.")
                    raise e
                await asyncio.sleep(1)  # 避让重连

        return self.final_hashes


def main():
    if len(sys.argv) < 3:
        print("Usage: python main.py <sse_url> <target_url>")
        sys.exit(1)

    sse_url = sys.argv[1]
    target_url = sys.argv[2]

    # 简单的SSE协议兼容性校验
    parsed_sse = urlparse(sse_url)
    if parsed_sse.scheme not in ["http", "https", "ws", "wss"]:
        logger.error("Invalid URL scheme. Must be http://, https://, ws:// or wss://")
        sys.exit(1)

    try:
        final_hashes = asyncio.run(CloudigestTaskWorker(sse_url, target_url).run())
        print(f"RESULT_HASH:{json.dumps(final_hashes)}")
    except Exception as e:
        logger.error(f"Task submission failed: {e}")
        sys.exit(2)


if __name__ == "__main__":
    main()
