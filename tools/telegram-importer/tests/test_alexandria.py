from __future__ import annotations

import pytest
from alexandria_telegram_importer.alexandria import AlexandriaClient, session_filenames


def test_should_require_https_for_non_loopback_alexandria_hosts() -> None:
    with pytest.raises(ValueError, match="requires HTTPS"):
        AlexandriaClient("http://alexandria.example.com")


@pytest.mark.asyncio
async def test_should_allow_loopback_http_without_following_redirects() -> None:
    client = AlexandriaClient("http://127.0.0.1:3000")
    try:
        assert client._client.follow_redirects is False
    finally:
        await client.close()


def test_should_collect_session_filenames_from_nested_folder_structure() -> None:
    session = {
        "detected": {
            "folderStructure": [
                {
                    "name": "renders",
                    "type": "directory",
                    "children": [
                        {"name": "front.jpg", "type": "file"},
                        {
                            "name": "details",
                            "type": "directory",
                            "children": [
                                {"name": "close-up.png", "type": "file"},
                            ],
                        },
                    ],
                },
                {"name": "model.stl", "type": "file"},
            ],
        },
    }

    assert session_filenames(session) == {"front.jpg", "close-up.png", "model.stl"}


def test_should_return_no_filenames_when_session_detection_is_absent() -> None:
    assert session_filenames({"detected": None}) == set()
