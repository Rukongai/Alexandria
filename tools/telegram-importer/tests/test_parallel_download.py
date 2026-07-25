from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from telethon.errors import FloodWaitError
from telethon.tl import types

from alexandria_telegram_importer import parallel_download
from alexandria_telegram_importer.parallel_download import (
    ConnectionPool,
    UnsupportedDownload,
    download,
    plan,
)

CHUNK = 64


@pytest.fixture(autouse=True)
def small_chunks(monkeypatch):
    """Shrink the part size so tests move bytes instead of megabytes."""
    monkeypatch.setattr(parallel_download, "CHUNK_SIZE", CHUNK)


class FakeSender:
    """Serves ranges of `payload`, recording the offsets it was asked for."""

    def __init__(self, payload: bytes) -> None:
        self._payload = payload
        self.offsets: list[int] = []

    async def send(self, request):
        self.offsets.append(request.offset)
        # A real connection always yields, and yielding is what lets the other
        # workers claim their own offsets before this one returns.
        await asyncio.sleep(0)
        return SimpleNamespace(
            bytes=self._payload[request.offset : request.offset + request.limit]
        )


class FakePool:
    def __init__(self, senders) -> None:
        self._senders = list(senders)
        self.size = len(self._senders)

    async def senders(self, _dc_id):
        return self._senders


def document(*, size: int, dc_id: int = 2):
    return types.Document(
        id=99,
        access_hash=1234,
        file_reference=b"ref",
        date=None,
        mime_type="application/zip",
        size=size,
        dc_id=dc_id,
        attributes=[],
    )


def message(*, document_value=None, photo=None, size: int = 0):
    return SimpleNamespace(
        document=document_value,
        photo=photo,
        file=SimpleNamespace(size=size),
    )


@pytest.mark.asyncio
async def test_should_reassemble_every_chunk_in_order(tmp_path) -> None:
    payload = bytes(range(256)) * 5 + b"tail"
    pool = FakePool(FakeSender(payload) for _ in range(4))
    target = tmp_path / "model.zip"

    await download(
        pool,
        location="loc",
        dc_id=2,
        size=len(payload),
        target=target,
        on_progress=None,
    )

    assert target.read_bytes() == payload


@pytest.mark.asyncio
async def test_should_spread_chunks_over_every_connection(tmp_path) -> None:
    payload = b"x" * (CHUNK * 8)
    senders = [FakeSender(payload) for _ in range(4)]
    pool = FakePool(senders)

    await download(
        pool,
        location="loc",
        dc_id=2,
        size=len(payload),
        target=tmp_path / "model.zip",
        on_progress=None,
    )

    served = [sender.offsets for sender in senders]
    assert all(offsets for offsets in served), f"an idle connection: {served}"
    # Every offset fetched exactly once, by exactly one connection.
    assert sorted(o for offsets in served for o in offsets) == [
        CHUNK * i for i in range(8)
    ]


@pytest.mark.asyncio
async def test_should_report_progress_that_only_ever_rises(tmp_path) -> None:
    payload = b"y" * (CHUNK * 6 + 7)
    pool = FakePool(FakeSender(payload) for _ in range(3))
    seen: list[tuple[int, int]] = []

    await download(
        pool,
        location="loc",
        dc_id=2,
        size=len(payload),
        target=tmp_path / "model.zip",
        on_progress=lambda received, total: seen.append((received, total)),
    )

    assert seen[-1] == (len(payload), len(payload))
    assert [received for received, _ in seen] == sorted(
        received for received, _ in seen
    )
    assert {total for _, total in seen} == {len(payload)}


@pytest.mark.asyncio
async def test_should_use_no_more_connections_than_there_are_chunks(tmp_path) -> None:
    payload = b"z" * (CHUNK + 1)
    senders = [FakeSender(payload) for _ in range(8)]
    pool = FakePool(senders)

    await download(
        pool,
        location="loc",
        dc_id=2,
        size=len(payload),
        target=tmp_path / "model.zip",
        on_progress=None,
    )

    assert sum(1 for sender in senders if sender.offsets) == 2


@pytest.mark.asyncio
async def test_should_reject_a_short_download_rather_than_a_truncated_file(
    tmp_path,
) -> None:
    payload = b"w" * (CHUNK * 3)
    pool = FakePool(FakeSender(payload) for _ in range(2))

    with pytest.raises(RuntimeError, match="of 500 bytes"):
        await download(
            pool,
            location="loc",
            dc_id=2,
            size=500,
            target=tmp_path / "model.zip",
            on_progress=None,
        )


@pytest.mark.asyncio
async def test_should_surface_a_cdn_redirect_as_unsupported(tmp_path) -> None:
    class RedirectingSender:
        async def send(self, _request):
            return types.upload.FileCdnRedirect(
                dc_id=4,
                file_token=b"token",
                encryption_key=b"key",
                encryption_iv=b"iv",
                file_hashes=[],
            )

    pool = FakePool([RedirectingSender()])

    with pytest.raises(UnsupportedDownload):
        await download(
            pool,
            location="loc",
            dc_id=2,
            size=CHUNK * 2,
            target=tmp_path / "model.zip",
            on_progress=None,
        )


