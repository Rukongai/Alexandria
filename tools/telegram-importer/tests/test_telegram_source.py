from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

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

    def __init__(self) -> None:
        self.progress_callback = None

    async def get_messages(self, _entity, ids: int):
        return SimpleNamespace(id=ids)

    async def download_media(self, _message, file: str, progress_callback=None):
        self.progress_callback = progress_callback
        Path(file).write_bytes(b"payload")
        return file


@pytest.mark.asyncio
async def test_should_forward_the_progress_callback_to_telethon(tmp_path) -> None:
    source = TelegramSource.__new__(TelegramSource)
    client = RecordingTelethonClient()
    source._client = client
    source.entity = object()
    ref = MediaRef(message_id=7, filename="dragon.zip", kind=MediaKind.MODEL)
    seen: list[tuple[int, int]] = []

    await source.download(ref, tmp_path, on_progress=lambda a, b: seen.append((a, b)))

    assert client.progress_callback is not None
    client.progress_callback(5, 10)
    assert seen == [(5, 10)]


@pytest.mark.asyncio
async def test_should_download_without_a_progress_callback(tmp_path) -> None:
    source = TelegramSource.__new__(TelegramSource)
    client = RecordingTelethonClient()
    source._client = client
    source.entity = object()
    ref = MediaRef(message_id=7, filename="dragon.zip", kind=MediaKind.MODEL)

    path = await source.download(ref, tmp_path)

    assert path.exists()
    assert client.progress_callback is None
