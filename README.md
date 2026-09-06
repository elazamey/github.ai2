# PR Gatekeeper Bot

A dependency-free GitHub bot that decides whether a pull request is **safe to merge**.
It inspects CI checks, branch protection, review state, conflicts and labels, posts a
single self-updating summary comment on the PR, and optionally merges automatically
once every rule passes.

Built on top of this repository's existing real-GitHub E2E fixtures, which now double
as regression scenarios for the bot.

## Why

Reviewing "is this PR actually ready?" by hand is repetitive and error-prone: CI may
still be running, a required check may be red, or the base branch may have no
protection at all. The gatekeeper answers that question deterministically, every time.

## Rules

| Rule | Blocks merge when |
| --- | --- |
| `open` | PR is closed or already merged |
| `not-draft` | PR is still a draft |
| `no-conflicts` | Branch conflicts with the base (`mergeable_state: dirty`) |
| `checks-complete` | Any check is queued or in progress |
| `checks-green` | Any check failed, was cancelled or timed out |
| `has-checks` | No CI reported for the head commit at all |
| `branch-protected` | Base branch has no protection rules (optional) |
| `no-changes-requested` | A reviewer's latest review requests changes |
| `approvals` | Fewer approvals than `minApprovals` (opt-in) |
| `no-blocking-label` | PR carries `do-not-merge`, `wip` or `blocked` |

`neutral` and `skipped` check conclusions are treated as passing. Only the **latest**
review per user counts, so a `CHANGES_REQUESTED` later replaced by `APPROVED` no
longer blocks.

## Repository layout

```
src/rules.mjs          pure decision logic (no network, fully unit tested)
src/report.mjs         renders the Markdown PR comment
scripts/gatekeeper.mjs GitHub API client + entry point
test/rules.test.mjs    15 unit tests, node:test
.github/workflows/
  gatekeeper.yml       runs the bot on PR / review / check_suite events
  test.yml             runs the unit tests
  e2e.yml              original E2E fixture workflow
```

## Usage

### In GitHub Actions

`gatekeeper.yml` is already wired up. It triggers on pull request activity, review
submissions and completed check suites, and can also be run manually via
**Actions → pr-gatekeeper → Run workflow** with a PR number.

Configure behaviour with repository variables (Settings → Secrets and variables →
Actions → Variables):

| Variable | Default | Meaning |
| --- | --- | --- |
| `GATEKEEPER_AUTO_MERGE` | `false` | Merge automatically when all rules pass |
| `GATEKEEPER_MERGE_METHOD` | `squash` | `merge`, `squash` or `rebase` |
| `GATEKEEPER_REQUIRE_PROTECTION` | `true` | Enforce the `branch-protected` rule |

Auto-merge is **off by default** — turn it on only once you trust the reports.

### Locally

```bash
export GITHUB_TOKEN=$(gh auth token)
export GITHUB_REPOSITORY=owner/repo
PR_NUMBER=1 DRY_RUN=true npm run gatekeeper
```

`DRY_RUN=true` prints the verdict without commenting or merging — the safest way to
try it on a real PR.

> Reading branch protection requires admin rights. If the token lacks them the API
> returns `403`; the bot logs a warning and **skips** the `branch-protected` rule
> rather than falsely reporting the branch as unprotected. In Actions the workflow
> requests `administration: read` so the rule is evaluated normally.

### Tests

```bash
npm test
```

No dependencies, no install step. Node 18+ (uses global `fetch`).

## Example output

> ## ⛔ PR Gatekeeper — merge blocked
>
> | | Rule | Detail |
> | :-: | --- | --- |
> | ✅ | PR is open | open |
> | ✅ | Not a draft | ready for review |
> | ❌ | No failing checks | failing: e2e (failure) |
> | ❌ | Base branch `main` is protected | NO branch protection configured |
>
> **Checks:** 0 passing · 1 failing · 0 pending · 1 total

The comment carries a hidden `<!-- pr-gatekeeper-bot -->` marker so it is edited in
place on every re-run instead of spamming the thread.

## E2E fixtures

The three long-lived fixture PRs map directly onto the rules:

| PR | Branch | Expected verdict |
| --- | --- | --- |
| #1 | `e2e/positive` | passes when the base branch is protected |
| #2 | `e2e/failing-ci` | blocked by `checks-green` |
| #3 | `e2e/unprotected-ci` | blocked by `branch-protected` |

`e2e.yml` fails deliberately when a commit message is exactly `e2e-fail`, which is how
the red-CI fixture stays red.

## License

MIT — see [LICENSE](LICENSE).
