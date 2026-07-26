from __future__ import annotations

import json
from pathlib import Path

import pytest

from alexandria_telegram_importer.grouping import build_bundles
from alexandria_telegram_importer.models import MediaKind
from alexandria_telegram_importer.staging import (
    BundleStager,
    bundle_description,
    bundle_folder_name,
    bundle_key,
    unique_child,
)


def test_should_produce_a_stable_bundle_key_regardless_of_discovery_order(
    media_ref,
) -> None:
    forward = list(
        build_bundles(
            -100987654,
            [media_ref(2501, "dragon-knight.zip"), media_ref(2502, "dragon-mage.zip")],
        ),
    )
    reverse = list(
        build_bundles(
            -100987654,
            [media_ref(2502, "dragon-mage.zip"), media_ref(2501, "dragon-knight.zip")],
        ),
    )

    assert bundle_key(-100987654, forward[0]) == bundle_key(-100987654, reverse[0])


def test_should_produce_different_bundle_keys_for_different_channels(media_ref) -> None:
    [bundle] = build_bundles(-100987654, [media_ref(2501, "dragon.zip")])

    assert bundle_key(-100987654, bundle) != bundle_key(-100111111, bundle)


def test_should_not_collide_with_the_logical_model_key_for_the_same_messages(
    media_ref,
) -> None:
    [bundle] = build_bundles(-100987654, [media_ref(2501, "dragon.zip")])

    assert bundle_key(-100987654, bundle) != bundle.models[0].key


def test_should_name_a_folder_from_the_first_message_id_and_first_model(
    media_ref,
) -> None:
    [bundle] = build_bundles(
        -100987654,
        [
            media_ref(2499, "render.jpg", kind=MediaKind.ATTACHMENT),
            media_ref(2501, "Dragon_Knight Set.zip"),
            media_ref(2502, "dragon-mage.zip"),
        ],
    )

    assert bundle_folder_name(bundle) == "002501-dragon-knight-set"


def test_should_slug_awkward_model_names_into_a_safe_folder_name(media_ref) -> None:
    [bundle] = build_bundles(-100987654, [media_ref(7, "Dragon!!! (v2) [final].zip")])

    assert bundle_folder_name(bundle) == "000007-dragon-v2-final"


def test_should_fall_back_to_the_message_id_when_a_name_slugs_to_nothing(
    media_ref,
) -> None:
    [bundle] = build_bundles(-100987654, [media_ref(7, "!!!.zip")])

    assert bundle_folder_name(bundle) == "000007"


class FakeTelegram:
    """Stands in for TelegramSource: writes a file named after the ref."""

    def __init__(self, channel_id: int = -100987654, username: str | None = "chan"):
        self.channel_id = channel_id
        self.channel_username = username
        self.downloaded: list[str] = []
        self.fail_on: set[str] = set()

    async def download(self, ref, directory, *, on_progress=None) -> Path:
        if ref.filename in self.fail_on:
            raise RuntimeError(f"boom: {ref.filename}")
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / f"{ref.message_id}_{ref.filename}"
        target.write_bytes(ref.filename.encode())
        self.downloaded.append(ref.filename)
        return target

    def message_link(self, message_id: int) -> str | None:
        if self.channel_username:
            return f"https://t.me/{self.channel_username}/{message_id}"
        return None


def test_should_suffix_a_colliding_folder_name(tmp_path) -> None:
    (tmp_path / "dragon").mkdir()
    (tmp_path / "dragon-2").mkdir()

    assert unique_child(tmp_path, "dragon").name == "dragon-3"
    assert unique_child(tmp_path, "wizard").name == "wizard"


async def test_should_stage_models_and_images_into_their_subfolders(
    tmp_path, media_ref
) -> None:
    [bundle] = build_bundles(
        -100987654,
        [
            media_ref(2499, "render.jpg", kind=MediaKind.ATTACHMENT),
            media_ref(2501, "dragon-knight.zip"),
            media_ref(2502, "dragon-mage.zip"),
        ],
    )
    telegram = FakeTelegram()

    folder = await BundleStager(telegram=telegram, root=tmp_path).stage(bundle)

    assert folder.name == "002501-dragon-knight"
    assert sorted(p.name for p in (folder / "models").iterdir()) == [
        "dragon-knight.zip",
        "dragon-mage.zip",
    ]
    assert [p.name for p in (folder / "images").iterdir()] == ["render.jpg"]
    assert (folder / "models" / "dragon-knight.zip").read_bytes() == b"dragon-knight.zip"


async def test_should_always_create_both_subfolders_even_when_empty(
    tmp_path, media_ref
) -> None:
    [bundle] = build_bundles(-100987654, [media_ref(2501, "dragon.zip")])

    folder = await BundleStager(telegram=FakeTelegram(), root=tmp_path).stage(bundle)

    assert (folder / "models").is_dir()
    assert (folder / "images").is_dir()


async def test_should_write_metadata_with_source_provenance(tmp_path, media_ref) -> None:
    [bundle] = build_bundles(
        -100987654,
        [
            media_ref(2499, "render.jpg", kind=MediaKind.ATTACHMENT, caption="Dragons!"),
            media_ref(2501, "dragon-knight.zip"),
            media_ref(2502, "dragon-mage.zip"),
        ],
    )

    folder = await BundleStager(telegram=FakeTelegram(), root=tmp_path).stage(bundle)
    payload = json.loads((folder / "metadata.json").read_text(encoding="utf-8"))

    assert payload["schemaVersion"] == 1
    assert payload["modelName"] == "dragon knight"
    assert "Dragons!" in payload["description"]
    assert "https://t.me/chan/2501" in payload["description"]
    assert payload["result"] is None
    assert payload["source"]["channelId"] == -100987654
    assert payload["source"]["modelMessageIds"] == [2501, 2502]
    assert payload["source"]["attachmentMessageIds"] == [2499]
    assert payload["source"]["bundleKey"] == bundle_key(-100987654, bundle)


async def test_should_suffix_colliding_filenames_within_a_folder(
    tmp_path, media_ref
) -> None:
    [bundle] = build_bundles(
        -100987654,
        [media_ref(2501, "dragon.zip"), media_ref(2502, "dragon.zip")],
    )

    folder = await BundleStager(telegram=FakeTelegram(), root=tmp_path).stage(bundle)

    assert sorted(p.name for p in (folder / "models").iterdir()) == [
        "dragon-2.zip",
        "dragon.zip",
    ]


async def test_should_remove_the_partial_folder_when_staging_fails(
    tmp_path, media_ref
) -> None:
    [bundle] = build_bundles(
        -100987654,
        [media_ref(2501, "dragon-knight.zip"), media_ref(2502, "dragon-mage.zip")],
    )
    telegram = FakeTelegram()
    telegram.fail_on = {"dragon-mage.zip"}

    with pytest.raises(RuntimeError, match="boom"):
        await BundleStager(telegram=telegram, root=tmp_path).stage(bundle)

    assert list(tmp_path.iterdir()) == []


def test_should_compose_a_bundle_description_from_every_caption(media_ref) -> None:
    [bundle] = build_bundles(
        -100987654,
        [
            media_ref(2499, "a.jpg", kind=MediaKind.ATTACHMENT, caption="First"),
            media_ref(2500, "b.jpg", kind=MediaKind.ATTACHMENT, caption="First"),
            media_ref(2501, "dragon.zip", caption="Second"),
        ],
    )

    description = bundle_description(FakeTelegram(), bundle)

    assert description.count("First") == 1
    assert "Second" in description
    assert "model message(s): 2501" in description
    assert description.endswith("https://t.me/chan/2501")
