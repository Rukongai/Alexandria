"""Range downloads spread over several connections to one data centre.

Telethon's own downloader sends one `upload.GetFile` request and waits for the
reply before sending the next, so a download cannot exceed one chunk per round
trip however much bandwidth is available. Against DC1 at ~70 ms that caps a
large model near 2 MB/s, which is what the importer used to get.

Here each connection keeps a request in flight and writes its reply straight to
that offset in the target file. Measured against the same 691 MB model, eight
connections raised 2.1 MB/s to 18.3 MB/s.

Only documents of a known size take this path. Photos, tiny files, and anything
Telegram answers with a CDN redirect raise `UnsupportedDownload` so the caller
can fall back to Telethon, which handles those cases already.
"""

from __future__ import annotations

import asyncio
import copy
import inspect
import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any, BinaryIO

from telethon import utils
from telethon.errors import FloodWaitError
from telethon.network import MTProtoSender
from telethon.tl import functions, types
from telethon.tl.alltlobjects import LAYER

log = logging.getLogger(__name__)

#: Telegram's largest permitted part size. Parts must divide 1 MB exactly.
CHUNK_SIZE = 512 * 1024

DEFAULT_CONNECTIONS = 8

#: Past this the extra sockets stop buying throughput and only add rate-limit
#: exposure; measured gain from 8 to 16 was 13%.
MAX_CONNECTIONS = 16

#: Per-chunk retries for a flood wait on one connection. A wait on a single
#: connection should not abandon a download the other connections are serving.
CHUNK_RETRIES = 3

#: A flood wait longer than this is a real rate limit rather than a blip, and
#: belongs to the caller's own retry loop.
MAX_CHUNK_FLOOD_WAIT_SECONDS = 60


class UnsupportedDownload(Exception):
    """Raised when this media cannot be fetched over parallel connections."""


class ConnectionPool:
    """Extra MTProto connections, created on demand and shared by all downloads.

    Connections are kept for the life of the importer rather than built per
    file: for the same data centre a connection costs a round trip to open, and
    a channel of small attachments would otherwise spend more time connecting
    than downloading.
    """

    def __init__(self, client: Any, size: int) -> None:
        if size < 1:
            raise ValueError("A connection pool needs at least one connection")
        self._client = client
        self._size = size
        self._senders: dict[int, list[MTProtoSender]] = {}
        self._lock = asyncio.Lock()
        self._disabled = False

    @property
    def size(self) -> int:
        # A size of one makes `plan` select Telethon's normal downloader.
        return 1 if self._disabled else self._size

    async def senders(self, dc_id: int) -> list[MTProtoSender]:
        # The lock makes the whole first build atomic, so concurrent imports
        # cannot each open a full set of connections for the same data centre.
        async with self._lock:
            if self._disabled:
                raise UnsupportedDownload("parallel download pool is disabled")
            if (existing := self._senders.get(dc_id)) is not None:
                return existing
            created: list[MTProtoSender] = []
            try:
                for _ in range(self._size):
                    created.append(await self._connect(dc_id))
            except BaseException:
                for sender in created:
                    await _disconnect_quietly(sender)
                raise
            log.debug("Opened %d download connections to DC %d", len(created), dc_id)
            self._senders[dc_id] = created
            return created

    async def disable(self) -> None:
        """Stop parallel downloads after a transport-level pool failure.

        Telegram can terminate an extra MTProto connection with a transport
        429. Telethon deliberately leaves that sender disconnected, so keeping
        it in the pool would make every later file fail immediately.

        Do not disconnect here: concurrent downloads may still own requests on
        healthy senders in the shared pool, and Telethon cancels those requests
        during disconnect. Normal source teardown closes the disabled pool once
        every staging task has drained.
        """
        self._disabled = True

    async def _connect(self, dc_id: int) -> MTProtoSender:
        client = self._client
        dc = await client._get_dc(dc_id)
        # Within the session's own data centre the existing auth key is valid on
        # a fresh socket. Another data centre needs an authorization exported to
        # it, which is what Telethon does for its own borrowed senders.
        foreign = client.session.dc_id != dc_id
        sender = MTProtoSender(
            None if foreign else client.session.auth_key, loggers=client._log
        )
        await sender.connect(
            client._connection(
                dc.ip_address,
                dc.port,
                dc.id,
                loggers=client._log,
                proxy=client._proxy,
                local_addr=client._local_addr,
            ),
        )
        if foreign:
            authorization = await client(
                functions.auth.ExportAuthorizationRequest(dc_id)
            )
            # A copy, because `_init_request` is shared with Telethon's own
            # exported senders and it mutates the same attribute under a
            # different lock than this one.
            request = copy.copy(client._init_request)
            request.query = functions.auth.ImportAuthorizationRequest(
                id=authorization.id, bytes=authorization.bytes
            )
            await sender.send(functions.InvokeWithLayerRequest(LAYER, request))
        return sender

    async def close(self) -> None:
        async with self._lock:
            for senders in self._senders.values():
                for sender in senders:
                    await _disconnect_quietly(sender)
            self._senders.clear()


