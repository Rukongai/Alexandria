from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any

from telethon import TelegramClient, utils
from telethon.errors import FileReferenceExpiredError, FloodWaitError
from telethon.tl.types import Channel

from . import parallel_download
from .grouping import is_model_filename, safe_filename
from .models import MediaKind, MediaRef

log = logging.getLogger(__name__)


class TelegramSource:
    def __init__(
        self,
        *,
        api_id: int,
        api_hash: str,
        session_path: Path,
        phone: str | None = None,
        download_connections: int = parallel_download.DEFAULT_CONNECTIONS,
    ) -> None:
        session_path.parent.mkdir(parents=True, exist_ok=True)
        self._client = TelegramClient(str(session_path), api_id, api_hash)
        self._phone = phone
        self._downloads = parallel_download.ConnectionPool(
            self._client, download_connections
        )
        self.entity: Any = None
        self.channel_id: int = 0
        self.channel_username: str | None = None

    async def connect(self, channel: str | int | None) -> None:
        await self._client.start(
            phone=self._phone or (lambda: input("Telegram phone number: "))
        )
        me = await self._client.get_me()
        log.info(
            "Logged into Telegram as %s", getattr(me, "username", None) or me.first_name
        )
        selected = channel if channel is not None else await self._pick_channel()
        await self.select_channel(selected)

    async def select_channel(self, channel: str | int) -> None:
        """Select a source channel after the Telegram session is connected."""
        selected = channel
        try:
            self.entity = await self._client.get_entity(selected)
        except ValueError as error:
            if not isinstance(selected, int):
                raise
            self.entity = None
            async for dialog in self._client.iter_dialogs():
                if utils.get_peer_id(dialog.entity) == selected:
                    self.entity = dialog.entity
                    break
            if self.entity is None:
                raise RuntimeError(
                    f"Telegram channel {selected} is not visible to this account"
                ) from error
        self.channel_id = utils.get_peer_id(self.entity)
        self.channel_username = getattr(self.entity, "username", None)
        log.info("Reading Telegram channel %s", getattr(self.entity, "title", selected))

    async def close(self) -> None:
        await self._downloads.close()
        await self._client.disconnect()

    async def _pick_channel(self) -> int | str:
        dialogs = []
        async for dialog in self._client.iter_dialogs():
            if isinstance(dialog.entity, Channel):
                dialogs.append(dialog)
        if not dialogs:
            raise RuntimeError("The Telegram account has no channels")
        print("Choose a Telegram source channel:")
        for index, dialog in enumerate(dialogs, start=1):
            print(f"  [{index}] {dialog.name}")
        while True:
            choice = input("Channel number or username: ").strip()
            if choice.isdigit() and 1 <= int(choice) <= len(dialogs):
                return dialogs[int(choice) - 1].entity.id
            if choice:
                return choice

    @staticmethod
    def _filename(message: Any) -> str | None:
        if message.file and message.file.name:
            return safe_filename(message.file.name, f"media_{message.id}")
        extension = message.file.ext if message.file and message.file.ext else ""
        if message.photo:
            extension = extension or ".jpg"
            return f"photo_{message.id}{extension}"
        if message.document:
            return f"document_{message.id}{extension}"
        return None

    @staticmethod
    def _media_identity(message: Any) -> str | None:
        size = message.file.size if message.file and message.file.size else 0
        if message.document:
            return f"document:{message.document.id}:{size}"
        if message.photo:
            return f"photo:{message.photo.id}:{size}"
        return None

    @classmethod
    def _media_ref(cls, message: Any) -> MediaRef | None:
        filename = cls._filename(message)
        if not filename:
            return None
        return MediaRef(
            message_id=message.id,
            filename=filename,
            kind=(
                MediaKind.MODEL
                if is_model_filename(filename)
                else MediaKind.ATTACHMENT
            ),
            caption=message.message.strip() if message.message else None,
            size=message.file.size if message.file and message.file.size else 0,
            media_identity=cls._media_identity(message),
        )

    async def collect_media(self, *, min_message_id: int = 0) -> list[MediaRef]:
        refs: list[MediaRef] = []
        async for message in self._client.iter_messages(
            self.entity,
            reverse=True,
            min_id=min_message_id,
        ):
            if ref := self._media_ref(message):
                refs.append(ref)
        return refs

    async def collect_media_by_ids(
        self, message_ids: tuple[int, ...]
    ) -> tuple[list[MediaRef], tuple[int, ...]]:
        """Collect only explicitly selected messages, reporting missing media."""
        messages = await self._client.get_messages(self.entity, ids=list(message_ids))
        if not isinstance(messages, list):
            messages = [messages]
        by_id = {
            message.id: message
            for message in messages
            if message is not None and getattr(message, "id", None) is not None
        }
        refs: list[MediaRef] = []
        unavailable: list[int] = []
        for message_id in message_ids:
            message = by_id.get(message_id)
            ref = self._media_ref(message) if message is not None else None
            if ref is None:
                unavailable.append(message_id)
            else:
                refs.append(ref)
        return refs, tuple(unavailable)

    async def download(
        self,
        ref: MediaRef,
        directory: Path,
        *,
        on_progress: Callable[[int, int], None] | None = None,
    ) -> Path:
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / f"{ref.message_id}_{safe_filename(ref.filename, 'media')}"
        for attempt in range(3):
            try:
                message = await self._client.get_messages(
                    self.entity, ids=ref.message_id
                )
                if not message:
                    raise RuntimeError(
                        f"Telegram message {ref.message_id} no longer exists"
                    )
                path = await self._fetch(message, target, on_progress=on_progress)
                log.info(
                    "Downloaded Telegram message %d to %s", ref.message_id, path.name
                )
                return path
            except FloodWaitError as error:
                if attempt == 2:
                    raise
                await asyncio.sleep(error.seconds)
            # Telethon renews a stale file reference inside its own downloader,
            # but the parallel path holds the reference for the whole file. The
            # next attempt refetches the message and so renews it.
            except FileReferenceExpiredError:
                if attempt == 2:
                    raise
                log.info(
                    "Telegram file reference for message %d expired; refetching",
                    ref.message_id,
                )
        raise RuntimeError(f"Telegram media {ref.message_id} could not be downloaded")

    async def _fetch(
        self,
        message: Any,
        target: Path,
        *,
        on_progress: Callable[[int, int], None] | None,
    ) -> Path:
        """Download one message's media, preferring the parallel path."""
        if plan := parallel_download.plan(message, self._downloads.size):
            location, dc_id, size = plan
            try:
                return await parallel_download.download(
                    self._downloads,
                    location=location,
                    dc_id=dc_id,
                    size=size,
                    target=target,
                    on_progress=on_progress,
                )
            except parallel_download.UnsupportedDownload as error:
                log.info(
                    "Falling back to a single-connection download for %s: %s",
                    target.name,
                    error,
                )

        downloaded = await self._client.download_media(
            message, file=str(target), progress_callback=on_progress
        )
        if not downloaded:
            raise RuntimeError(f"Telegram media {message.id} could not be downloaded")
        return Path(downloaded)

    def message_link(self, message_id: int) -> str | None:
        if self.channel_username:
            return f"https://t.me/{self.channel_username}/{message_id}"
        peer_id = str(abs(self.channel_id))
        if peer_id.startswith("100") and len(peer_id) > 3:
            return f"https://t.me/c/{peer_id[3:]}/{message_id}"
        return None
