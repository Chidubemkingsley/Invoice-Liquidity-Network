#!/usr/bin/env python3
"""Bulk-create GitHub issues from a mustache-style Markdown template + CSV data.

The template's YAML front matter must define `title` and `labels` (and
optionally `assignees`), e.g.:

    ---
    title: "{{title}}"
    labels: "{{labels}}"
    ---

    {{body}}

Each CSV column becomes a `{{column_name}}` substitution variable; the CSV
header row must match the template's variables. CSV parsing uses Python's
stdlib `csv` module, which correctly handles RFC 4180 quoting (embedded
commas, newlines, and escaped quotes inside a field) -- a plain shell
`IFS=,` loop does not, and will silently corrupt any multi-line or
comma-containing field.

Calls `gh api repos/<owner>/<repo>/issues` directly per issue rather than
going through `gh issue create` or the `gh-issue-bulk-create` extension:
`gh issue create` doesn't accept a pre-rendered body via stdin cleanly for
this many fields, and gh-issue-bulk-create v1.3.0 has a bug where an empty
or omitted `assignees` front-matter value is sent to the GitHub API as
`null` instead of `[]`, which GitHub rejects with HTTP 422 for every issue.

Defaults to a dry run (prints what would be created, makes no API calls).
Pass --live to actually create issues. Progress is tracked in a JSON state
file keyed by title, so an interrupted --live run can be safely re-run.

Usage:
    python3 scripts/bulk-create-issues.py --template t.md --csv d.csv
    python3 scripts/bulk-create-issues.py --template t.md --csv d.csv --live
    python3 scripts/bulk-create-issues.py --template t.md --csv d.csv --live --repo owner/repo
"""
import argparse
import csv
import json
import re
import subprocess
import sys
import time
from pathlib import Path


def render(template: str, row: dict) -> str:
    out = template
    for key, value in row.items():
        out = out.replace("{{" + key + "}}", value)
    return out


def split_frontmatter(rendered: str):
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", rendered, re.DOTALL)
    if not m:
        raise ValueError("rendered template missing '---' front matter delimiters")
    frontmatter, body = m.group(1), m.group(2).strip()

    title_m = re.search(r'^title:\s*"(.*)"\s*$', frontmatter, re.MULTILINE)
    if not title_m:
        raise ValueError(f"could not parse title from front matter:\n{frontmatter}")
    title = title_m.group(1)

    labels_m = re.search(r'^labels:\s*"(.*)"\s*$', frontmatter, re.MULTILINE)
    labels = [l.strip() for l in labels_m.group(1).split(",") if l.strip()] if labels_m else []

    assignees_m = re.search(r'^assignees:\s*"(.*)"\s*$', frontmatter, re.MULTILINE)
    assignees = [a.strip() for a in assignees_m.group(1).split(",") if a.strip()] if assignees_m else []

    return title, labels, assignees, body


def get_current_repo() -> str:
    result = subprocess.run(
        ["gh", "repo", "view", "--json", "owner,name"],
        capture_output=True, text=True, check=True,
    )
    info = json.loads(result.stdout)
    return f"{info['owner']['login']}/{info['name']}"


def create_issue(repo: str, title: str, labels: list, assignees: list, body: str) -> dict:
    payload = json.dumps({
        "title": title,
        "body": body,
        "labels": labels,
        "assignees": assignees,  # always a real list (never omitted/None) -> never serializes to null
    })
    result = subprocess.run(
        ["gh", "api", f"repos/{repo}/issues", "--input", "-"],
        input=payload, capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    return json.loads(result.stdout)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--template", required=True, help="path to the Markdown template file")
    ap.add_argument("--csv", required=True, help="path to the CSV data file")
    ap.add_argument("--repo", default=None, help="owner/repo to create issues in; defaults to the current repo")
    ap.add_argument("--state-file", default=None, help="progress-tracking JSON file; defaults to created.<csv-name>.json next to --csv")
    ap.add_argument("--live", action="store_true", help="actually create issues via the GitHub API (default: dry-run preview only)")
    ap.add_argument("--limit", type=int, default=None, help="only process the first N rows")
    ap.add_argument("--delay", type=float, default=0.5, help="seconds to sleep between creates (default: 0.5)")
    args = ap.parse_args()

    template_path = Path(args.template)
    csv_path = Path(args.csv)
    state_path = Path(args.state_file) if args.state_file else csv_path.with_name(f"created.{csv_path.stem}.json")
    repo = args.repo or get_current_repo()

    template = template_path.read_text()
    with open(csv_path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if args.limit:
        rows = rows[: args.limit]

    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    created, skipped, failed = 0, 0, 0

    for i, row in enumerate(rows, start=1):
        rendered = render(template, row)
        title, labels, assignees, body = split_frontmatter(rendered)

        if title in state:
            skipped += 1
            print(f"[{i}/{len(rows)}] SKIP (already created as #{state[title]['number']}): {title}")
            continue

        if not args.live:
            print(f"[{i}/{len(rows)}] WOULD CREATE in {repo}: {title}  labels={labels} assignees={assignees}")
            continue

        try:
            resp = create_issue(repo, title, labels, assignees, body)
            state[title] = {"number": resp["number"], "url": resp["html_url"]}
            state_path.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")
            created += 1
            print(f"[{i}/{len(rows)}] CREATED #{resp['number']}: {title}")
            time.sleep(args.delay)
        except Exception as e:
            failed += 1
            print(f"[{i}/{len(rows)}] FAILED: {title}\n    {e}", file=sys.stderr)

    print(f"\nDone. repo={repo} live={args.live} created={created} skipped={skipped} failed={failed} total={len(rows)}")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
