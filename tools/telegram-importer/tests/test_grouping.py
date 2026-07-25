from __future__ import annotations

import pytest
from alexandria_telegram_importer.grouping import (
    build_bundles,
    is_model_filename,
    partition_logical_models,
    validate_logical_model,
)
from alexandria_telegram_importer.models import MediaKind


def test_should_attach_images_to_the_next_model_in_channel_order(media_ref) -> None:
    refs = [
        media_ref(1, "first-preview.jpg", kind=MediaKind.ATTACHMENT),
        media_ref(2, "first-detail.png", kind=MediaKind.ATTACHMENT),
        media_ref(3, "first-model.zip"),
        media_ref(4, "related-model.stl"),
        media_ref(5, "next-preview.jpg", kind=MediaKind.ATTACHMENT),
        media_ref(6, "next-detail.webp", kind=MediaKind.ATTACHMENT),
        media_ref(7, "next-model.rar"),
        media_ref(8, "trailing-image.jpg", kind=MediaKind.ATTACHMENT),
    ]

    bundles = list(build_bundles(-100123, refs))

    assert len(bundles) == 2
    assert [ref.message_id for ref in bundles[0].attachments] == [1, 2]
    assert [model.first_message_id for model in bundles[0].models] == [3, 4]
    assert [ref.message_id for ref in bundles[1].attachments] == [5, 6]
    assert [model.first_message_id for model in bundles[1].models] == [7]


def test_should_keep_multiple_consecutive_models_in_one_related_bundle(
    media_ref,
) -> None:
    refs = [
        media_ref(10, "preview.jpg", kind=MediaKind.ATTACHMENT),
        media_ref(11, "primary.zip"),
        media_ref(12, "variant-a.3mf"),
        media_ref(13, "variant-b.stl"),
    ]

    [bundle] = list(build_bundles(42, refs))

    assert [ref.message_id for ref in bundle.attachments] == [10]
    assert [model.logical_filename for model in bundle.models] == [
        "primary.zip",
        "variant-a.3mf",
        "variant-b.stl",
    ]
    assert all(not model.multipart for model in bundle.models)


@pytest.mark.parametrize(
    ("filenames", "expected_logical_filename"),
    [
        (("dragon.z01", "dragon.z02", "dragon.zip"), "dragon.zip"),
        (("mech.zip.001", "mech.zip.002", "mech.zip.003"), "mech.zip"),
        (("castle.part1.rar", "castle.part2.rar", "castle.part3.rar"), "castle.rar"),
    ],
)
def test_should_group_supported_split_archives_into_one_logical_model(
    media_ref,
    filenames: tuple[str, ...],
    expected_logical_filename: str,
) -> None:
    refs = [
        media_ref(index, filename) for index, filename in enumerate(filenames, start=20)
    ]

    [model] = partition_logical_models(-100456, refs)

    assert model.multipart is True
    assert model.logical_filename == expected_logical_filename
    assert tuple(part.filename for part in model.parts) == filenames
    validate_logical_model(model)


@pytest.mark.parametrize(
    "filenames",
    [
        ("dragon.z01", "dragon.z03", "dragon.zip"),
        ("dragon.z01", "dragon.zip", "DRAGON.ZIP"),
        ("mech.zip.001", "mech.zip.003"),
        ("castle.part01.rar", "castle.part2.rar"),
        ("castle.part1.rar", "castle.part3.rar"),
    ],
)
def test_should_reject_malformed_split_sets_before_download(
    media_ref, filenames
) -> None:
    refs = [
        media_ref(index, filename) for index, filename in enumerate(filenames, start=40)
    ]

    [model] = partition_logical_models(-100456, refs)

    with pytest.raises(ValueError):
        validate_logical_model(model)


def test_should_reject_more_than_one_hundred_split_members_before_download(
    media_ref,
) -> None:
    refs = [media_ref(index, f"huge.part{index}.rar") for index in range(1, 102)]

    [model] = partition_logical_models(-100456, refs)

    with pytest.raises(ValueError, match="between 2 and 100"):
        validate_logical_model(model)


def test_should_reject_an_oversized_member_before_download(media_ref) -> None:
    [model] = partition_logical_models(
        -100456,
        [media_ref(1, "huge.zip", size=5 * 1024 * 1024 * 1024 + 1)],
    )

    with pytest.raises(ValueError, match="5 GB"):
        validate_logical_model(model)


@pytest.mark.parametrize(
    "filename",
    [
        "MODEL.ZIP",
        "sculpt.tar.gz",
        "mesh.3MF",
        "assembly.step",
        "classic.z01",
        "numbered.zip.001",
        "volume.part01.rar",
    ],
)
def test_should_classify_supported_model_media_by_filename(filename: str) -> None:
    assert is_model_filename(filename) is True


@pytest.mark.parametrize(
    "filename",
    [
        "preview.jpg",
        "instructions.pdf",
        "archive.zip.backup",
        "volume.part1",
        "numbered.zip.0001",
    ],
)
def test_should_classify_unrecognized_media_as_loose_attachments(filename: str) -> None:
    assert is_model_filename(filename) is False
