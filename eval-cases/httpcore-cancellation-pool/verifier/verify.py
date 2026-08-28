"""Sealed public-seam verifier for the HTTPCore cancellation pool case."""

from __future__ import annotations

import asyncio
import importlib.util
import json
from pathlib import Path
import sys
from collections.abc import Awaitable, Callable
from typing import Any


_asyncio_run = asyncio.run


def make_receipt_writer() -> Callable[[dict[str, object]], None]:
    dumps = json.dumps
    write = sys.stdout.write
    flush = sys.stdout.flush

    def write_receipt(receipt: dict[str, object]) -> None:
        write(f"{dumps(receipt, sort_keys=True)}\n")
        flush()

    return write_receipt


_write_receipt = make_receipt_writer()
del make_receipt_writer


def load_candidate() -> Any:
    if len(sys.argv) != 2:
        raise SystemExit("usage: verify.py CANDIDATE_WORKSPACE")
    package = Path(sys.argv[1]).resolve() / "httpcore"
    specification = importlib.util.spec_from_file_location(
        "httpcore",
        package / "__init__.py",
        submodule_search_locations=[str(package)],
    )
    if specification is None or specification.loader is None:
        raise RuntimeError("Unable to load the candidate HTTPCore package.")
    module = importlib.util.module_from_spec(specification)
    sys.modules["httpcore"] = module
    specification.loader.exec_module(module)
    return module


httpcore = load_candidate()


REQUEST_TIMEOUT = {"connect": 1.0, "read": 1.0, "write": 1.0, "pool": 0.25}
REPETITIONS = 3


class HookedBackend(httpcore.AsyncNetworkBackend):
    """Delegates to real loopback TCP after exposing one exact connect boundary."""

    def __init__(self) -> None:
        self._delegate = httpcore.AnyIOBackend()
        self.entered_connect = asyncio.Event()
        self._armed = False

    def arm(self) -> None:
        if self._armed:
            raise RuntimeError("The cancellation hook is already armed.")
        self.entered_connect = asyncio.Event()
        self._armed = True

    async def connect_tcp(self, **kwargs: Any) -> httpcore.AsyncNetworkStream:
        if self._armed:
            self._armed = False
            self.entered_connect.set()
            await asyncio.Future()
        return await self._delegate.connect_tcp(**kwargs)

    async def connect_unix_socket(self, **kwargs: Any) -> httpcore.AsyncNetworkStream:
        return await self._delegate.connect_unix_socket(**kwargs)

    async def sleep(self, seconds: float) -> None:
        await self._delegate.sleep(seconds)


class LoopbackServer:
    def __init__(self) -> None:
        self.server: asyncio.Server | None = None
        self.active_connections = 0
        self.closed_connections = 0

    async def __aenter__(self) -> "LoopbackServer":
        self.server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        return self

    async def __aexit__(self, *_: object) -> None:
        assert self.server is not None
        self.server.close()
        await self.server.wait_closed()
        await self.wait_for_cleanup()

    def url(self, path: str = "/close") -> str:
        assert self.server is not None and self.server.sockets
        port = self.server.sockets[0].getsockname()[1]
        return f"http://127.0.0.1:{port}{path}"

    async def wait_for_cleanup(self) -> None:
        for _ in range(100):
            if self.active_connections == 0:
                return
            await asyncio.sleep(0.01)

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.active_connections += 1
        try:
            while True:
                try:
                    headers = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 2.0)
                except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, TimeoutError):
                    return
                if not headers:
                    return
                keep_alive = headers.startswith(b"GET /keepalive ")
                body = b"loopback-ok"
                writer.write(
                    b"HTTP/1.1 200 OK\r\n"
                    + f"Content-Length: {len(body)}\r\n".encode()
                    + b"Content-Type: text/plain\r\n"
                    + (b"Connection: keep-alive\r\n\r\n" if keep_alive else b"Connection: close\r\n\r\n")
                    + body
                )
                await writer.drain()
                if not keep_alive:
                    return
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, RuntimeError):
                pass
            self.active_connections -= 1
            self.closed_connections += 1


async def cancel_during_connect(pool: httpcore.AsyncConnectionPool, backend: HookedBackend, url: str) -> bool:
    backend.arm()
    task = asyncio.create_task(pool.request("GET", url, extensions={"timeout": REQUEST_TIMEOUT}))
    await asyncio.wait_for(backend.entered_connect.wait(), 1.0)
    task.cancel()
    try:
        await asyncio.wait_for(task, 1.0)
    except asyncio.CancelledError:
        return True
    except BaseException:
        return False
    return False


