from __future__ import annotations

import httpx
import pytest

from alexandria_telegram_importer import alexandria as alexandria_module
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


def upload_client(monkeypatch, *, failures: int = 0) -> AlexandriaClient:
    """Client whose chunk PUTs fail `failures` times before succeeding."""
    monkeypatch.setattr(alexandria_module, "CHUNK_SIZE", 10)
    client = AlexandriaClient("http://127.0.0.1:3000")
    remaining = {"failures": failures}

    async def fake_request(method: str, url: str, **_kwargs):
        if method == "POST":
            return httpx.Response(
                200,
                json={"data": {"uploadId": "upload-1"}},
                request=httpx.Request(method, url),
            )
        if remaining["failures"]:
            remaining["failures"] -= 1
            raise httpx.ConnectError("chunk upload failed")
        return httpx.Response(
            200, json={"data": {}}, request=httpx.Request(method, url)
        )

    monkeypatch.setattr(client, "_request", fake_request)
    return client


@pytest.mark.asyncio
async def test_should_report_cumulative_upload_progress_per_chunk(
    tmp_path, monkeypatch
) -> None:
    path = tmp_path / "model.zip"
    path.write_bytes(b"x" * 25)
    client = upload_client(monkeypatch)
    seen: list[tuple[int, int]] = []
    try:
        await client.upload_file(
            path,
            "model.zip",
            multipart=False,
            on_progress=lambda a, b: seen.append((a, b)),
        )
    finally:
        await client.close()

    # An opening call so the total is known before any bytes move, then one per
    # 10-byte chunk.
    assert seen == [(0, 25), (10, 25), (20, 25), (25, 25)]


@pytest.mark.asyncio
async def test_should_not_double_count_a_retried_chunk(tmp_path, monkeypatch) -> None:
    path = tmp_path / "model.zip"
    path.write_bytes(b"x" * 25)
    client = upload_client(monkeypatch, failures=2)
    monkeypatch.setattr(alexandria_module.asyncio, "sleep", _no_sleep)
    seen: list[tuple[int, int]] = []
    try:
        await client.upload_file(
            path,
            "model.zip",
            multipart=False,
            on_progress=lambda a, b: seen.append((a, b)),
        )
    finally:
        await client.close()

    assert seen == [(0, 25), (10, 25), (20, 25), (25, 25)]


async def _no_sleep(_seconds: float) -> None:
    return None
