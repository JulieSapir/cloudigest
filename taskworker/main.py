import asyncio
import json
import logging
import sys
from urllib.parse import urlparse
import websockets

# 设置日志格式，确保坦诚清晰、结果导向的追踪
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("taskworker")


class CloudigestTaskWorker:
    def __init__(self, ws_url: str, target_url: str):
        self.ws_url = ws_url
        self.target_url = target_url
        self.cursor = 0
        self.state = None
        self.final_hashes = None

    async def run(self):
        retries = 0
        max_retries = 10

        while self.final_hashes is None:
            try:
                logger.info(
                    f"Connecting to Cloudigest websocket at {self.ws_url} (cursor={self.cursor})..."
                )
                async with websockets.connect(self.ws_url) as websocket:
                    # 提交计算任务
                    payload = {
                        "url": self.target_url,
                        "cursor": self.cursor,
                        "state": self.state,
                    }
                    await websocket.send(json.dumps(payload))
                    logger.info("Task payload sent successfully. Awaiting progress...")

                    # 循环接收计算进度或结果
                    async for message in websocket:
                        data = json.loads(message)

                        if "error" in data:
                            logger.error(f"Received error from server: {data['error']}")
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
                                f"Unknown message status received: {message}"
                            )

            except (
                websockets.exceptions.ConnectionClosedError,
                websockets.exceptions.ConnectionClosedOK,
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
        print("Usage: python main.py <ws_url> <target_url>")
        sys.exit(1)

    ws_url = sys.argv[1]
    target_url = sys.argv[2]

    # 简单的WebSocket协议兼容性校验
    parsed_ws = urlparse(ws_url)
    if parsed_ws.scheme not in ["ws", "wss"]:
        logger.error("Invalid WebSocket URL scheme. Must be ws:// or wss://")
        sys.exit(1)

    try:
        final_hashes = asyncio.run(CloudigestTaskWorker(ws_url, target_url).run())
        print(f"RESULT_HASH:{json.dumps(final_hashes)}")
    except Exception as e:
        logger.error(f"Task submission failed: {e}")
        sys.exit(2)


if __name__ == "__main__":
    main()
