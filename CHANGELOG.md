# Changelog

## Unreleased

- Matrix jobs: config jobs named `<job>/<entry>` form a group, and the plan writes one output per group with the entries that run, for a matrix built with `fromJSON`. `jevci check` verifies the guard, the matrix, its fallback list and the plan job's outputs.
- `workspacePaths(packages)` and `readWorkspace()` build job paths from the workspace dependency graph (pnpm, npm, Yarn, Bun), so a job's paths follow its packages' dependencies.
- `jevci replay` leaves out commits the workflow's `push` path filter never runs on, instead of counting them as skipped CI.
- Large changes no longer crash the plan: files over 1 MiB are not read as text (their edits count as structural), and file contents are read in bounded batches.
- Evidence is gathered once per plan: removed text is deduplicated across files and the test files are searched in parallel (`jev.concurrency`). On a 65-package monorepo this cut planning time 3.2x (p90 19 s to 5 s) with byte-identical Jev requests.
- In a partial clone (`filter: blob:none`), the test files searched for evidence are fetched in one request instead of one request each.
- Fix: with `noop: false`, every edit counted as structural, so Jev was never asked.

## 0.1.0

First release.

- `jevci plan` decides which CI jobs a commit range needs. It applies rules first: forced events, markers and labels; `full`, `ignore` and per-job paths; comment- and format-only edits; structural changes, including removed or renamed exports. After that, Jev may drop a job the rules would run, one file at a time, when it is confident the change cannot make that job fail.
- Plans can be written as `text`, `json`, `markdown`, `github` (step outputs and run summary) or `dotenv`. The range and event are read from GitHub Actions (push, pull request, merge queue, schedule, manual) and GitLab CI.
- `jevci check` verifies that every configured job reads the plan and that no job name has drifted. `jevci init` drafts a config from a workflow.
- `jevci replay` estimates the job minutes saved over recent history. `jevci eval` scores the judge on labelled cases at several thresholds.
- Extension points:
  - `noop.normalizers` for more file types;
  - per-job `threshold`, `owns` and `formatting`;
  - `jev.context`;
  - any `judge` with an `ask()` method.
- Jev providers: Vercel AI Gateway, TypeSafe, OpenRouter, or replay from cache.
- A built-in Jev client (cache, concurrency, retries). The only dependencies are `jiti`, `yaml` and `typescript`; jevci parses scripts with its own TypeScript 6, so projects on any TypeScript version, including 7, get comment-only detection.
