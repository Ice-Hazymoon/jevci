# jevci

[![CI](https://github.com/Ice-Hazymoon/jevci/actions/workflows/ci.yml/badge.svg)](https://github.com/Ice-Hazymoon/jevci/actions/workflows/ci.yml)

Selective CI for GitHub Actions and GitLab CI. jevci compares a commit range, decides which CI jobs the change can affect, and skips the rest.

Jobs are selected by deterministic rules: paths, comment-only edits and structural changes. An optional model pass ([TypeSafe](https://typesafe.ai) Jev) can drop a job it is confident the change cannot fail; it never adds jobs or skips CI entirely. If the model pass is unavailable, the rule-based plan is used. If jevci itself fails, every job runs.

## Installation

```sh
npm install --save-dev @hazymoon/jevci
```

Requires Node.js 22 or later, or Bun. jevci parses scripts with its own TypeScript 6 dependency, independent of the TypeScript version the project uses.

## Getting started

1. `npx jevci init` writes `jevci.config.ts` with one entry per job in your GitHub workflow and prints the workflow changes.
2. Describe each job in `checks` and narrow its `paths`.
3. Add the plan job and the job guards to the workflow (see [GitHub Actions](#github-actions)).
4. `npx jevci check` validates the wiring.
5. `npx jevci replay --last 100` estimates the savings on recent history. Add `--jev` to include the model pass.

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

## How jobs are selected

Every job runs for `schedule` and manual events, a `[ci full]` marker in a commit message or pull request description, the `ci:full` label, or a base commit that cannot be resolved (a new branch, a force push, a shallow clone).

Otherwise, each changed file is classified by the first rule that applies:

1. **Paths.** A file matching `full` runs every job. A file matching `ignore` runs none. Any other file applies to the jobs whose `paths` include it.
2. **Comments and formatting.** If only comments or formatting changed, only jobs with `formatting: true` run. Scripts are compared by syntax tree. Directive comments such as `@ts-expect-error`, `eslint-disable` and `#__PURE__` count as code.
3. **Structure.** Added, deleted, renamed and binary files run all of their jobs. So do edits that remove or rename an export.
4. **Model pass.** For each remaining edit and job, Jev estimates the probability that the edit can make the job fail. It is given the diff, the job's `checks`, and the test files that contain text the edit removed. A job is dropped for the file when the probability is below `threshold`. Jobs with `downgrade: false`, and files in a job's `owns`, skip this step.

A job runs if any file requires it. `minimumJobs` run on any change that is not ignored or comment-only, so skipping CI entirely is always a rule-based decision.

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
          fetch-depth: 0 # diff against the merge base
          filter: blob:none # fetch file contents on demand
      # The project's dependencies are not needed to plan.
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

The guard also runs the job when the plan job does not succeed. GitHub reports a job skipped by `if:` as successful, so required status checks are not blocked.

With `--format github`, the plan step writes a table of jobs and reasons to the job summary and sets these outputs:

| Output | Value |
| --- | --- |
| `level` | `none`, `partial` or `full` |
| `jobs` | JSON object mapping each job id to a boolean |
| `reason` | Summary of the decision |
| `fallback` | Why a fallback replaced a narrower plan; empty otherwise |
| `<group>` | JSON array of the matrix entries to run (see [Matrix jobs](#matrix-jobs)) |

The range, event, labels and description are read from the event payload for `push`, `pull_request`, `merge_group`, `schedule` and `workflow_dispatch`.

Cache the answer directory to reuse model answers across runs:

```yaml
      - uses: actions/cache@v4
        with:
          path: ~/.cache/jevci
          key: jevci-${{ github.sha }}
          restore-keys: jevci-
```

### Matrix jobs

A job-level `if:` cannot reference `matrix`, so matrix entries are planned as a group. Name the jobs `<workflow job>/<entry>` in the config. The plan outputs the entries to run under the group name, and the workflow builds its matrix from that output:

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

The list after `||` must name every entry, so that a failed plan runs all of them. `jevci check` verifies the guard, the matrix expression, the fallback list and the plan job's outputs. In dotenv output, `test/api` becomes `JEVCI_RUN_TEST_API`.

## Monorepos

A job that tests or builds some workspace packages can also fail after a change to their dependencies. `workspacePaths` derives `paths` from the workspace dependency graph (`pnpm-workspace.yaml`, or `workspaces` in `package.json` for npm, Yarn and Bun):

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

Package names accept globs (`@acme/*`, `**`). A name that matches no package is a config error. The result covers package directories only; add root files the job reads, such as CI config or a shared tsconfig, to its `paths` or to `full`.

Files a job reads outside the dependency graph, such as another package's sources scanned by a test, are declared as `triggers`. With a `pattern`, only changed lines that match it trigger the job:

```ts
'test/admin-api': {
    checks: '...',
    paths: workspacePaths(['@acme/admin-api'], { workspace }),
    // The parity test counts the procedures the front end calls.
    triggers: [{ files: ['apps/front/src/**'], pattern: /\b(api|queries)\.[\w.]+\(/ }],
},
```

## GitLab CI and other systems

On GitLab, jevci reads `CI_PIPELINE_SOURCE`, `CI_MERGE_REQUEST_DIFF_BASE_SHA`, `CI_COMMIT_BEFORE_SHA`, `CI_COMMIT_SHA`, and the merge request's labels and description. `--format dotenv` prints `JEVCI_LEVEL` and one `JEVCI_RUN_<JOB>=true|false` line per job, for use as a dotenv report:

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

On other systems, pass the range explicitly (`jevci plan --base origin/main --head HEAD --format json`) or use the [API](#api).

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `jobs.<id>.checks` | required | What the job verifies and what it cannot detect. Read by the model pass. |
| `jobs.<id>.paths` | `['**']` | Files that can affect the job. |
| `jobs.<id>.exclude` | `[]` | Globs removed from `paths`. |
| `jobs.<id>.owns` | `[]` | Files the job runs directly, such as its tests or config. A change runs the job without the model pass. |
| `jobs.<id>.downgrade` | `true` | `false` excludes the job from the model pass. |
| `jobs.<id>.formatting` | `false` | The job checks comments or formatting (a linter) and runs on comment-only edits. |
| `jobs.<id>.threshold` | `jev.threshold` | Threshold for this job. |
| `jobs.<id>.minutes` | none | Typical duration, used by `replay` and in summaries. |
| `jobs.<id>.triggers` | `[]` | `{ files, pattern? }` entries for files outside `paths` that the job reads. A change runs the job when an added or removed line matches `pattern`, or on any change if `pattern` is omitted. |
| `full` | `[]` | Files that run every job. |
| `ignore` | `[]` | Files no job reads. Deleting or renaming one still counts as a change. |
| `minimumJobs` | `[]` | Jobs that run on any change that is not ignored or comment-only. |
| `force.markers` / `labels` / `events` | `['[ci full]']` / `['ci:full']` / `['schedule', 'workflow_dispatch', 'web']` | Commit or description markers, labels and events that run every job. |
| `noop.directives` | `DEFAULT_DIRECTIVES` | Comments that change tool behavior. Editing one counts as a code change. |
| `noop.normalizers` | `[]` | Comment-only detection for more file types (see [Custom normalizers](#custom-normalizers)). `noop: false` disables detection. |
| `jev.threshold` | `0.2` | A job is kept when the probability of failure is at least this value. Lower is more conservative. |
| `jev.context` | none | A short description of the repository: framework, test setup, code that runs at build time. |
| `jev.testFiles` | `['**/*.test.*', '**/*.spec.*', '**/__tests__/**', 'test/**', 'tests/**']` | Test files searched for text an edit removes. |
| `jev.provider` | first provider with a key | See [Providers](#providers). `jev: false` disables the model pass. |
| `jev.maxFiles` / `maxDiffChars` / `maxTokens` / `timeoutSeconds` | `80` / `16000` / `400000` / `180` | Limits for the model pass. Beyond them, the rule-based plan is used. |
| `jev.cacheDir` / `concurrency` | `~/.cache/jevci` / `8` | Answer cache and concurrent requests. |

Globs match whole paths. `*` and `**` match dotfiles, so `**` includes `.github/`.

### Writing `checks`

The model pass sees only the job's `checks`, so state what the job cannot detect, for example "Does not check the contents of string literals" or "Type-only changes cannot fail it; Vitest strips types". Put repository-wide facts in `jev.context`. Measure with `jevci eval` before lowering the threshold.

### Custom normalizers

A normalizer returns the file content with everything the jobs cannot observe removed, or `undefined` if it cannot decide. Custom normalizers run before the built-in ones (scripts, Vue, JSON, HTML/SVG/XML, CSS):

```ts
import { parse } from 'yaml';

export default defineConfig({
    noop: {
        normalizers: [
            // Compare YAML by value, so comments and layout drop out.
            { files: ['**/*.{yml,yaml}'], normalize: text => JSON.stringify(parse(text)) },
        ],
    },
    jobs: { /* ... */ },
});
```

## Commands

| Command | Description |
| --- | --- |
| `jevci plan` | Print the plan. Options: `--format text\|json\|markdown\|github\|dotenv`, `--output <file>`, `--base`, `--head`, `--event`, `--labels`, `--no-jev`. Always exits 0; if jevci fails, the plan runs every job. |
| `jevci check` | Validate the workflow: every configured job depends on the plan job and reads its output, and the job ids in the workflow and config match. Exits 1 on errors. |
| `jevci init` | Generate a config from the workflow's jobs. |
| `jevci replay` | Plan the last `--last N` first-parent commits and total the job minutes saved. Commits excluded by the workflow's `push` path filters are listed but not counted. `--jev` includes the model pass, capped by `--max-tokens`. |
| `jevci eval` | Score the model pass on labelled cases at several thresholds. Cases are JSON lines: `{"id", "file", "diff", "evidence"?, "expect": {"<job>": true}}`. `--answers` records answers for offline runs. |

Configuration errors exit with code 2 and list every problem.

## Providers

| Provider | API key | Notes |
| --- | --- | --- |
| `gateway` | `AI_GATEWAY_API_KEY` | Vercel AI Gateway. |
| `typesafe` | `TYPESAFE_API_KEY` | api.typesafe.ai, pinned to a model version. |
| `openrouter` | `OPENROUTER_API_KEY` | OpenRouter. Default model `typesafe/jev-1.13`. |
| `replay` | none | Cached answers only. Sends no requests. |

Without `jev.provider`, the first provider in this table whose key is set is used. Answers are cached by model, input and question. Rate limits, server errors and network failures are retried; other errors fall back to the rule-based plan. jevci does not read `.env` files.

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

`createJevJudge` throws `JevciKeyError` if the provider's API key is missing. Omit `judge` to plan with rules only. Any object with `ask(state, questions)` returning `Promise<Record<string, number>>` (the probability of "yes" per question) can serve as the judge. `plan.schemaVersion` changes only when the plan's JSON shape changes incompatibly.

## Limitations

- A plan is only as accurate as `paths`. A job that reads files outside its `paths` can be skipped incorrectly. Keep a scheduled full run (`schedule` runs every job by default), and check a new config against history with `jevci replay`.
- Comment-only detection covers scripts, Vue, JSON, markup and CSS. Other text files are compared after normalizing line endings and trailing whitespace. A job that reads source files as text should set `formatting: true`.
- Files larger than 1 MiB are not compared; any change to one runs its jobs.
- The model pass judges each file separately. It does not consider failures that arise only from the combination of changes in several files.

## License

[MIT](LICENSE)
