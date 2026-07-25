from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager


class SignatureGate:
    """Serializes concurrent imports that share a duplicate-detection signature.

    Duplicate detection matches a candidate against *completed* tracker records.
    Two identical models imported at the same time would each find no completed
    match and each create an Alexandria model. Holding a signature for the whole
    import makes the second one wait, so by the time it looks the first is
    completed and it deduplicates against that model instead.
    """

    def __init__(self) -> None:
        self._holders: dict[tuple[str, str], asyncio.Event] = {}

    def is_held(self, kind: str, signature: str) -> bool:
        return (kind, signature) in self._holders

    @asynccontextmanager
    async def hold(self, kind: str, signature: str) -> AsyncIterator[bool]:
        """Hold `signature` until the block exits, yielding whether it was contended."""
        key = (kind, signature)
        contended = False
        while (holder := self._holders.get(key)) is not None:
            contended = True
            await holder.wait()

        # Nothing is awaited between the miss above and this claim, so on the
        # single event-loop thread the two together are atomic and no second
        # waiter can claim the same signature.
        released = asyncio.Event()
        self._holders[key] = released
        try:
            yield contended
        finally:
            del self._holders[key]
            released.set()
