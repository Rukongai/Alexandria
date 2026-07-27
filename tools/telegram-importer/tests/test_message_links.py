from pathlib import Path

import pytest

from alexandria_telegram_importer.message_links import (
    MessageLink,
    group_message_links,
    parse_message_link,
    read_message_links,
)


@pytest.mark.parametrize(
    ("url", "channel", "message_id"),
    [
        ("https://t.me/ModelChannel/123", "@modelchannel", 123),
        ("https://t.me/s/ModelChannel/456?single", "@modelchannel", 456),
        ("http://www.telegram.me/ModelChannel/789", "@modelchannel", 789),
        ("https://t.me/c/2050123456/321", -1002050123456, 321),
    ],
)
def test_should_parse_supported_message_links(
    url: str,
    channel: str | int,
    message_id: int,
) -> None:
    assert parse_message_link(url) == MessageLink(channel, message_id, url)


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/channel/123",
        "https://t.me/channel",
        "https://t.me/+invite/123",
        "https://t.me/c/not-a-channel/123",
        "https://t.me/channel/not-a-message",
        "https://t.me/c/123/456/789",
    ],
)
def test_should_reject_non_message_links(url: str) -> None:
    with pytest.raises(ValueError):
        parse_message_link(url)


def test_should_read_comments_blank_lines_and_deduplicate_links(tmp_path: Path) -> None:
    path = tmp_path / "links.txt"
    path.write_text(
        "# selected models\n"
        "\n"
        "https://t.me/chan/30\n"
        "https://t.me/chan/10\n"
        "https://t.me/chan/30\n"
        "https://t.me/c/123/20\n",
        encoding="utf-8",
    )

    links = read_message_links(path)

    assert links == (
        MessageLink("@chan", 30, "https://t.me/chan/30"),
        MessageLink("@chan", 10, "https://t.me/chan/10"),
        MessageLink(-100123, 20, "https://t.me/c/123/20"),
    )
    assert group_message_links(links) == (
        ("@chan", (10, 30)),
        (-100123, (20,)),
    )


def test_should_report_the_line_containing_an_invalid_link(tmp_path: Path) -> None:
    path = tmp_path / "links.txt"
    path.write_text("\nhttps://example.com/nope\n", encoding="utf-8")

    with pytest.raises(ValueError, match=r"links\.txt:2"):
        read_message_links(path)


def test_should_reject_an_empty_link_file(tmp_path: Path) -> None:
    path = tmp_path / "links.txt"
    path.write_text("# nothing selected\n", encoding="utf-8")

    with pytest.raises(ValueError, match="contains no Telegram message links"):
        read_message_links(path)
