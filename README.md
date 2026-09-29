# jevci

Run the CI jobs a change needs, not the whole pipeline. A typo fix in the docs skips CI, a reworded button label runs the linter, and a change to a type runs the type checker, not the 7-minute build.

jevci reads the commit range, applies rules you can predict, and only then asks [TypeSafe](https://typesafe.ai)'s Jev model whether a remaining edit could make a job fail. Jev can only remove jobs the rules would otherwise run, and only when it is confident. If jevci fails, times out or has no API key, every job the rules chose runs anyway.

## How a plan is made

For each changed file, in order:

1. **Forced.** A `schedule` or manual run, a `[ci full]` marker in a commit message or pull request body, or a `ci:full` label runs every job. A missing base commit also runs every job (a new branch, a force-push, a shallow clone).
2. **Paths.** A file matching `full` (lockfiles, CI config, schema) runs every job. A file matching `ignore` (docs) runs nothing. Otherwise the file counts for the jobs whose `paths` include it.
3. **No-ops.** When a file changed only comments or formatting, only the jobs that read formatting (`formatting: true`, e.g. the linter) run. Scripts are compared as TypeScript syntax trees. Comments that tools read, such as `@ts-expect-error`, `eslint-disable` and `#__PURE__`, count as real changes.
4. **Structure.** An added, deleted, renamed or binary file runs all of its jobs. So does an edit that removes or renames an export, since that breaks importers a one-file judgement cannot see.
5. **Jev.** For each remaining edit and each job that may be dropped, Jev estimates P(this change can make the job fail). It sees the diff, the job's `checks` description, and the test files that still contain text the edit removed. A job is dropped for the file when P is below `threshold`.

A job runs if any file needs it, and `minimumJobs` run whenever any real change exists. So skipping CI entirely is always a decision made by the rules.

## Install

```sh
npm install --save-dev @hazymoon/jevci
npx jevci init        # jevci.config.ts from your workflow's jobs, plus the wiring to paste
```

This requires Node.js 22+ or Bun. jevci parses scripts with its own TypeScript 6 dependency, so it works whatever TypeScript version the project uses, including TypeScript 7.

## Quick start

1. Run `npx jevci init`. It writes `jevci.config.ts` with one entry per job in your GitHub workflow.
2. Describe each job in `checks`: what it verifies, and what it cannot see. Narrow its `paths`.
3. Add a `plan` job to the workflow and gate each job on it (see below).
4. Run `npx jevci check` to confirm that every configured job reads the plan and that no job is missing on either side.
5. Run `npx jevci replay --last 100` to see what the rules alone would have saved on your recent history. Add `--jev` to include Jev.

```ts
// jevci.config.ts
import { defineConfig } from '@hazymoon/jevci';

export default defineConfig({
    full: ['package.json', 'package-lock.json', '.github/**', 'tsconfig*.json'],
    ignore: ['**/*.md', 'docs/**'],
    minimumJobs: ['lint'],
    jobs: {
        lint: {
            checks: 'ESLint with stylistic rules over the whole repository.',
            downgrade: false,
            formatting: true,
        },
        typecheck: {
            checks: 'tsc --noEmit over src/. It does not check the contents of plain strings or comments.',
            paths: ['src/**', 'types/**'],
        },
        test: {
            checks: 'Vitest unit tests in tests/, which import src/ and assert rendered text.',
            paths: ['src/**', 'tests/**'],
            owns: ['tests/**'],
        },
        build: {
            checks: 'Vite production build of src/. It fails on missing imports or compile errors, never on copy.',
            paths: ['src/**', 'public/**'],
        },
    },
});
```

## GitHub Actions

```yaml
jobs:
  plan:
    runs-on: ubuntu-latest
    outputs:
      jobs: ${{ steps.plan.outputs.jobs }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # the plan diffs against the merge base
          filter: blob:none # full history without every file's content; jevci fetches the blobs it reads in batches
      # Only jevci is installed; the project's dependencies are not needed to plan.
      - id: plan
        run: npx --yes @hazymoon/jevci plan --format github
        env:
          AI_GATEWAY_API_KEY: ${{ secrets.AI_GATEWAY_API_KEY }}

  test:
    needs: plan
    if: ${{ !cancelled() && (needs.plan.result != 'success' || fromJSON(needs.plan.outputs.jobs || '{}')['test']) }}
    runs-on: ubuntu-latest
    steps:
      # ...
```

With `--format github`, the plan job:

- writes the outputs `level` (`none`, `partial` or `full`), `jobs` (a JSON object of job id → boolean), `reason` and `fallback`, plus one output per matrix group (see below);
- adds a table of jobs and reasons to the run summary.

The guard above also runs the job whenever the plan job itself did not succeed. GitHub treats a job skipped by `if:` as passing, so required status checks still pass.

Pull request, push, merge queue, schedule and manual events are read from the event payload. Cache the answers directory between runs so a re-run never pays for the same question twice:

```yaml
      - uses: actions/cache@v4
        with:
          path: ~/.cache/jevci
          key: jevci-${{ github.sha }}
          restore-keys: jevci-
```

On a large repository, `filter: blob:none` keeps the plan job's checkout to seconds: history and trees arrive at once, and file contents only for the files jevci reads. jevci fetches those in batches (the changed files through `git diff`, the test files it searches for evidence in one request), where a plain read in a partial clone would fetch one file per request.

### Matrix jobs

A job-level `if:` cannot read `matrix`, so a matrix job is planned per entry through a group: name its jobs `<workflow job>/<entry>` in the config, and the plan writes an output named after the group with the entries that run, as a JSON array. The workflow builds the matrix from it:

```yaml
  plan:
    outputs:
      jobs: ${{ steps.plan.outputs.jobs }}
      test: ${{ steps.plan.outputs.test }}
    # ...

  test:
    needs: plan
    if: ${{ !cancelled() && (needs.plan.result != 'success' || needs.plan.outputs.test != '[]') }}
    strategy:
      matrix:
        shard: ${{ fromJSON(needs.plan.result == 'success' && needs.plan.outputs.test || '["api","web"]') }}
    runs-on: ubuntu-latest
    steps:
      # ...
```

```ts
jobs: {
    'test/api': { checks: 'Vitest tests of apps/api.', paths: ['apps/api/**', 'packages/**'] },
    'test/web': { checks: 'Vitest tests of apps/web.', paths: ['apps/web/**', 'packages/**'] },
},
```

The list after `||` is every entry, so a failed plan job runs them all. `jevci check` verifies the guard, that the matrix reads the group output, that the fallback list names every entry, and that the plan job forwards the output. In dotenv, `test/api` becomes `JEVCI_RUN_TEST_API`.

## Monorepos

A job that tests or builds some workspace packages can fail after a change in any package they depend on, directly or not. `workspacePaths` turns package names into `paths` from the workspace graph (`pnpm-workspace.yaml`, or `workspaces` in `package.json` for npm, Yarn and Bun), when the config loads:

```ts
import { defineConfig, readWorkspace, workspacePaths } from '@hazymoon/jevci';

const workspace = readWorkspace();
const tested = [...workspace.packages.values()].filter(pkg => pkg.scripts.includes('test')).map(pkg => pkg.name);

export default defineConfig({
    jobs: {
        'test/api': { checks: '...', paths: workspacePaths(['@acme/api'], { workspace }) },
        'test/rest': { checks: '...', paths: workspacePaths(tested.filter(name => name !== '@acme/api'), { workspace }) },
    },
});
```

Names may be globs (`@acme/*`, or `**` for every package); a name that matches no package is a config error, so a renamed package cannot silently empty a job's paths. The result covers the packages' directories only: add the root files the job reads (its CI config, shared tsconfig, files its tests open by path) yourself, or put them in `full`.

A test that reads another package's files by path is invisible to the dependency graph. When it reads only part of what changes there, a trigger keeps the job from running on every edit:

```ts
'test/admin-api': {
    checks: '...',
    paths: workspacePaths(['@acme/admin-api'], { workspace }),
    // Its parity test counts which procedures the front end calls.
    triggers: [{ files: ['apps/front/src/**'], pattern: /\b(api|queries)\.[\w.]+\(/ }],
},
```

## GitLab CI and other systems

In GitLab CI, jevci reads `CI_PIPELINE_SOURCE`, `CI_MERGE_REQUEST_DIFF_BASE_SHA`, `CI_COMMIT_BEFORE_SHA`, `CI_COMMIT_SHA`, and the merge request's labels and description. `--format dotenv` prints `JEVCI_LEVEL` and one `JEVCI_RUN_<JOB>=true|false` per job, ready for a `dotenv` report:

```yaml
plan:
  script: npx --yes @hazymoon/jevci plan --format dotenv > plan.env
  artifacts:
    reports:
      dotenv: plan.env

test:
  needs: [plan]
  script:
    - '[ "$JEVCI_RUN_TEST" = true ] || { echo "skipped by jevci"; exit 0; }'
    - npm test
```

Anywhere else, pass the range yourself (`jevci plan --base origin/main --head HEAD --format json`), or call the API.

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `jobs.<id>.checks` | required | What the job verifies and what it cannot observe. Jev judges by this text. |
| `jobs.<id>.paths` | `['**']` | Files whose changes can matter to the job. |
| `jobs.<id>.exclude` | `[]` | Removed from `paths`. |
| `jobs.<id>.owns` | `[]` | Files the job executes or reads directly (its tests, its config). A real change here runs the job without asking Jev. |
| `jobs.<id>.downgrade` | `true` | `false`: Jev never drops this job. |
| `jobs.<id>.formatting` | `false` | The job reads comments or formatting (a linter), so comment-only edits still run it. |
| `jobs.<id>.threshold` | `jev.threshold` | Per-job threshold. |
| `jobs.<id>.minutes` | none | Typical duration, for `replay` and summaries. |
| `jobs.<id>.triggers` | `[]` | `{ files, pattern? }` rules for files outside `paths` that the job still reads (a test that scans another package). A change there runs the job when an added or removed line matches `pattern`, or on any change without one. |
| `full` | `[]` | Globs that run every job. |
| `ignore` | `[]` | Globs no job reads. Added or edited files are dropped. Deleted or renamed ones still count, since a link may point at them. |
| `minimumJobs` | `[]` | Jobs that run on any real change. |
| `force.markers` / `labels` / `events` | `['[ci full]']` / `['ci:full']` / `['schedule', 'workflow_dispatch', 'web']` | What runs every job. |
| `noop.directives` | `DEFAULT_DIRECTIVES` | Comments that change tool behaviour; editing one is a real change. |
| `noop.normalizers` | `[]` | Extra file types for comment-only detection (see below). `noop: false` turns detection off. |
| `jev.threshold` | `0.2` | Keep a job when P(can fail) ≥ threshold. Lower is safer. |
| `jev.context` | none | A few sentences about the repository: framework, test style, code that runs at build time. |
| `jev.testFiles` | `['**/*.test.*', '**/*.spec.*', '**/__tests__/**', 'test/**', 'tests/**']` | Where to look for text an edit removes. |
| `jev.provider` | the first of gateway, typesafe, openrouter whose key is set | See "Providers". `jev: false` never asks. |
| `jev.maxFiles` / `maxDiffChars` / `maxTokens` / `timeoutSeconds` | `80` / `16000` / `400000` / `180` | Beyond these limits, the jobs the rules chose run. |
| `jev.cacheDir` / `concurrency` | `~/.cache/jevci` / `8` | Answer cache and parallel requests. |

Globs match whole paths, and `*` and `**` include dotfiles: `**` covers `.github/`.

### Writing `checks`

Jev judges a job by its description alone, so name what the job cannot observe. For example: "It does not check the contents of plain strings". Or: "Type-only changes cannot fail it: Vitest strips types". Or: "It never runs the code, except the /offline page it prerenders". Put facts about the whole repository in `jev.context`. Then run `jevci eval` on labelled cases before lowering the threshold.

### More file types

A normalizer returns the content with everything no job can observe removed, or `undefined` when it is unsure. Custom normalizers run before the built-in ones (scripts, Vue, JSON, HTML/SVG/XML, CSS):

```ts
import { parse } from 'yaml';

export default defineConfig({
    noop: {
        normalizers: [
            // Comments and layout drop out when YAML is compared by value.
            { files: ['**/*.{yml,yaml}'], normalize: text => JSON.stringify(parse(text)) },
        ],
    },
    jobs: { /* ... */ },
});
```

## Commands

| Command | Does |
| --- | --- |
| `jevci plan` | Prints the plan. `--format text\|json\|markdown\|github\|dotenv`, `--output plan.json`, `--no-jev`, `--base`, `--head`, `--event`, `--labels`. Always exits 0, and a failure inside jevci yields a plan that runs every job. |
| `jevci check` | Checks that every configured job needs the plan job and reads `needs.<plan>.outputs.jobs`, and that no job is missing from either side. Exits 1 on errors. |
| `jevci init` | Writes a starting config from the workflow's jobs. |
| `jevci replay` | Plans the last `--last N` first-parent commits and totals the job minutes saved. Commits the workflow's own `push` path filter never runs on are listed but left out of the totals. `--jev` includes Jev, capped by `--max-tokens`. |
| `jevci eval` | Scores the judge on labelled cases (`{"id", "file", "diff", "evidence"?, "expect": {"<job>": true}}` per line) at several thresholds. `--answers` records answers for offline re-runs. |

A config error exits 2 with every problem listed.

## Providers

- `gateway` (default when `AI_GATEWAY_API_KEY` is set): Vercel AI Gateway.
- `typesafe`: api.typesafe.ai, pinned to a model version, with `TYPESAFE_API_KEY`.
- `openrouter`: OpenRouter's decisions endpoint, pinned to `typesafe/jev-1.13` by default, with `OPENROUTER_API_KEY`.
- `replay`: cached answers only, and nothing is sent.

Answers are cached by model, state and question, so re-planning the same change is free. Requests retry on rate limits (following `retry-after`), server errors and dropped connections; a rejected key or an account without credits fails at once, and the plan keeps the jobs the rules chose. jevci never reads `.env` files. Export the key in the job that runs it.

## API

```ts
import { createJevJudge, createPlan, detectContext, loadConfig } from '@hazymoon/jevci';

const config = await loadConfig();
const context = detectContext();
const plan = await createPlan(config, {
    base: context.base ?? 'origin/main',
    head: context.head ?? 'HEAD',
    event: context.event,
    labels: context.labels,
    body: context.body,
    judge: config.jev ? createJevJudge(config.jev) : undefined,
});
```

`createJevJudge` throws `JevciKeyError` when the provider's API key is missing; leave `judge` out to plan by the rules alone. Any object with `ask(state, questions) → Promise<Record<id, P(yes)>>` can serve as the `judge`: another model, a rule table, or a stub in tests. `plan.schemaVersion` changes only on breaking changes to the JSON shape.

## Limits

- The rules are only as good as `paths`. A job that reads files outside its `paths` can be skipped wrongly. Keep a nightly full run (`schedule` does that by default) and use `jevci replay` to check a new config against history.
- Comment-only detection covers scripts, Vue, JSON, markup and CSS. For other text files, only line endings and trailing whitespace are normalized. A test that reads source files as text can still see a comment change. Give such a job `formatting: true`.
- A file over 1 MiB is not compared as text: any edit to it runs its jobs.
- Jev judges one file at a time. A change that only breaks in combination with another file's change still runs the jobs either file needs on its own.

## License

MIT
