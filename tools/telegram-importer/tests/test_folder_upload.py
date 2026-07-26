from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from alexandria_telegram_importer.folder_upload import (
    FolderUploader,
    build_upload_paths,
    discover,
    dispose,
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

    # chain[0] is the staging root itself; the release folder follows it.
    assert [level.get("artist") for level in folder.chain] == [None, "Foo Studios", None]
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


def test_should_move_a_successful_folder_under_uploaded_preserving_its_path(
    tmp_path,
) -> None:
    release = tmp_path / "002501-dragon-set"
    release.mkdir()
    (release / "metadata.json").write_text(
        json.dumps({"artist": "Foo"}), encoding="utf-8"
    )
    folder = make_folder(release / "knight", models=["knight.zip"])

    destination = dispose(folder, tmp_path, "uploaded", {"modelId": "abc"})

    assert destination == tmp_path / "uploaded" / "002501-dragon-set" / "knight"
    assert (destination / "models" / "knight.zip").is_file()
    assert not folder.exists()


def test_should_copy_container_metadata_alongside_a_disposed_folder(tmp_path) -> None:
    release = tmp_path / "002501-dragon-set"
    release.mkdir()
    (release / "metadata.json").write_text(
        json.dumps({"artist": "Foo"}), encoding="utf-8"
    )
    make_folder(release / "knight", models=["knight.zip"])
    make_folder(release / "mage", models=["mage.zip"])

    dispose(release / "knight", tmp_path, "uploaded", {"modelId": "abc"})

    copied = tmp_path / "uploaded" / "002501-dragon-set" / "metadata.json"
    assert json.loads(copied.read_text(encoding="utf-8"))["artist"] == "Foo"
    assert (release / "metadata.json").is_file()
    assert (release / "mage").is_dir()


def test_should_write_the_result_into_the_disposed_metadata(tmp_path) -> None:
    folder = make_folder(
        tmp_path / "002501-dragon", models=["a.zip"], metadata={"modelName": "Dragon"}
    )

    destination = dispose(folder, tmp_path, "uploaded", {"modelId": "abc"})
    payload = json.loads((destination / "metadata.json").read_text(encoding="utf-8"))

    assert payload["result"] == {"modelId": "abc"}
    assert payload["modelName"] == "Dragon"


def test_should_write_a_result_even_when_the_folder_had_no_metadata(tmp_path) -> None:
    folder = make_folder(tmp_path / "002501-dragon", models=["a.zip"])

    destination = dispose(folder, tmp_path, "failed", {"error": "boom"})
    payload = json.loads((destination / "metadata.json").read_text(encoding="utf-8"))

    assert payload["result"] == {"error": "boom"}


def test_should_remove_a_container_left_with_no_model_folders(tmp_path) -> None:
    release = tmp_path / "002501-dragon-set"
    release.mkdir()
    (release / "metadata.json").write_text(json.dumps({}), encoding="utf-8")
    make_folder(release / "knight", models=["knight.zip"])

    dispose(release / "knight", tmp_path, "uploaded", {"modelId": "abc"})

    assert not release.exists()


def test_should_keep_a_container_that_still_holds_model_folders(tmp_path) -> None:
    release = tmp_path / "002501-dragon-set"
    release.mkdir()
    make_folder(release / "knight", models=["knight.zip"])
    make_folder(release / "mage", models=["mage.zip"])

    dispose(release / "knight", tmp_path, "uploaded", {"modelId": "abc"})

    assert release.is_dir()
    assert (release / "mage").is_dir()


def test_should_suffix_a_disposal_that_collides_with_an_earlier_one(tmp_path) -> None:
    (tmp_path / "uploaded" / "dragon").mkdir(parents=True)
    folder = make_folder(tmp_path / "dragon", models=["a.zip"])

    destination = dispose(folder, tmp_path, "uploaded", {"modelId": "abc"})

    assert destination.name == "dragon-2"


class FakeAlexandria:
    def __init__(self) -> None:
        self.uploads: list[tuple[str, bool]] = []
        self.appended: list[str] = []
        self.commits: list[dict] = []
        self.session = {"id": "session-1", "status": "ready_for_review"}
        self.fail_commit = False

    async def upload_file(self, path, upload_name, *, multipart, on_progress=None):
        self.uploads.append((upload_name, multipart))
        return f"upload-{len(self.uploads)}"

    async def complete_upload(self, upload_ids, *, multipart):
        return "session-1"

    async def abort_uploads(self, upload_ids) -> None:
        return None

    async def get_session(self, session_id):
        return self.session

    async def wait_for_session(self, session_id, statuses, **kwargs):
        return {"id": session_id, "status": min(statuses), "modelId": "model-1"}

    async def append_files(self, session_id, paths, upload_names):
        self.appended.extend(upload_names)
        return self.session

    async def commit(self, session_id, *, model_name, description=None, **extra):
        if self.fail_commit:
            raise RuntimeError("commit exploded")
        self.commits.append(
            {"modelName": model_name, "description": description, **extra}
        )
        return "model-1"


async def test_should_upload_a_folder_and_return_its_model_id(tmp_path) -> None:
    make_folder(
        tmp_path / "002501-dragon",
        models=["dragon.7z"],
        images=["render.jpg"],
        metadata={"modelName": "Dragon", "artist": "Foo", "tags": ["dragon"]},
    )
    alexandria = FakeAlexandria()
    [folder], _ = discover(tmp_path)

    model_id = await FolderUploader(
        alexandria=alexandria, work_root=tmp_path / "work"
    ).upload(folder)

    assert model_id == "model-1"
    assert alexandria.uploads == [("dragon.7z", False)]
    assert alexandria.appended == ["render.jpg"]
    assert alexandria.commits[0]["modelName"] == "Dragon"
    assert alexandria.commits[0]["batch_metadata"]["artist"] == "Foo"
    assert alexandria.commits[0]["batch_metadata"]["tags"] == ["dragon"]


async def test_should_append_container_images_to_every_model_beneath_it(
    tmp_path,
) -> None:
    release = tmp_path / "002501-dragon-set"
    release.mkdir()
    (release / "images").mkdir()
    (release / "images" / "group.jpg").write_bytes(b"group")
    make_folder(release / "knight", models=["knight.zip"], images=["knight.jpg"])
    alexandria = FakeAlexandria()
    [folder], _ = discover(tmp_path)

    await FolderUploader(alexandria=alexandria, work_root=tmp_path / "work").upload(
        folder
    )

    assert sorted(alexandria.appended) == ["group.jpg", "knight.jpg"]


async def test_should_prefer_a_models_own_image_over_a_container_duplicate(
    tmp_path,
) -> None:
    release = tmp_path / "002501-dragon-set"
    release.mkdir()
    (release / "images").mkdir()
    (release / "images" / "render.jpg").write_bytes(b"container")
    make_folder(release / "knight", models=["knight.zip"], images=["render.jpg"])
    alexandria = FakeAlexandria()
    [folder], _ = discover(tmp_path)

    uploader = FolderUploader(alexandria=alexandria, work_root=tmp_path / "work")
    assert [path.read_bytes() for path in uploader.image_paths(folder)] == [
        b"render.jpg"
    ]


async def test_should_upload_a_split_set_as_multipart(tmp_path) -> None:
    make_folder(
        tmp_path / "002501-dragon", models=["dragon.part1.rar", "dragon.part2.rar"]
    )
    alexandria = FakeAlexandria()
    [folder], _ = discover(tmp_path)

    await FolderUploader(alexandria=alexandria, work_root=tmp_path / "work").upload(
        folder
    )

    assert alexandria.uploads == [
        ("dragon.part1.rar", True),
        ("dragon.part2.rar", True),
    ]


async def test_should_move_a_folder_to_failed_when_upload_raises(tmp_path) -> None:
    make_folder(tmp_path / "002501-dragon", models=["dragon.7z"])
    alexandria = FakeAlexandria()
    alexandria.fail_commit = True

    uploader = FolderUploader(alexandria=alexandria, work_root=tmp_path / "work")
    outcomes = await uploader.run(tmp_path)

    assert outcomes["failed"] == 1
    assert (tmp_path / "failed" / "002501-dragon").is_dir()
    payload = json.loads(
        (tmp_path / "failed" / "002501-dragon" / "metadata.json").read_text(
            encoding="utf-8"
        ),
    )
    assert "commit exploded" in payload["result"]["error"]


async def test_should_move_an_ambiguous_folder_to_failed_without_uploading(
    tmp_path,
) -> None:
    release = make_folder(tmp_path / "002501-dragon-set", models=["leftover.zip"])
    make_folder(release / "knight", models=["knight.zip"])
    alexandria = FakeAlexandria()

    outcomes = await FolderUploader(
        alexandria=alexandria, work_root=tmp_path / "work"
    ).run(tmp_path)

    assert outcomes["failed"] == 1
    assert alexandria.uploads == []
    assert (tmp_path / "failed" / "002501-dragon-set").is_dir()


async def test_should_keep_going_after_one_folder_fails(tmp_path) -> None:
    make_folder(tmp_path / "002501-broken", models=[])
    make_folder(tmp_path / "002502-good", models=["good.7z"])
    alexandria = FakeAlexandria()

    outcomes = await FolderUploader(
        alexandria=alexandria, work_root=tmp_path / "work"
    ).run(tmp_path)

    assert outcomes == {"completed": 1, "failed": 1}
    assert (tmp_path / "uploaded" / "002502-good").is_dir()
    assert (tmp_path / "failed" / "002501-broken").is_dir()


# --- Data-loss regressions ------------------------------------------------


def test_should_not_prune_a_container_that_still_holds_unsplit_files(tmp_path) -> None:
    """The half-finished split is the whole point of the pause; pruning it is data loss."""
    release = tmp_path / "002501-release"
    make_folder(release / "knight", models=["knight.7z"])
    (release / "mage").mkdir()
    (release / "mage" / "mage.part1.rar").write_bytes(b"unfinished split")
    (release / "images").mkdir()
    (release / "images" / "group.png").write_bytes(b"group render")

    dispose(release / "knight", tmp_path, "uploaded", {"modelId": "m1"})

    assert (release / "mage" / "mage.part1.rar").is_file()
    assert (release / "images" / "group.png").is_file()


def test_should_not_prune_a_container_holding_a_loose_archive(tmp_path) -> None:
    release = tmp_path / "002501-release"
    make_folder(release / "knight", models=["knight.7z"])
    (release / "leftover.7z").write_bytes(b"loose archive")

    dispose(release / "knight", tmp_path, "uploaded", {"modelId": "m1"})

    assert (release / "leftover.7z").is_file()


def test_should_still_prune_a_genuinely_empty_container(tmp_path) -> None:
    release = tmp_path / "002501-release"
    release.mkdir()
    (release / "metadata.json").write_text("{}", encoding="utf-8")
    make_folder(release / "knight", models=["knight.7z"])

    dispose(release / "knight", tmp_path, "uploaded", {"modelId": "m1"})

    assert not release.exists()


def test_should_never_overwrite_a_metadata_file_it_could_not_parse(tmp_path) -> None:
    folder = make_folder(tmp_path / "002501-dragon", models=["a.zip"])
    original = '{"modelName": "Hand Typed", "artist": "Me",}'
    (folder / "metadata.json").write_text(original, encoding="utf-8")

    destination = dispose(folder, tmp_path, "failed", {"error": "bad json"})

    assert (destination / "metadata.json").read_text(encoding="utf-8") == original
    assert json.loads((destination / "result.json").read_text(encoding="utf-8")) == {
        "error": "bad json",
    }


def test_should_fail_a_model_folder_whose_own_metadata_is_unparseable(tmp_path) -> None:
    folder = make_folder(tmp_path / "002501-dragon", models=["a.zip"])
    (folder / "metadata.json").write_text('{"modelName": "X",}', encoding="utf-8")

    found, ambiguous = discover(tmp_path)

    assert found == []
    assert [path.name for path, _ in ambiguous] == ["002501-dragon"]
    assert "metadata.json" in ambiguous[0][1]


def test_should_merge_metadata_from_the_staging_root_downward(tmp_path) -> None:
    (tmp_path / "metadata.json").write_text(
        json.dumps({"artist": "Channel Artist", "tags": ["channel"]}), encoding="utf-8"
    )
    (tmp_path / "images").mkdir()
    (tmp_path / "images" / "banner.png").write_bytes(b"banner")
    make_folder(tmp_path / "002501-dragon", models=["a.zip"], images=["own.png"])

    [folder], ambiguous = discover(tmp_path)

    assert ambiguous == []
    assert folder.metadata["artist"] == "Channel Artist"
    assert folder.metadata["tags"] == ["channel"]
    assert sorted(p.name for p in folder.image_dirs[0].iterdir()) == ["banner.png"]


def test_should_not_walk_a_nested_directory_named_failed_or_uploaded(tmp_path) -> None:
    release = tmp_path / "002501-release"
    release.mkdir()
    make_folder(release / "knight", models=["knight.7z"])
    make_folder(release / "failed" / "old", models=["old.7z"])
    make_folder(release / "uploaded" / "done", models=["done.7z"])

    found, _ = discover(tmp_path)

    assert [folder.path.name for folder in found] == ["knight"]


async def test_should_append_images_in_one_batched_request(tmp_path) -> None:
    make_folder(
        tmp_path / "002501-dragon",
        models=["a.7z"],
        images=["one.jpg", "two.jpg", "three.jpg"],
    )
    alexandria = FakeAlexandria()
    calls: list[int] = []
    original = alexandria.append_files

    async def counting(session_id, paths, upload_names):
        calls.append(len(paths))
        return await original(session_id, paths, upload_names)

    alexandria.append_files = counting
    [folder], _ = discover(tmp_path)

    await FolderUploader(alexandria=alexandria, work_root=tmp_path / "w").upload(folder)

    assert calls == [3]
    assert sorted(alexandria.appended) == ["one.jpg", "three.jpg", "two.jpg"]


def test_should_describe_what_a_dry_run_would_upload(tmp_path) -> None:
    from alexandria_telegram_importer.folder_upload import describe_staging

    make_folder(tmp_path / "002501-dragon", models=["dragon.7z"], images=["a.jpg"])
    release = make_folder(tmp_path / "002502-broken", models=["x.zip"])
    make_folder(release / "child", models=["y.zip"])

    report = describe_staging(tmp_path)

    assert "as_is  002501-dragon -> 'dragon' (1 image(s))" in report
    assert "FAIL   002502-broken" in report
    assert "1 model folder(s) would be uploaded" in report
