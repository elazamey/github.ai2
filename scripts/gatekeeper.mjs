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

import { evaluate, normalizeChecks, resolveProtection } from '../src/rules.mjs';
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

/**
 * The gatekeeper runs as a check itself, so it would otherwise always observe its
 * own run as "in progress" and never reach a settled verdict. Exclude self.
 */
const SELF_CHECK = process.env.SELF_CHECK_NAME || 'gatekeeper';

async function collectChecks(sha) {
  const [runs, statuses] = await Promise.all([
    gh(`/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`),
    gh(`/repos/${owner}/${repo}/commits/${sha}/status`),
  ]);

  const checks = (runs?.check_runs || []).map((r) => ({
    name: r.name,
    status: r.status, // queued | in_progress | completed
    conclusion: r.conclusion, // success | failure | neutral | skipped | ...
    url: r.html_url,
    startedAt: r.started_at,
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
  const normalized = normalizeChecks(checks, { selfCheckName: SELF_CHECK });
  const dropped = checks.length - normalized.length;
  if (dropped > 0) {
    console.log(`::notice::ignored ${dropped} self/duplicate check(s)`);
  }
  return normalized;
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
  // Protection is read from the two endpoints that need no admin rights, so the rule
  // resolves under the plain GITHUB_TOKEN. The admin-only /protection endpoint is
  // consulted only as a bonus; a 403/404 there is not treated as "unprotected".
  const base = encodeURIComponent(pr.base.ref);
  const [branchInfo, ruleset] = await Promise.all([
    gh(`/repos/${owner}/${repo}/branches/${base}`, { allow404: true, allow403: true }),
    gh(`/repos/${owner}/${repo}/rules/branches/${base}`, {
      allow404: true,
      allow403: true,
    }),
  ]);

  const usable = (v) => v && !v.__forbidden;
  const protection = resolveProtection({
    classicProtected: usable(branchInfo) ? Boolean(branchInfo.protected) : null,
    rules: Array.isArray(ruleset) ? ruleset : null,
  });

  if (protection.protected === null) {
    console.log(
      '::warning::branch protection unreadable from every source - rule is UNKNOWN (auto-merge withheld)'
    );
  } else {
    console.log(
      `::notice::branch protection: ${protection.protected} via ${protection.source} (${protection.detail})`
    );
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
    branchProtected: protection.protected,
    reviews: (reviews || []).map((r) => ({ state: r.state, user: r.user?.login })),
    // Left at the configured value: an unreadable protection API yields
    // branchProtected=null -> UNKNOWN, which is handled by the rule engine.
    options: {
      requireBranchProtection: REQUIRE_BRANCH_PROTECTION,
      protectionDetail: protection.detail,
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

  if (AUTO_MERGE && verdict.pass && !verdict.autoMergeSafe) {
    const names = verdict.unverified.map((r) => r.id).join(', ');
    console.log(
      `::warning::auto-merge withheld for PR #${prNumber}: unverified rule(s): ${names}`
    );
  }

  // autoMergeSafe (not `pass`) is the gate: an UNKNOWN security rule never merges.
  if (verdict.autoMergeSafe && AUTO_MERGE && !DRY_RUN) {
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
