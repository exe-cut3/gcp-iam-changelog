"""
generate_changelog.py - Orchestrator for the GCP IAM Changelog tool.

Usage:
    python generate_changelog.py [options]

Options:
    --dataset-path PATH   Path to cloned iam-dataset repo (default: ./iam-dataset)
    --output-dir DIR      Where to write JSON output       (default: ./docs)
    --days N              Days of history to process       (default: 30)
    --page-size N         Entries per page in output       (default: 100)
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import git

from diff_engine import ChangeEntry, diff_commits, _load_json_at_commit
from security_classifier import SecurityClassifier

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Serialisation helpers
# ---------------------------------------------------------------------------

def _entry_to_dict(entry: ChangeEntry, entry_id: str) -> dict[str, Any]:
    return {
        "id": entry_id,
        "date": entry.date,
        "commit": entry.commit,
        "dimension": entry.dimension,
        "change_type": entry.change_type,
        "permission": entry.permission,
        "role": entry.role,
        "service": entry.service,
        "method": entry.method,
        "severity": entry.severity,
        "tags": entry.tags,
        "details": entry.details,
    }


# ---------------------------------------------------------------------------
# Core processing
# ---------------------------------------------------------------------------

def _collect_commits(repo: git.Repo, since: datetime) -> list[git.Commit]:
    """Return commits more recent than *since*, ordered oldest-first."""
    commits = list(repo.iter_commits("HEAD", since=since.isoformat()))
    commits.reverse()  # oldest first
    return commits


def _load_tags_for_commit(repo: git.Repo, commit: git.Commit) -> dict | None:
    return _load_json_at_commit(repo, commit, "gcp/tags.json")


def process_dataset(
    dataset_path: Path,
    days: int,
) -> list[ChangeEntry]:
    """
    Walk the git history of *dataset_path* for the last *days* days,
    diff consecutive commit pairs, classify each entry, and return the
    combined list sorted newest-first.
    """
    repo = git.Repo(str(dataset_path))
    since = datetime.now(tz=timezone.utc) - timedelta(days=days)

    commits = _collect_commits(repo, since)
    if len(commits) < 2:
        logger.warning(
            "Only %d commit(s) found in the last %d days – nothing to diff.",
            len(commits),
            days,
        )
        return []

    logger.info("Processing %d commits spanning %d days", len(commits), days)

    all_entries: list[ChangeEntry] = []

    for i in range(1, len(commits)):
        prev_commit = commits[i - 1]
        curr_commit = commits[i]
        date_str = datetime.fromtimestamp(
            curr_commit.committed_date, tz=timezone.utc
        ).strftime("%Y-%m-%d")

        logger.debug(
            "Diffing %s → %s  (%s)",
            prev_commit.hexsha[:8],
            curr_commit.hexsha[:8],
            date_str,
        )

        try:
            entries = diff_commits(repo, prev_commit, curr_commit, date_str)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "Error diffing %s → %s: %s",
                prev_commit.hexsha[:8],
                curr_commit.hexsha[:8],
                exc,
            )
            continue

        # Classify using tags from the current commit
        tags_data = _load_tags_for_commit(repo, curr_commit)
        classifier = SecurityClassifier(tags_data)
        classifier.classify_all(entries)

        all_entries.extend(entries)

    # Sort newest-first
    all_entries.sort(key=lambda e: (e.date, e.commit), reverse=True)
    return all_entries


# ---------------------------------------------------------------------------
# Output construction
# ---------------------------------------------------------------------------

def _build_summary(entries: list[ChangeEntry]) -> dict[str, Any]:
    by_severity: dict[str, int] = {"CRITICAL": 0, "HIGH": 0, "MEDIUM": 0, "INFO": 0}
    by_dimension: dict[str, int] = {}
    new_services: set[str] = set()

    for e in entries:
        by_severity[e.severity] = by_severity.get(e.severity, 0) + 1
        by_dimension[e.dimension] = by_dimension.get(e.dimension, 0) + 1
        if e.change_type == "new_service" and e.service:
            new_services.add(e.service)

    return {
        "by_severity": by_severity,
        "by_dimension": by_dimension,
        "new_services": sorted(new_services),
    }


def write_output(
    entries: list[ChangeEntry],
    output_dir: Path,
    page_size: int,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)

    total = len(entries)
    pages = max(1, (total + page_size - 1) // page_size)
    generated_at = datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    summary = _build_summary(entries)

    # Write paginated files
    for page_num in range(1, pages + 1):
        start = (page_num - 1) * page_size
        end = start + page_size
        page_entries = entries[start:end]

        dicts = [
            _entry_to_dict(e, f"{e.date}-{(start + idx + 1):04d}")
            for idx, e in enumerate(page_entries)
        ]

        payload: dict[str, Any] = {
            "generated_at": generated_at,
            "total_entries": total,
            "pages": pages,
            "page": page_num,
            "page_size": page_size,
            "entries": dicts,
            "summary": summary,
        }

        filename = f"data-page-{page_num}.json"
        out_file = output_dir / filename
        with out_file.open("w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, ensure_ascii=False)
        logger.info("Wrote %s (%d entries)", out_file, len(dicts))

    # data-latest.json = page 1 (most recent entries)
    latest_src = output_dir / "data-page-1.json"
    latest_dst = output_dir / "data-latest.json"
    if latest_src.exists():
        latest_dst.write_bytes(latest_src.read_bytes())
        logger.info("Wrote %s (copy of page 1)", latest_dst)

    logger.info(
        "Done. %d entries across %d page(s). Summary: %s",
        total,
        pages,
        summary["by_severity"],
    )


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate GCP IAM Changelog from iam-dataset git history."
    )
    parser.add_argument(
        "--dataset-path",
        default="./iam-dataset",
        help="Path to cloned iam-dataset repository (default: ./iam-dataset)",
    )
    parser.add_argument(
        "--output-dir",
        default="./docs",
        help="Directory to write JSON output files (default: ./docs)",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=30,
        help="Number of days of history to process (default: 30)",
    )
    parser.add_argument(
        "--page-size",
        type=int,
        default=100,
        help="Number of entries per output page (default: 100)",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    dataset_path = Path(args.dataset_path).resolve()
    output_dir = Path(args.output_dir).resolve()

    if not dataset_path.is_dir():
        logger.error("Dataset path does not exist or is not a directory: %s", dataset_path)
        return 1

    try:
        entries = process_dataset(dataset_path, args.days)
    except git.InvalidGitRepositoryError:
        logger.error("Not a git repository: %s", dataset_path)
        return 1
    except Exception as exc:  # noqa: BLE001
        logger.exception("Unexpected error during processing: %s", exc)
        return 1

    write_output(entries, output_dir, args.page_size)
    return 0


if __name__ == "__main__":
    sys.exit(main())
