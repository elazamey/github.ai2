#!/usr/bin/env node
/**
 * PR Gatekeeper Bot
 *
 * Evaluates a pull request against a set of merge rules and (optionally)
 * posts a summary comment and auto-merges when every rule passes.
 *
 * Dependency-free: uses the GitHub REST API via global fetch (Node 18+).
 *
 * Env:
 *   GITHUB_TOKEN   required
 *   GITHUB_REPOSITORY  "owner/repo" (auto-set in Actions)
 *   PR_NUMBER      pull request number
 *   DRY_RUN        "true" -> never comment or merge, just report
 *   AUTO_MERGE     "true" -> merge when all rules pass
 *   MERGE_METHOD   merge | squash | rebase   (default: squash)
 *   REQUIRE_BRANCH_PROTECTION  "true" (default) -> base branch must be protected
 */

import { evaluate } from '../src/rules.mjs';
import { renderComment } from '../src/report.mjs';

const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const token = process.env.GITHUB_TOKEN;
const repoSlug = process.env.GITHUB_REPOSITORY;
const prNumber = Number(process.env.PR_NUMBER);

const bool = (v, dflt = false) =>
  v === undefined || v === '' ? dflt : String(v).toLowerCase() === 'true';

const DRY_RUN = bool(process.env.DRY_RUN);
const AUTO_MERGE = bool(process.env.AUTO_MERGE);
const MERGE_METHOD = process.env.MERGE_METHOD || 'squash';
const REQUIRE_BRANCH_PROTECTION = bool(process.env.REQUIRE_BRANCH_PROTECTION, true);

const MARKER = '<!-- pr-gatekeeper-bot -->';

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

if (!token) fail('GITHUB_TOKEN is required');
if (!repoSlug) fail('GITHUB_REPOSITORY is required');
if (!Number.isInteger(prNumber) || prNumber <= 0) fail('PR_NUMBER is required');

const [owner, repo] = repoSlug.split('/');

async function gh(path, { method = 'GET', body, allow404 = false, allow403 = false } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      'user-agent': 'pr-gatekeeper-bot',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404 && allow404) return null;
  if (res.status === 403 && allow403) return { __forbidden: true };
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const detail = data?.message || res.statusText;
    throw new Error(`${method} ${path} -> ${res.status}: ${detail}`);
  }
  return data;
}

async function collectChecks(sha) {
  const [runs, statuses] = await Promise.all([
    gh(`/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`),
    gh(`/repos/${owner}/${repo}/commits/${sha}/status`),
  ]);

  const checks = (runs?.check_runs || []).map((r) => ({
    name: r.name,
    status: r.status, // queued | in_progress | completed
    conclusion: r.conclusion, // success | failure | neutral | cancelled | skipped | ...
    url: r.html_url,
  }));

  for (const s of statuses?.statuses || []) {
    checks.push({
      name: s.context,
      status: s.state === 'pending' ? 'in_progress' : 'completed',
      conclusion:
        s.state === 'success' ? 'success' : s.state === 'pending' ? null : 'failure',
      url: s.target_url,
    });
  }
  return checks;
}

async function upsertComment(bodyText) {
  const body = `${MARKER}\n${bodyText}`;
  const comments = await gh(
    `/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`
  );
  const mine = (comments || []).find((c) => c.body?.includes(MARKER));
  if (mine) {
    await gh(`/repos/${owner}/${repo}/issues/comments/${mine.id}`, {
      method: 'PATCH',
      body: { body },
    });
    return 'updated';
  }
  await gh(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: 'POST',
    body: { body },
  });
  return 'created';
}

async function main() {
  const pr = await gh(`/repos/${owner}/${repo}/pulls/${prNumber}`);
  const checks = await collectChecks(pr.head.sha);
  // Reading branch protection requires admin rights; if the token lacks them we
  // cannot prove the branch is unprotected, so the rule is skipped rather than failed.
  const protection = await gh(
    `/repos/${owner}/${repo}/branches/${encodeURIComponent(pr.base.ref)}/protection`,
    { allow404: true, allow403: true }
  );
  const protectionUnknown = Boolean(protection?.__forbidden);
  if (protectionUnknown) {
    console.log('::warning::token cannot read branch protection - rule skipped');
  }
  const reviews = await gh(
    `/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100`
  );

  const verdict = evaluate({
    pr: {
      draft: pr.draft,
      state: pr.state,
      mergeable: pr.mergeable,
      mergeable_state: pr.mergeable_state,
      title: pr.title,
      base: pr.base.ref,
      head: pr.head.ref,
      sha: pr.head.sha,
      labels: (pr.labels || []).map((l) => l.name),
    },
    checks,
    branchProtected: protectionUnknown ? null : Boolean(protection),
    reviews: (reviews || []).map((r) => ({ state: r.state, user: r.user?.login })),
    options: {
      requireBranchProtection: REQUIRE_BRANCH_PROTECTION && !protectionUnknown,
    },
  });

  const comment = renderComment(verdict, {
    repo: repoSlug,
    prNumber,
    autoMerge: AUTO_MERGE,
    dryRun: DRY_RUN,
  });

  console.log(comment);

  if (!DRY_RUN) {
    const action = await upsertComment(comment);
    console.log(`::notice::gatekeeper comment ${action}`);
  }

  if (verdict.pass && AUTO_MERGE && !DRY_RUN) {
    await gh(`/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
      method: 'PUT',
      body: { merge_method: MERGE_METHOD },
    });
    console.log(`::notice::PR #${prNumber} merged (${MERGE_METHOD})`);
  }

  // Summary for the Actions UI
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, comment + '\n');
  }

  if (!verdict.pass && bool(process.env.FAIL_ON_BLOCK, false)) {
    fail(`Gatekeeper blocked PR #${prNumber}`);
  }
}

main().catch((e) => fail(e.message));
