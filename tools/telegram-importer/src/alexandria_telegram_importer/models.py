from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class MediaKind(StrEnum):
    MODEL = "model"
    ATTACHMENT = "attachment"


@dataclass(frozen=True, slots=True)
class MediaRef:
    message_id: int
    filename: str
    kind: MediaKind
    caption: str | None = None
    size: int = 0


@dataclass(frozen=True, slots=True)
class LogicalModel:
    key: str
    parts: tuple[MediaRef, ...]
    logical_filename: str
    multipart: bool

    @property
    def first_message_id(self) -> int:
        return min(part.message_id for part in self.parts)


@dataclass(frozen=True, slots=True)
class ImportBundle:
    attachments: tuple[MediaRef, ...]
    models: tuple[LogicalModel, ...]
