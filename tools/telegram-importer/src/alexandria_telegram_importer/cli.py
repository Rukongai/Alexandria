from __future__ import annotations

import argparse
import asyncio
import getpass
import logging
import os
from pathlib import Path

from dotenv import load_dotenv

from .alexandria import AlexandriaClient
from .importer import ChannelImporter, describe_plan
from .telegram_source import TelegramSource
from .tracker import ImportTracker


def _data_dir() -> Path:
    if root := os.getenv("XDG_DATA_HOME"):
        return Path(root) / "alexandria-telegram-importer"
    return Path.home() / ".local" / "share" / "alexandria-telegram-importer"


def _concurrency(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(
            f"concurrency must be an integer, got {value!r}"
        ) from error
    if parsed < 1:
        raise argparse.ArgumentTypeError("concurrency must be at least 1")
    return parsed


def _channel(value: str | None) -> str | int | None:
    if value is None or not value.strip():
        return None
    stripped = value.strip()
    return int(stripped) if stripped.lstrip("-").isdigit() else stripped


def parser() -> argparse.ArgumentParser:
    default_dir = _data_dir()
    result = argparse.ArgumentParser(
        description="Import a Telegram channel's model media into Alexandria",
    )
    result.add_argument("--channel", default=os.getenv("TELEGRAM_CHANNEL"))
    result.add_argument(
        "--alexandria-url", default=os.getenv("ALEXANDRIA_URL", "http://localhost:3000")
    )
    result.add_argument(
        "--library-id", default=os.getenv("ALEXANDRIA_LIBRARY_ID") or None
    )
    result.add_argument(
        "--allow-insecure-http",
        action="store_true",
        help="Allow plaintext HTTP to a non-loopback Alexandria host",
    )
    result.add_argument(
        "--session",
        type=Path,
        default=Path(os.getenv("TELEGRAM_SESSION_PATH", default_dir / "telegram")),
    )
    result.add_argument(
        "--state",
        type=Path,
        default=Path(
            os.getenv("TELEGRAM_IMPORT_STATE_PATH", default_dir / "state.sqlite3")
        ),
    )
    result.add_argument("--from-message-id", type=int, default=0)
    result.add_argument("--poll-interval", type=float, default=2.0)
    result.add_argument(
        "--concurrency",
        type=_concurrency,
        default=os.getenv("TELEGRAM_IMPORT_CONCURRENCY", "1"),
        help=(
            "Number of Telegram models to import at the same time. Higher values "
            "trade disk use and Telegram rate-limit risk for throughput (default 1)"
        ),
    )
    result.add_argument(
        "--dry-run",
        action="store_true",
        help="Show grouping without downloading or uploading",
    )
    result.add_argument("--verbose", action="store_true")
    return result


async def run(args: argparse.Namespace) -> int:
    api_id_text = os.getenv("TELEGRAM_API_ID") or os.getenv("API_ID")
    api_hash = os.getenv("TELEGRAM_API_HASH") or os.getenv("API_HASH")
    if not api_id_text or not api_hash:
        raise SystemExit("TELEGRAM_API_ID and TELEGRAM_API_HASH are required")
    try:
        api_id = int(api_id_text)
    except ValueError as error:
        raise SystemExit("TELEGRAM_API_ID must be an integer") from error

    telegram = TelegramSource(
        api_id=api_id,
        api_hash=api_hash,
        session_path=args.session,
        phone=os.getenv("TELEGRAM_PHONE") or os.getenv("PHONE") or None,
    )
    alexandria: AlexandriaClient | None = None
    tracker: ImportTracker | None = None
    try:
        await telegram.connect(_channel(args.channel))
        refs = await telegram.collect_media(min_message_id=args.from_message_id)
        if args.dry_run:
            print(describe_plan(telegram.channel_id, refs))
            return 0

        email = os.getenv("ALEXANDRIA_EMAIL") or input("Alexandria email: ").strip()
        password = os.getenv("ALEXANDRIA_PASSWORD") or getpass.getpass(
            "Alexandria password: "
        )
        alexandria = AlexandriaClient(
            args.alexandria_url,
            library_id=args.library_id,
            poll_interval=args.poll_interval,
            allow_insecure_http=args.allow_insecure_http,
        )
        await alexandria.login(email, password)
        tracker = ImportTracker(args.state)
        counts = await ChannelImporter(
            telegram=telegram,
            alexandria=alexandria,
            tracker=tracker,
            work_root=args.state.parent / f"{args.state.name}.work",
            concurrency=args.concurrency,
        ).run(refs)
        print(
            "Import state: "
            + ", ".join(f"{status}={count}" for status, count in sorted(counts.items()))
        )
        return (
            1 if counts.get("failed", 0) or counts.get("completion_uncertain", 0) else 0
        )
    finally:
        if tracker:
            tracker.close()
        if alexandria:
            await alexandria.close()
        await telegram.close()


def main() -> None:
    load_dotenv()
    args = parser().parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    raise SystemExit(asyncio.run(run(args)))


if __name__ == "__main__":
    main()
