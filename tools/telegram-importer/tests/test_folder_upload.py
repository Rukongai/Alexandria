from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from alexandria_telegram_importer.folder_upload import (
    build_upload_paths,
    discover,
    plan_models_dir,
)


def make_folder(path: Path, *, models=None, images=(), metadata=None) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    if models is not None:
        (path / "models").mkdir(exist_ok=True)
        for name in models:
            (path / "models" / name).write_bytes(name.encode())
    if images:
        (path / "images").mkdir(exist_ok=True)
        for name in images:
            (path / "images" / name).write_bytes(name.encode())
    if metadata is not None:
        (path / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
    return path


def test_should_discover_a_single_model_folder(tmp_path) -> None:
    make_folder(tmp_path / "002501-dragon", models=["dragon.zip"])

    found, ambiguous = discover(tmp_path)

    assert [folder.path.name for folder in found] == ["002501-dragon"]
    assert ambiguous == []


def test_should_recurse_into_a_container_of_model_folders(tmp_path) -> None:
    release = tmp_path / "002501-dragon-set"
    release.mkdir()
    make_folder(release / "knight", models=["knight.zip"])
    make_folder(release / "mage", models=["mage.zip"])

    found, ambiguous = discover(tmp_path)

    assert sorted(folder.path.name for folder in found) == ["knight", "mage"]
    assert ambiguous == []


def test_should_flag_a_parent_that_has_both_models_and_child_model_folders(
    tmp_path,
) -> None:
    release = make_folder(tmp_path / "002501-dragon-set", models=["leftover.zip"])
    make_folder(release / "knight", models=["knight.zip"])

    found, ambiguous = discover(tmp_path)

    assert found == []
    assert [path.name for path, _ in ambiguous] == ["002501-dragon-set"]
    assert "models/" in ambiguous[0][1]


def test_should_skip_the_uploaded_and_failed_directories(tmp_path) -> None:
    make_folder(tmp_path / "pending", models=["a.zip"])
    make_folder(tmp_path / "uploaded" / "done", models=["b.zip"])
    make_folder(tmp_path / "failed" / "broken", models=["c.zip"])

    found, ambiguous = discover(tmp_path)

    assert [folder.path.name for folder in found] == ["pending"]
    assert ambiguous == []


def test_should_build_the_inheritance_chain_from_root_to_leaf(tmp_path) -> None:
    release = tmp_path / "002501-dragon-set"
    release.mkdir()
    (release / "metadata.json").write_text(
        json.dumps({"artist": "Foo Studios", "tags": ["dragon"]}), encoding="utf-8"
    )
    make_folder(
        release / "knight", models=["knight.zip"], metadata={"modelName": "Knight"}
    )

    [folder], _ = discover(tmp_path)

    assert folder.chain[0]["artist"] == "Foo Studios"
    assert folder.chain[-1]["modelName"] == "Knight"
    assert folder.metadata["artist"] == "Foo Studios"
    assert folder.metadata["tags"] == ["dragon"]
    assert folder.metadata["modelName"] == "Knight"


def test_should_collect_container_image_directories(tmp_path) -> None:
    release = tmp_path / "002501-dragon-set"
    release.mkdir()
    (release / "images").mkdir()
    (release / "images" / "group.jpg").write_bytes(b"group")
    make_folder(release / "knight", models=["knight.zip"], images=["knight.jpg"])

    [folder], _ = discover(tmp_path)

    assert [path.name for path in folder.container_image_dirs] == ["images"]
    assert folder.container_image_dirs[0].parent.name == "002501-dragon-set"


def test_should_name_a_model_from_its_folder_when_metadata_is_absent(tmp_path) -> None:
    make_folder(tmp_path / "002501-dragon-knight", models=["a.zip"])

    [folder], _ = discover(tmp_path)

    assert folder.model_name == "dragon knight"


def test_should_prefer_an_explicit_model_name_over_the_folder_name(tmp_path) -> None:
    make_folder(
        tmp_path / "002501-dragon", models=["a.zip"], metadata={"modelName": "Real Name"}
    )

    [folder], _ = discover(tmp_path)

    assert folder.model_name == "Real Name"


def test_should_ignore_a_directory_with_neither_models_nor_subfolders(tmp_path) -> None:
    (tmp_path / "empty").mkdir()
    (tmp_path / "empty" / "notes.txt").write_text("hello", encoding="utf-8")

    found, ambiguous = discover(tmp_path)

    assert found == []
    assert ambiguous == []


def models_dir(tmp_path: Path, names, subdir_files=()) -> Path:
    target = tmp_path / "models"
    target.mkdir(parents=True, exist_ok=True)
    for name in names:
        (target / name).write_bytes(name.encode())
    for relative in subdir_files:
        path = target / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(relative.encode())
    return target


def test_should_upload_a_lone_archive_as_is(tmp_path) -> None:
    plan = plan_models_dir(models_dir(tmp_path, ["dragon.7z"]))

    assert plan.kind == "as_is"
    assert [path.name for path in plan.paths] == ["dragon.7z"]


def test_should_detect_a_rar_split_set_in_part_order(tmp_path) -> None:
    plan = plan_models_dir(
        models_dir(tmp_path, ["dragon.part2.rar", "dragon.part1.rar"]),
    )

    assert plan.kind == "split"
    assert [path.name for path in plan.paths] == [
        "dragon.part1.rar",
        "dragon.part2.rar",
    ]


def test_should_detect_a_classic_zip_split_set(tmp_path) -> None:
    plan = plan_models_dir(models_dir(tmp_path, ["dragon.z01", "dragon.zip"]))

    assert plan.kind == "split"
    assert [path.name for path in plan.paths] == ["dragon.z01", "dragon.zip"]


def test_should_detect_a_numbered_zip_split_set(tmp_path) -> None:
    plan = plan_models_dir(
        models_dir(tmp_path, ["dragon.zip.001", "dragon.zip.002"]),
    )

    assert plan.kind == "split"


def test_should_zip_an_incomplete_split_set_rather_than_guessing(tmp_path) -> None:
    plan = plan_models_dir(
        models_dir(tmp_path, ["dragon.part1.rar", "dragon.part3.rar"]),
    )

    assert plan.kind == "zip"


def test_should_zip_a_set_that_mixes_two_base_names(tmp_path) -> None:
    plan = plan_models_dir(
        models_dir(tmp_path, ["dragon.part1.rar", "wizard.part2.rar"]),
    )

    assert plan.kind == "zip"


def test_should_zip_an_archive_that_sits_beside_another_file(tmp_path) -> None:
    plan = plan_models_dir(models_dir(tmp_path, ["dragon.7z", "readme.txt"]))

    assert plan.kind == "zip"


def test_should_zip_loose_model_files(tmp_path) -> None:
    plan = plan_models_dir(models_dir(tmp_path, ["knight.stl", "base.stl"]))

    assert plan.kind == "zip"


def test_should_zip_a_lone_subdirectory(tmp_path) -> None:
    plan = plan_models_dir(models_dir(tmp_path, [], subdir_files=["parts/knight.stl"]))

    assert plan.kind == "zip"


def test_should_reject_an_empty_or_missing_models_directory(tmp_path) -> None:
    with pytest.raises(ValueError, match="empty"):
        plan_models_dir(models_dir(tmp_path, []))

    with pytest.raises(ValueError, match="missing"):
        plan_models_dir(tmp_path / "absent")


def test_should_build_a_zip_preserving_paths_relative_to_models(tmp_path) -> None:
    source = models_dir(tmp_path, ["knight.stl"], subdir_files=["parts/base.stl"])
    work = tmp_path / "work"
    work.mkdir()

    paths, multipart = build_upload_paths(
        plan_models_dir(source), work, "Dragon Knight"
    )

    assert multipart is False
    assert len(paths) == 1
    assert paths[0].name == "Dragon Knight.zip"
    with zipfile.ZipFile(paths[0]) as archive:
        assert sorted(archive.namelist()) == ["knight.stl", "parts/base.stl"]


def test_should_pass_an_as_is_archive_through_without_repacking(tmp_path) -> None:
    source = models_dir(tmp_path, ["dragon.7z"])
    work = tmp_path / "work"
    work.mkdir()

    paths, multipart = build_upload_paths(plan_models_dir(source), work, "Dragon")

    assert multipart is False
    assert paths == (source / "dragon.7z",)
    assert paths[0].read_bytes() == b"dragon.7z"


def test_should_report_a_split_set_as_multipart(tmp_path) -> None:
    source = models_dir(tmp_path, ["dragon.part1.rar", "dragon.part2.rar"])
    work = tmp_path / "work"
    work.mkdir()

    paths, multipart = build_upload_paths(plan_models_dir(source), work, "Dragon")

    assert multipart is True
    assert [path.name for path in paths] == [
        "dragon.part1.rar",
        "dragon.part2.rar",
    ]
