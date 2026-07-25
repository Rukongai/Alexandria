from __future__ import annotations

import asyncio

import pytest

from alexandria_telegram_importer.concurrency import SignatureGate


async def test_should_serialize_holders_of_the_same_signature() -> None:
    gate = SignatureGate()
    order: list[str] = []
    started = asyncio.Event()

    async def first() -> None:
        async with gate.hold("telegram_signature", "shared") as contended:
            assert contended is False
            started.set()
            order.append("first-enter")
            await asyncio.sleep(0.02)
            order.append("first-exit")

    async def second() -> None:
        await started.wait()
        async with gate.hold("telegram_signature", "shared") as contended:
            assert contended is True
            order.append("second-enter")

    await asyncio.gather(first(), second())

    assert order == ["first-enter", "first-exit", "second-enter"]


async def test_should_not_block_across_different_signatures_or_kinds() -> None:
    gate = SignatureGate()
    entered = 0

    async def hold(kind: str, signature: str) -> None:
        nonlocal entered
        async with gate.hold(kind, signature):
            entered += 1
            await asyncio.sleep(0.02)

    await asyncio.wait_for(
        asyncio.gather(
            hold("telegram_signature", "a"),
            hold("telegram_signature", "b"),
            hold("content_signature", "a"),
        ),
        timeout=1,
    )

    assert entered == 3


async def test_should_release_a_hold_when_its_body_raises() -> None:
    gate = SignatureGate()

    with pytest.raises(RuntimeError, match="import failed"):
        async with gate.hold("content_signature", "shared"):
            raise RuntimeError("import failed")

    assert gate.is_held("content_signature", "shared") is False
    async with gate.hold("content_signature", "shared") as contended:
        assert contended is False
