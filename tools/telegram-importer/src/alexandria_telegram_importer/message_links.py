from __future__ import annotations

from collections import OrderedDict
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit


TELEGRAM_LINK_HOSTS = {"t.me", "telegram.me"}


@dataclass(frozen=True, slots=True)
class MessageLink:
    channel: str | int
    message_id: int
    url: str


def parse_message_link(value: str) -> MessageLink:
    """Parse one public or private Telegram message URL."""
    url = value.strip()
    parsed = urlsplit(url)
    host = (parsed.hostname or "").casefold().removeprefix("www.")
    if parsed.scheme.casefold() not in {"http", "https"} or host not in TELEGRAM_LINK_HOSTS:
        raise ValueError("expected an http(s) t.me message link")

    parts = [part for part in parsed.path.split("/") if part]
    if parts and parts[0].casefold() == "s":
        parts = parts[1:]

    if len(parts) == 3 and parts[0].casefold() == "c":
        channel_text, message_text = parts[1:]
        if not channel_text.isdigit() or int(channel_text) < 1:
            raise ValueError("private channel ID must be a positive integer")
        channel: str | int = int(f"-100{channel_text}")
    elif len(parts) == 2:
        channel_text, message_text = parts
        if not channel_text or channel_text.startswith("+"):
            raise ValueError("public message link must contain a channel username")
        channel = f"@{channel_text.casefold()}"
    else:
        raise ValueError(
            "expected t.me/<channel>/<message> or t.me/c/<channel>/<message>"
        )

    if not message_text.isdigit() or int(message_text) < 1:
        raise ValueError("message ID must be a positive integer")
    return MessageLink(channel=channel, message_id=int(message_text), url=url)


def read_message_links(path: Path) -> tuple[MessageLink, ...]:
    """Read, validate, and deduplicate a newline-delimited message-link file."""
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except OSError as error:
        raise ValueError(f"could not read {path}: {error}") from error

    links: list[MessageLink] = []
    seen: set[tuple[str | int, int]] = set()
    for line_number, line in enumerate(lines, start=1):
        value = line.strip()
        if not value or value.startswith("#"):
            continue
        try:
            link = parse_message_link(value)
        except ValueError as error:
            raise ValueError(f"{path}:{line_number}: {error}") from error
        identity = (link.channel, link.message_id)
        if identity not in seen:
            seen.add(identity)
            links.append(link)

    if not links:
        raise ValueError(f"{path} contains no Telegram message links")
    return tuple(links)


def group_message_links(
    links: Iterable[MessageLink],
) -> tuple[tuple[str | int, tuple[int, ...]], ...]:
    """Group linked IDs by channel while preserving first-seen channel order."""
    grouped: OrderedDict[str | int, list[int]] = OrderedDict()
    for link in links:
        grouped.setdefault(link.channel, []).append(link.message_id)
    return tuple(
        (channel, tuple(sorted(message_ids)))
        for channel, message_ids in grouped.items()
    )
