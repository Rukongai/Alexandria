from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from telethon.errors import FileReferenceExpiredError
from telethon.tl.types import Channel, ChatPhotoEmpty

from alexandria_telegram_importer import parallel_download, telegram_source
from alexandria_telegram_importer.models import MediaKind, MediaRef
from alexandria_telegram_importer.telegram_source import TelegramSource


def telegram_message(*, document_id=None, photo_id=None, size: int = 0):
    return SimpleNamespace(
        file=SimpleNamespace(size=size),
        document=(SimpleNamespace(id=document_id) if document_id is not None else None),
        photo=(SimpleNamespace(id=photo_id) if photo_id is not None else None),
    )


def test_should_derive_stable_document_identity_from_telegram_media_and_size() -> None:
    first_post = telegram_message(document_id=123456789, size=4096)
    forwarded_post = telegram_message(document_id=123456789, size=4096)

    assert TelegramSource._media_identity(first_post) == "document:123456789:4096"
    assert TelegramSource._media_identity(forwarded_post) == "document:123456789:4096"


def test_should_distinguish_photo_identity_and_missing_media() -> None:
    photo = telegram_message(photo_id=987654321, size=2048)
    missing = telegram_message()

    assert TelegramSource._media_identity(photo) == "photo:987654321:2048"
    assert TelegramSource._media_identity(missing) is None


class RecordingTelethonClient:
    """Stands in for telethon's client, capturing the download arguments."""

    def __init__(self, message=None) -> None:
        self.progress_callback = None
        self.calls = 0
        self._message = message

    async def get_messages(self, _entity, ids: int):
        return self._message or SimpleNamespace(id=ids)

    async def download_media(self, _message, file: str, progress_callback=None):
        self.calls += 1
        self.progress_callback = progress_callback
        Path(file).write_bytes(b"payload")
        return file


def source_with(client, *, connections: int = 1) -> TelegramSource:
    """Build a source around a fake client, skipping the real Telethon setup."""
    source = TelegramSource.__new__(TelegramSource)
    source._client = client
    source._downloads = SimpleNamespace(size=connections)
    source.entity = object()
    source.channel_id = -1002050123456
    source.channel_username = None
    return source


def downloadable_message(message_id: int, filename: str | None):
    file = (
        SimpleNamespace(name=filename, ext=".zip", size=1024)
        if filename is not None
        else None
    )
    return SimpleNamespace(
        id=message_id,
        file=file,
        document=SimpleNamespace(id=message_id) if file else None,
        photo=None,
        message=f"Caption {message_id}",
    )


@pytest.mark.asyncio
async def test_should_collect_only_selected_message_ids_and_report_missing_media() -> None:
    class SelectionClient:
        async def get_messages(self, _entity, ids):
            assert ids == [10, 20, 30]
            return [
                downloadable_message(10, "dragon.zip"),
                downloadable_message(20, None),
                None,
            ]

    source = source_with(SelectionClient())

    refs, unavailable = await source.collect_media_by_ids((10, 20, 30))

    assert [(ref.message_id, ref.filename) for ref in refs] == [(10, "dragon.zip")]
    assert unavailable == (20, 30)


def test_should_build_a_private_message_link_from_the_peer_id() -> None:
    source = source_with(RecordingTelethonClient())

    assert source.message_link(321) == "https://t.me/c/2050123456/321"


@pytest.mark.asyncio
async def test_should_resolve_an_uncached_private_channel_from_dialogs() -> None:
    selected = Channel(
        id=2050123456,
        title="Private models",
        photo=ChatPhotoEmpty(),
        date=None,
        access_hash=123,
    )

    class FreshSessionClient:
        async def get_entity(self, _channel):
            raise ValueError("entity is not cached")

        async def iter_dialogs(self):
            yield SimpleNamespace(entity=selected)

    source = source_with(FreshSessionClient())

    await source.select_channel(-1002050123456)

    assert source.entity is selected
    assert source.channel_id == -1002050123456


@pytest.mark.asyncio
async def test_should_forward_the_progress_callback_to_telethon(tmp_path) -> None:
    client = RecordingTelethonClient()
    source = source_with(client)
    ref = MediaRef(message_id=7, filename="dragon.zip", kind=MediaKind.MODEL)
    seen: list[tuple[int, int]] = []

    await source.download(ref, tmp_path, on_progress=lambda a, b: seen.append((a, b)))

    assert client.progress_callback is not None
    client.progress_callback(5, 10)
    assert seen == [(5, 10)]


@pytest.mark.asyncio
async def test_should_download_without_a_progress_callback(tmp_path) -> None:
    client = RecordingTelethonClient()
    source = source_with(client)
    ref = MediaRef(message_id=7, filename="dragon.zip", kind=MediaKind.MODEL)

    path = await source.download(ref, tmp_path)

    assert path.exists()
    assert client.progress_callback is None


@pytest.mark.asyncio
async def test_should_use_the_parallel_downloader_when_the_plan_allows_it(
    tmp_path, monkeypatch
) -> None:
    client = RecordingTelethonClient()
    source = source_with(client, connections=4)
    monkeypatch.setattr(
        telegram_source.parallel_download, "plan", lambda *_: ("loc", 2, 4096)
    )

    async def fake_download(_pool, *, location, dc_id, size, target, on_progress):
        target.write_bytes(b"parallel")
        return target

    monkeypatch.setattr(telegram_source.parallel_download, "download", fake_download)
    ref = MediaRef(message_id=7, filename="dragon.zip", kind=MediaKind.MODEL)

    path = await source.download(ref, tmp_path)

    assert path.read_bytes() == b"parallel"
    assert client.calls == 0


@pytest.mark.asyncio
async def test_should_fall_back_to_telethon_when_parallel_download_is_unsupported(
    tmp_path, monkeypatch
) -> None:
    client = RecordingTelethonClient()
    source = source_with(client, connections=4)
    monkeypatch.setattr(
        telegram_source.parallel_download, "plan", lambda *_: ("loc", 2, 4096)
    )

    async def refuse(*_args, **_kwargs):
        raise parallel_download.UnsupportedDownload("redirected to a CDN")

    monkeypatch.setattr(telegram_source.parallel_download, "download", refuse)
    ref = MediaRef(message_id=7, filename="dragon.zip", kind=MediaKind.MODEL)

    path = await source.download(ref, tmp_path)

    assert path.read_bytes() == b"payload"
    assert client.calls == 1


@pytest.mark.asyncio
async def test_should_refetch_the_message_when_the_file_reference_expired(
    tmp_path, monkeypatch
) -> None:
    client = RecordingTelethonClient()
    source = source_with(client, connections=4)
    monkeypatch.setattr(
        telegram_source.parallel_download, "plan", lambda *_: ("loc", 2, 4096)
    )
    attempts = 0

    async def expire_once(_pool, *, location, dc_id, size, target, on_progress):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise FileReferenceExpiredError(request=None)
        target.write_bytes(b"renewed")
        return target

    monkeypatch.setattr(telegram_source.parallel_download, "download", expire_once)
    ref = MediaRef(message_id=7, filename="dragon.zip", kind=MediaKind.MODEL)

    path = await source.download(ref, tmp_path)

    assert attempts == 2
    assert path.read_bytes() == b"renewed"
