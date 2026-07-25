from __future__ import annotations

from alexandria_telegram_importer.grouping import build_bundles
from alexandria_telegram_importer.models import MediaKind
from alexandria_telegram_importer.staging import bundle_folder_name, bundle_key


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
