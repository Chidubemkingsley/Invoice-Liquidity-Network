#!/usr/bin/env python3
"""Create the 125 main-repo hard issues from issues.csv + template.md.

Works around a bug in `gh issue-bulk-create` v1.3.0: when a template's
front matter omits the `assignees` key, the tool sends `"assignees": null`
to the GitHub API, which GitHub rejects with HTTP 422 ("nil is not an
array") for every single issue. This script renders the same template
directly and calls `gh api` itself, explicitly sending `"assignees": []`.

Usage:
    python3 create_issues.py --dry-run      # render and print, no API calls
    python3 create_issues.py                # actually create the issues

Idempotent: successfully-created issues are recorded in created.json next
to this script, keyed by title, and are skipped on re-run so an interrupted
run can be safely resumed.
"""
import argparse
import csv
import json
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
TEMPLATE_PATH = HERE / "template.md"
CSV_PATH = HERE / "issues.csv"
STATE_PATH = HERE / "created.json"
REPO = "Invoice-Liquidity-Network/Invoice-Liquidity-Network"

COMPLEXITY_BLOCK = (
    "High (200 points) — this batch intentionally excludes trivial/medium-complexity "
    "work; see the ILN Stellar Wave contribution guide before picking this up."
)


def render(template: str, row: dict) -> str:
    out = template
    for key, value in row.items():
        out = out.replace("{{" + key + "}}", value)
    return out


def split_frontmatter(rendered: str):
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", rendered, re.DOTALL)
    if not m:
        raise ValueError("rendered template missing front matter")
    frontmatter, body = m.group(1), m.group(2).strip()
    title_m = re.search(r'^title:\s*"(.*)"\s*$', frontmatter, re.MULTILINE)
    labels_m = re.search(r'^labels:\s*"(.*)"\s*$', frontmatter, re.MULTILINE)
    if not title_m or not labels_m:
        raise ValueError(f"could not parse frontmatter:\n{frontmatter}")
    title = title_m.group(1)
    labels = [l.strip() for l in labels_m.group(1).split(",") if l.strip()]
    return title, labels, body


def load_state():
    if STATE_PATH.exists():
        return json.loads(STATE_PATH.read_text())
    return {}


def save_state(state):
    STATE_PATH.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")


def create_issue(title, labels, body):
    payload = json.dumps({
        "title": title,
        "body": body,
        "labels": labels,
        "assignees": [],
    })
    result = subprocess.run(
        ["gh", "api", f"repos/{REPO}/issues", "--input", "-"],
        input=payload,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"gh api failed: {result.stderr.strip()}")
    return json.loads(result.stdout)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="render only, no API calls")
    parser.add_argument("--limit", type=int, default=None, help="only process the first N rows (for spot-checking)")
    args = parser.parse_args()

    template = TEMPLATE_PATH.read_text()
    with open(CSV_PATH, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if args.limit:
        rows = rows[: args.limit]

    state = load_state()
    created, skipped, failed = 0, 0, 0

    for i, row in enumerate(rows, start=1):
        rendered = render(template, row)
        title, labels, body = split_frontmatter(rendered)
        body_with_complexity = body  # complexity block is static text already in template

        if title in state:
            skipped += 1
            print(f"[{i}/{len(rows)}] SKIP (already created as #{state[title]['number']}): {title}")
            continue

        if args.dry_run:
            print(f"[{i}/{len(rows)}] WOULD CREATE: {title}  labels={labels}")
            continue

        try:
            resp = create_issue(title, labels, body_with_complexity)
            state[title] = {"number": resp["number"], "url": resp["html_url"]}
            save_state(state)
            created += 1
            print(f"[{i}/{len(rows)}] CREATED #{resp['number']}: {title}")
            time.sleep(0.5)
        except Exception as e:
            failed += 1
            print(f"[{i}/{len(rows)}] FAILED: {title}\n    {e}", file=sys.stderr)

    print(f"\nDone. created={created} skipped={skipped} failed={failed} total={len(rows)}")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
