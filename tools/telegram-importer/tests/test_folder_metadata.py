from __future__ import annotations

import json

from alexandria_telegram_importer.folder_metadata import (
    SCHEMA_VERSION,
    batch_metadata,
    merge_chain,
    model_name_from_folder,
    read_metadata,
    write_metadata,
)


def test_should_return_none_for_a_folder_without_metadata(tmp_path) -> None:
    assert read_metadata(tmp_path) is None


def test_should_return_none_for_unparseable_or_non_object_metadata(tmp_path) -> None:
    (tmp_path / "metadata.json").write_text("{not json", encoding="utf-8")
    assert read_metadata(tmp_path) is None

    (tmp_path / "metadata.json").write_text("[1, 2]", encoding="utf-8")
    assert read_metadata(tmp_path) is None


def test_should_round_trip_metadata_preserving_unknown_keys(tmp_path) -> None:
    write_metadata(tmp_path, {"modelName": "Dragon", "somethingNew": {"a": 1}})

    loaded = read_metadata(tmp_path)

    assert loaded["modelName"] == "Dragon"
    assert loaded["somethingNew"] == {"a": 1}
    assert loaded["schemaVersion"] == SCHEMA_VERSION
    assert json.loads((tmp_path / "metadata.json").read_text(encoding="utf-8"))


def test_should_let_the_nearest_level_win_for_scalars() -> None:
    merged = merge_chain(
        [
            {"artist": "Release Studios", "description": "release blurb"},
            {"artist": "Child Studios"},
        ],
    )

    assert merged["artist"] == "Child Studios"
    assert merged["description"] == "release blurb"


def test_should_merge_tags_across_levels_without_duplicates() -> None:
    merged = merge_chain(
        [{"tags": ["dragon", "fantasy"]}, {"tags": ["knight", "dragon"]}],
    )

    assert merged["tags"] == ["dragon", "fantasy", "knight"]


def test_should_merge_metadata_and_options_key_by_key() -> None:
    merged = merge_chain(
        [
            {
                "metadata": {"scale": "32mm", "license": "personal"},
                "options": {"markNsfw": True},
            },
            {"metadata": {"license": "commercial"}},
        ],
    )

    assert merged["metadata"] == {"scale": "32mm", "license": "commercial"}
    assert merged["options"] == {"markNsfw": True}


def test_should_never_inherit_model_name_from_a_container() -> None:
    merged = merge_chain([{"modelName": "Dragon Set"}, {"artist": "Foo"}])

    assert "modelName" not in merged


def test_should_take_model_name_from_the_leaf_level_only() -> None:
    merged = merge_chain([{"modelName": "Dragon Set"}, {"modelName": "Dragon Knight"}])

    assert merged["modelName"] == "Dragon Knight"


def test_should_ignore_null_values_when_merging() -> None:
    merged = merge_chain([{"artist": "Foo"}, {"artist": None}])

    assert merged["artist"] == "Foo"


def test_should_derive_a_model_name_from_a_staged_folder_name() -> None:
    assert model_name_from_folder("002501-dragon-knight") == "dragon knight"
    assert model_name_from_folder("dragon_knight") == "dragon knight"
    assert model_name_from_folder("123-abc") == "123 abc"


def test_should_strip_non_commit_keys_from_batch_metadata() -> None:
    payload = batch_metadata(
        {
            "modelName": "Dragon",
            "tags": ["a"],
            "schemaVersion": 1,
            "source": {"channelId": -100},
            "result": None,
            "artist": None,
        },
    )

    assert payload == {"modelName": "Dragon", "tags": ["a"]}


def test_should_report_an_error_for_an_unparseable_metadata_file(tmp_path) -> None:
    from alexandria_telegram_importer.folder_metadata import metadata_error

    assert metadata_error(tmp_path) is None

    (tmp_path / "metadata.json").write_text('{"a": 1,}', encoding="utf-8")
    error = metadata_error(tmp_path)
    assert error is not None
    assert "metadata.json" in error

    (tmp_path / "metadata.json").write_text("[1, 2]", encoding="utf-8")
    assert "JSON object" in (metadata_error(tmp_path) or "")

    (tmp_path / "metadata.json").write_text('{"a": 1}', encoding="utf-8")
    assert metadata_error(tmp_path) is None


def test_should_only_strip_the_six_digit_staging_prefix() -> None:
    assert model_name_from_folder("002501-dragon-knight") == "dragon knight"
    assert model_name_from_folder("2001-a-space-odyssey") == "2001 a space odyssey"
    assert model_name_from_folder("12345678-thing") == "12345678 thing"
