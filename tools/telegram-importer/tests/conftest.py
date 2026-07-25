from __future__ import annotations

import pytest

from alexandria_telegram_importer.models import MediaKind, MediaRef


@pytest.fixture
def media_ref():
    def make(
        message_id: int,
        filename: str,
        *,
        kind: MediaKind = MediaKind.MODEL,
        caption: str | None = None,
        size: int = 0,
        media_identity: str | None = None,
    ) -> MediaRef:
        return MediaRef(
            message_id=message_id,
            filename=filename,
            kind=kind,
            caption=caption,
            size=size,
            media_identity=media_identity,
        )

    return make
