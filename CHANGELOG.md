# Changelog

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