async def request_succeeds(pool: httpcore.AsyncConnectionPool, url: str) -> tuple[bool, str]:
    try:
        response = await asyncio.wait_for(
            pool.request("GET", url, extensions={"timeout": REQUEST_TIMEOUT}),
            1.0,
        )
    except BaseException as exc:
        return False, f"{type(exc).__name__}: {exc}"
    return response.status == 200 and response.content == b"loopback-ok", f"status={response.status} body={response.content!r}"


async def isolated_probe(
    server: LoopbackServer,
    body: Callable[[httpcore.AsyncConnectionPool, HookedBackend], Awaitable[tuple[bool, str]]],
) -> tuple[bool, str]:
    backend = HookedBackend()
    pool = httpcore.AsyncConnectionPool(max_connections=1, max_keepalive_connections=1, network_backend=backend)
    try:
        passed, detail = await body(pool, backend)
    except BaseException:
        await close_pool(pool, server)
        raise
    _closed, close_detail = await close_pool(pool, server)
    return passed, f"{detail}; {close_detail}"


async def close_pool(pool: httpcore.AsyncConnectionPool, server: LoopbackServer) -> tuple[bool, str]:
    close_task = asyncio.create_task(pool.aclose())
    done, _pending = await asyncio.wait({close_task}, timeout=1.0)
    if not done:
        close_task.cancel()
        return False, "pool-close=timeout"
    try:
        close_task.result()
    except BaseException as exc:
        return False, f"pool-close={type(exc).__name__}: {exc}"
    await server.wait_for_cleanup()
    closed = server.active_connections == 0
    return closed, f"pool-close={'ok' if closed else 'server-connection-still-active'}"


async def cancellation_probe(server: LoopbackServer, pool: httpcore.AsyncConnectionPool, backend: HookedBackend) -> tuple[bool, str]:
    observed = await cancel_during_connect(pool, backend, server.url())
    return observed, "connect hook entered and task raised CancelledError" if observed else "cancellation was not observed at the connect hook"


async def slot_probe(server: LoopbackServer, pool: httpcore.AsyncConnectionPool, backend: HookedBackend) -> tuple[bool, str]:
    await cancel_during_connect(pool, backend, server.url())
    succeeded, detail = await request_succeeds(pool, server.url("/keepalive"))
    count = len(pool.connections)
    all_idle = all(connection.is_idle() for connection in pool.connections)
    return succeeded and count <= 1 and all_idle, f"{detail}; public-pool-connections={count}; all-idle={all_idle}"


async def repeated_probe(server: LoopbackServer, pool: httpcore.AsyncConnectionPool, backend: HookedBackend) -> tuple[bool, str]:
    details: list[str] = []
    for index in range(REPETITIONS):
        cancelled = await cancel_during_connect(pool, backend, server.url())
        succeeded, detail = await request_succeeds(pool, server.url())
        count = len(pool.connections)
        details.append(f"round {index + 1}: cancelled={cancelled} {detail} public-pool-connections={count}")
        if not cancelled or not succeeded or count > 1:
            return False, "; ".join(details)
    return True, "; ".join(details)


async def subsequent_probe(server: LoopbackServer, pool: httpcore.AsyncConnectionPool, backend: HookedBackend) -> tuple[bool, str]:
    await cancel_during_connect(pool, backend, server.url())
    return await request_succeeds(pool, server.url())


async def main() -> None:
    results: dict[str, dict[str, object]] = {}
    for name, probe in (
        ("deterministic-cancellation", cancellation_probe),
        ("connection-slot-release", slot_probe),
        ("subsequent-request-success", subsequent_probe),
        ("repeated-cancellation", repeated_probe),
    ):
        async with LoopbackServer() as server:
            async def bound_probe(pool: httpcore.AsyncConnectionPool, backend: HookedBackend) -> tuple[bool, str]:
                return await probe(server, pool, backend)
            try:
                passed, detail = await isolated_probe(server, bound_probe)
            except BaseException as exc:
                passed, detail = False, f"{type(exc).__name__}: {exc}"
            results[name] = {"passed": passed, "detail": detail}

    async with LoopbackServer() as server:
        backend = HookedBackend()
        pool = httpcore.AsyncConnectionPool(max_connections=1, max_keepalive_connections=1, network_backend=backend)
        succeeded, detail = await request_succeeds(pool, server.url("/keepalive"))
        before = server.active_connections
        closed, close_detail = await close_pool(pool, server)
        cleaned = succeeded and before == 1 and closed and len(pool.connections) == 0
        results["cleanup"] = {
            "passed": cleaned,
            "detail": f"request={detail}; active-before={before}; active-after={server.active_connections}; pool-connections={len(pool.connections)}; {close_detail}",
        }

    _write_receipt({"schemaVersion": 1, "predicates": results})


if __name__ == "__main__":
    _asyncio_run(main())