@pytest.mark.asyncio
async def test_should_retry_one_chunk_through_a_short_flood_wait(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setattr(asyncio, "sleep", _instant_sleep)
    payload = b"v" * (CHUNK * 2)

    class FloodingOnceSender(FakeSender):
        def __init__(self) -> None:
            super().__init__(payload)
            self._flooded = False

        async def send(self, request):
            if not self._flooded:
                self._flooded = True
                raise FloodWaitError(request=None)
            return await super().send(request)

    pool = FakePool([FloodingOnceSender()])

    await download(
        pool,
        location="loc",
        dc_id=2,
        size=len(payload),
        target=tmp_path / "model.zip",
        on_progress=None,
    )

    assert (tmp_path / "model.zip").read_bytes() == payload


@pytest.mark.asyncio
async def test_should_raise_a_long_flood_wait_to_the_callers_retry_loop(
    tmp_path,
) -> None:
    class FloodingSender:
        async def send(self, _request):
            error = FloodWaitError(request=None)
            error.seconds = parallel_download.MAX_CHUNK_FLOOD_WAIT_SECONDS + 1
            raise error

    pool = FakePool([FloodingSender()])

    with pytest.raises(FloodWaitError):
        await download(
            pool,
            location="loc",
            dc_id=2,
            size=CHUNK * 2,
            target=tmp_path / "model.zip",
            on_progress=None,
        )


@pytest.mark.asyncio
async def test_should_stop_the_other_connections_once_one_fails(tmp_path) -> None:
    payload = b"u" * (CHUNK * 200)

    class FailingSender(FakeSender):
        def __init__(self) -> None:
            super().__init__(payload)

        async def send(self, request):
            await super().send(request)
            raise RuntimeError("connection lost")

    survivor = FakeSender(payload)
    pool = FakePool([FailingSender(), survivor])

    with pytest.raises(RuntimeError, match="connection lost"):
        await download(
            pool,
            location="loc",
            dc_id=2,
            size=len(payload),
            target=tmp_path / "model.zip",
            on_progress=None,
        )

    # Without the abort flag the survivor would fetch all 199 remaining chunks.
    assert len(survivor.offsets) < 10


def test_should_plan_a_parallel_download_for_a_large_document() -> None:
    result = plan(
        message(document_value=document(size=CHUNK * 10), size=CHUNK * 10),
        connections=8,
    )

    assert result is not None
    location, dc_id, size = result
    assert dc_id == 2
    assert size == CHUNK * 10
    assert isinstance(location, types.InputDocumentFileLocation)


@pytest.mark.parametrize(
    ("case", "value", "connections"),
    [
        ("a single connection", message(document_value=document(size=CHUNK * 10)), 1),
        ("a photo", message(photo=SimpleNamespace(id=1), size=CHUNK * 10), 8),
        ("no media", message(), 8),
        ("an unknown size", message(document_value=document(size=0), size=0), 8),
    ],
)
def test_should_decline_to_plan(case, value, connections) -> None:
    if value.document is not None:
        value.file = SimpleNamespace(size=value.document.size)
    assert plan(value, connections) is None, case


def test_should_decline_to_plan_a_file_smaller_than_one_chunk() -> None:
    small = message(document_value=document(size=CHUNK), size=CHUNK)

    assert plan(small, connections=8) is None


class FakeClientForPool:
    def __init__(self) -> None:
        self.connections = 0
        self.session = SimpleNamespace(dc_id=2, auth_key="key")
        self._log = {}

    async def _get_dc(self, dc_id):
        return SimpleNamespace(id=dc_id, ip_address="127.0.0.1", port=443)

    def _connection(self, *_args, **_kwargs):
        return object()

    @property
    def _proxy(self):
        return None

    @property
    def _local_addr(self):
        return None


@pytest.mark.asyncio
async def test_should_open_each_connection_once_and_reuse_it(monkeypatch) -> None:
    opened = []

    class RecordingSender:
        def __init__(self, auth_key, loggers=None) -> None:
            self.auth_key = auth_key
            self.disconnected = False
            opened.append(self)

        async def connect(self, _connection) -> None:
            pass

        async def disconnect(self) -> None:
            self.disconnected = True

    monkeypatch.setattr(parallel_download, "MTProtoSender", RecordingSender)
    pool = ConnectionPool(FakeClientForPool(), 4)

    first, second = await asyncio.gather(pool.senders(2), pool.senders(2))

    assert len(opened) == 4
    assert first is second
    # Same data centre: the session's own key travels to the new sockets.
    assert {sender.auth_key for sender in opened} == {"key"}

    await pool.close()
    assert all(sender.disconnected for sender in opened)


async def _instant_sleep(_seconds) -> None:
    return None
