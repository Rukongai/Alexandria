from __future__ import annotations

import asyncio
import ipaddress
import logging
import math
import mimetypes
from collections.abc import Callable
from contextlib import ExitStack
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

log = logging.getLogger(__name__)

CHUNK_SIZE = 10 * 1024 * 1024


class AlexandriaError(RuntimeError):
    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class AlexandriaClient:
    def __init__(
        self,
        base_url: str,
        *,
        library_id: str | None = None,
        poll_interval: float = 2.0,
        allow_insecure_http: bool = False,
    ) -> None:
        parsed_url = urlsplit(base_url)
        if parsed_url.scheme not in {"http", "https"} or not parsed_url.hostname:
            raise ValueError("Alexandria URL must be an absolute HTTP(S) URL")
        if parsed_url.username or parsed_url.password:
            raise ValueError("Alexandria credentials must not be embedded in the URL")
        is_loopback = parsed_url.hostname.casefold() == "localhost"
        try:
            is_loopback = (
                is_loopback or ipaddress.ip_address(parsed_url.hostname).is_loopback
            )
        except ValueError:
            pass
        if parsed_url.scheme != "https" and not is_loopback and not allow_insecure_http:
            raise ValueError(
                "Alexandria requires HTTPS for non-loopback hosts; "
                "pass --allow-insecure-http only for a trusted private network",
            )
        headers = {"X-Library-Id": library_id} if library_id else {}
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/") + "/",
            headers=headers,
            timeout=httpx.Timeout(120.0, connect=15.0),
            follow_redirects=False,
        )
        self.poll_interval = poll_interval
        self._metadata_fields_cache: tuple[dict[str, Any], ...] | None = None
        self._metadata_fields_task: asyncio.Task[tuple[dict[str, Any], ...]] | None = (
            None
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def _request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        response = await self._client.request(method, url.lstrip("/"), **kwargs)
        if response.is_success:
            return response
        try:
            payload = response.json()
            errors = payload.get("errors")
            message = errors[0].get("message") if errors else response.text
        except (ValueError, AttributeError, IndexError, TypeError):
            message = response.text
        raise AlexandriaError(
            f"Alexandria {method} {url} failed ({response.status_code}): {message}",
            status_code=response.status_code,
        )

    @staticmethod
    def _data(response: httpx.Response) -> Any:
        return response.json()["data"]

    async def login(self, email: str, password: str) -> None:
        response = await self._request(
            "POST",
            "/auth/login",
            json={"email": email, "password": password},
        )
        user = self._data(response)
        log.info("Logged into Alexandria as %s", user.get("email", email))

    async def metadata_fields(self) -> tuple[dict[str, Any], ...]:
        """Configured metadata definitions for commit-payload normalization."""
        if self._metadata_fields_cache is not None:
            return self._metadata_fields_cache
        if self._metadata_fields_task is None:
            self._metadata_fields_task = asyncio.create_task(
                self._fetch_metadata_fields()
            )
        try:
            self._metadata_fields_cache = await self._metadata_fields_task
        except BaseException:
            self._metadata_fields_task = None
            raise
        return self._metadata_fields_cache

    async def _fetch_metadata_fields(self) -> tuple[dict[str, Any], ...]:
        response = await self._request("GET", "/metadata/fields")
        fields = self._data(response)
        if not isinstance(fields, list) or not all(
            isinstance(field, dict) for field in fields
        ):
            raise AlexandriaError("Alexandria returned invalid metadata fields")
        return tuple(fields)

    async def validate_metadata(
        self,
        values: dict[str, Any],
    ) -> dict[str, Any]:
        """Apply Alexandria's authoritative semantic metadata validation."""
        response = await self._request(
            "POST",
            "/metadata/fields/validate",
            json=values,
        )
        normalized = self._data(response)
        if not isinstance(normalized, dict):
            raise AlexandriaError("Alexandria returned invalid normalized metadata")
        return normalized

    async def _upload_part(
        self,
        path: Path,
        upload_filename: str,
        *,
        multipart: bool,
        on_progress: Callable[[int, int], None] | None = None,
    ) -> str:
        size = path.stat().st_size
        total_chunks = max(1, math.ceil(size / CHUNK_SIZE))
        endpoint = (
            "/models/upload/multipart/init" if multipart else "/models/upload/init"
        )
        response = await self._request(
            "POST",
            endpoint,
            json={
                "filename": upload_filename,
                "totalSize": size,
                "totalChunks": total_chunks,
            },
        )
        upload_id = self._data(response)["uploadId"]

        if on_progress:
            on_progress(0, size)
        sent = 0
        with path.open("rb") as handle:
            for index in range(total_chunks):
                chunk = handle.read(CHUNK_SIZE)
                for attempt in range(3):
                    try:
                        await self._request(
                            "PUT",
                            f"/models/upload/{upload_id}/chunk/{index}",
                            content=chunk,
                            headers={"Content-Type": "application/octet-stream"},
                        )
                        break
                    except (httpx.HTTPError, AlexandriaError):
                        if attempt == 2:
                            raise
                        await asyncio.sleep(2**attempt)
                # Reported after the successful PUT, so retried chunks are
                # counted once.
                sent += len(chunk)
                if on_progress:
                    on_progress(sent, size)
        return upload_id

    async def upload_archive(
        self,
        paths: tuple[Path, ...],
        upload_names: tuple[str, ...],
        *,
        multipart: bool,
    ) -> str:
        if len(paths) != len(upload_names):
            raise ValueError("Every upload path must have an upload name")
        if multipart and len(paths) < 2:
            raise AlexandriaError("A split archive must contain at least two parts")

        upload_ids: list[str] = []
        try:
            for path, upload_name in zip(paths, upload_names, strict=True):
                upload_ids.append(
                    await self.upload_file(path, upload_name, multipart=multipart)
                )
            return await self.complete_upload(upload_ids, multipart=multipart)
        except Exception:
            await self.abort_uploads(upload_ids)
            raise

    async def upload_file(
        self,
        path: Path,
        upload_name: str,
        *,
        multipart: bool,
        on_progress: Callable[[int, int], None] | None = None,
    ) -> str:
        log.info("Uploading %s (%d bytes)", upload_name, path.stat().st_size)
        return await self._upload_part(
            path, upload_name, multipart=multipart, on_progress=on_progress
        )

    async def complete_upload(self, upload_ids: list[str], *, multipart: bool) -> str:
        if multipart:
            response = await self._request(
                "POST",
                "/models/upload/multipart/complete",
                json={"uploadIds": upload_ids, "mode": "split"},
            )
        else:
            response = await self._request(
                "POST",
                f"/models/upload/{upload_ids[0]}/complete",
            )
        return self._data(response)["sessionId"]

    async def abort_uploads(self, upload_ids: list[str]) -> None:
        for upload_id in upload_ids:
            try:
                await self._request("DELETE", f"/models/upload/{upload_id}")
            except (httpx.HTTPError, AlexandriaError) as cleanup_error:
                log.debug("Could not abort upload %s: %s", upload_id, cleanup_error)

    async def get_session(self, session_id: str) -> dict[str, Any]:
        response = await self._request("GET", f"/models/import-sessions/{session_id}")
        return self._data(response)

    async def get_model_status(self, model_id: str) -> dict[str, Any]:
        response = await self._request("GET", f"/models/{model_id}/status")
        return self._data(response)

    async def find_session_by_filename(self, filename: str) -> dict[str, Any] | None:
        response = await self._request("GET", "/models/import-sessions")
        matches = [
            item
            for item in self._data(response)
            if item["originalFilename"] == filename
        ]
        if not matches:
            return None
        return max(matches, key=lambda item: item["createdAt"])

    async def wait_for_session(
        self,
        session_id: str,
        statuses: set[str],
        *,
        timeout_seconds: float = 6 * 60 * 60,
    ) -> dict[str, Any]:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_seconds
        last_status: str | None = None
        while loop.time() < deadline:
            session = await self.get_session(session_id)
            status = session["status"]
            if status != last_status:
                log.info("Alexandria session %s is %s", session_id, status)
                last_status = status
            if status in statuses or status == "error":
                return session
            await asyncio.sleep(self.poll_interval)
        raise AlexandriaError(f"Timed out waiting for Alexandria session {session_id}")

    async def append_files(
        self,
        session_id: str,
        paths: tuple[Path, ...],
        upload_names: tuple[str, ...],
    ) -> dict[str, Any]:
        with ExitStack() as stack:
            files = []
            for path, upload_name in zip(paths, upload_names, strict=True):
                handle = stack.enter_context(path.open("rb"))
                content_type = (
                    mimetypes.guess_type(upload_name)[0] or "application/octet-stream"
                )
                files.append(("files", (upload_name, handle, content_type)))
            response = await self._request(
                "POST",
                f"/models/import-sessions/{session_id}/files",
                files=files,
            )
        return self._data(response)

    async def commit(
        self,
        session_id: str,
        *,
        model_name: str,
        description: str | None = None,
        batch_metadata: dict[str, Any] | None = None,
    ) -> str:
        payload: dict[str, Any] = dict(batch_metadata or {})
        payload["modelName"] = model_name[:255]
        if description is not None:
            payload["description"] = description[:2000]
        response = await self._request(
            "POST",
            f"/models/import-sessions/{session_id}/commit",
            json={"batchMetadata": payload},
        )
        return self._data(response)["modelId"]

    async def discard_session(self, session_id: str) -> None:
        await self._request("DELETE", f"/models/import-sessions/{session_id}")


def session_filenames(session: dict[str, Any]) -> set[str]:
    names: set[str] = set()

    def visit(nodes: list[dict[str, Any]]) -> None:
        for node in nodes:
            if node.get("type") == "file" and node.get("name"):
                names.add(node["name"])
            children = node.get("children")
            if isinstance(children, list):
                visit(children)

    detected = session.get("detected") or {}
    structure = detected.get("folderStructure") or []
    visit(structure)
    for item in detected.get("previewImages") or []:
        if item.get("filename"):
            names.add(item["filename"])
    for item in detected.get("archives") or []:
        if item.get("filename"):
            names.add(item["filename"])
    return names
