from __future__ import annotations

from types import SimpleNamespace

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