async def _disconnect_quietly(sender: MTProtoSender) -> None:
    try:
        await sender.disconnect()
    except Exception as error:  # noqa: BLE001 - teardown must not mask the real fault
        log.debug("Could not close a download connection: %s", error)
    # A transport 429 completes Telethon's disconnected future with the same
    # exception. Retrieve it during teardown so asyncio does not report a
    # misleading "Future exception was never retrieved" after the fallback.
    disconnected = getattr(sender, "disconnected", None)
    if inspect.isawaitable(disconnected):
        try:
            await disconnected
        except Exception as error:  # noqa: BLE001 - the request already owns the fault
            log.debug("Download connection ended with: %s", error)


def plan(message: Any, connections: int) -> tuple[Any, int, int] | None:
    """Return ``(location, dc_id, size)`` when parallel download suits this media.

    `None` means the caller should use Telethon's downloader instead.
    """
    if connections < 2 or not message.document:
        return None
    size = message.file.size if message.file else 0
    # One chunk is a single round trip either way, and Telethon's path already
    # handles every media shape.
    if not size or size <= CHUNK_SIZE:
        return None
    dc_id, location = utils.get_input_location(message.document)
    if dc_id is None:
        return None
    return location, dc_id, size


async def download(
    pool: ConnectionPool,
    *,
    location: Any,
    dc_id: int,
    size: int,
    target: Path,
    on_progress: Callable[[int, int], None] | None = None,
) -> Path:
    """Fetch `size` bytes into `target` over the pool's connections."""
    senders = await pool.senders(dc_id)
    chunks = -(-size // CHUNK_SIZE)
    workers = min(len(senders), chunks)

    cursor = 0
    received = 0
    aborted = False

    def claim() -> int | None:
        """Take the next unfetched offset, or `None` when there is nothing left.

        Nothing is awaited between the test and the advance, so on the single
        event-loop thread the pair is atomic and no offset is handed out twice.
        """
        nonlocal cursor
        if aborted or cursor >= size:
            return None
        offset = cursor
        cursor += CHUNK_SIZE
        return offset

    _allocate(target, size)
    handles = [target.open("r+b") for _ in range(workers)]

    async def worker(sender: MTProtoSender, handle: BinaryIO) -> None:
        nonlocal received, aborted
        try:
            while (offset := claim()) is not None:
                data = await _fetch(sender, location, offset)
                if not data:
                    continue
                # Each worker owns its own handle, so seeking and writing needs
                # no lock and stays off the event loop thread.
                await asyncio.to_thread(_write_at, handle, offset, data)
                received += len(data)
                if on_progress:
                    on_progress(received, size)
        except BaseException:
            # Set here rather than after the gather below, so the other workers
            # stop claiming chunks now instead of finishing a file that is
            # already lost.
            aborted = True
            raise

    try:
        results = await asyncio.gather(
            *(worker(sender, handle) for sender, handle in zip(senders, handles)),
            return_exceptions=True,
        )
        # Collect every result before re-raising: a plain gather would propagate
        # the first failure while its siblings kept downloading into handles the
        # `finally` below is about to close.
        for result in results:
            if isinstance(result, BaseException):
                raise result
    finally:
        # Stops any worker that outlived a cancellation from claiming more work.
        aborted = True
        for handle in handles:
            handle.close()

    if received != size:
        raise RuntimeError(
            f"Telegram returned {received} of {size} bytes for {target.name}"
        )
    return target


async def _fetch(sender: MTProtoSender, location: Any, offset: int) -> bytes:
    for attempt in range(CHUNK_RETRIES):
        try:
            result = await sender.send(
                functions.upload.GetFileRequest(
                    location, offset=offset, limit=CHUNK_SIZE
                ),
            )
        except FloodWaitError as error:
            if (
                attempt == CHUNK_RETRIES - 1
                or error.seconds > MAX_CHUNK_FLOOD_WAIT_SECONDS
            ):
                raise
            log.debug(
                "Download connection waiting %ds after a flood wait", error.seconds
            )
            await asyncio.sleep(error.seconds)
            continue
        if isinstance(result, types.upload.FileCdnRedirect):
            raise UnsupportedDownload("Telegram redirected this file to a CDN")
        return result.bytes
    raise AssertionError("unreachable")


def _allocate(target: Path, size: int) -> None:
    """Create `target` at its final length so workers can write at any offset."""
    with target.open("wb") as handle:
        handle.truncate(size)


def _write_at(handle: BinaryIO, offset: int, data: bytes) -> None:
    handle.seek(offset)
    handle.write(data)
