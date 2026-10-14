#!/usr/bin/env node
/**
 * SEO check entry point: crawl the URL with the SEOAgent CLI in a scratch
 * directory under $RUNNER_TEMP (never the user's checkout), then write the
 * job summary and post or update one PR comment.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildReport,
  detectProtection,
  findPullRequest,
  parseBool,
  parseEvidenceMeta,
  parseFindings,
  resolvePreview,
  upsertComment,
} from './lib.mjs';

/** Exact CLI version this release of the action runs. Bump deliberately. */
export const CLI_VERSION = '1.117.6';
const CLI_PACKAGE = `@seoagent-official/seoagent@${CLI_VERSION}`;

const env = process.env;
const input = (name) => (env[`INPUT_${name.toUpperCase().replace(/-/g, '_')}`] ?? '').trim();

function summary(markdown) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  else console.log(markdown);
}

function setOutput(name, value) {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function fail(message) {
  console.log(`::error::${message}`);
  summary(`### SEO check could not run\n\n${message}`);
  process.exit(1);
}

function runCli(cwd, args, childEnv) {
  const res = spawnSync('npx', ['-y', CLI_PACKAGE, ...args], {
    cwd,
    env: childEnv,
    stdio: ['ignore', 'inherit', 'inherit'],
    // npx is npx.cmd on Windows, which only resolves through a shell. The
    // arguments are a validated URL origin, integers and a bypass secret
    // restricted to [A-Za-z0-9_-].
    shell: process.platform === 'win32',
  });
  if (res.error) fail(`Could not run npx ${CLI_PACKAGE}: ${res.error.message}`);
  return res.status ?? 1;
}

async function main() {
  const url = input('url');
  if (!url)
    fail('The `url` input is required (the origin to crawl, e.g. the preview deployment URL).');
  let origin;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('not http(s)');
    origin = u.origin;
  } catch {
    fail(`The \`url\` input is not an http(s) URL: ${JSON.stringify(url)}`);
  }

  const maxPages = Number.parseInt(input('max-pages') || '50', 10);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 500) {
    fail(
      `\`max-pages\` must be a whole number from 1 to 500, got ${JSON.stringify(input('max-pages'))}.`
    );
  }
  const failOn = (input('fail-on') || 'none').toLowerCase();
  if (failOn !== 'none' && failOn !== 'findings') {
    fail(`\`fail-on\` must be \`none\` or \`findings\`, got ${JSON.stringify(input('fail-on'))}.`);
  }
  let comment;
  let telemetry;
  try {
    comment = parseBool(input('comment'), true);
    telemetry = parseBool(input('telemetry'), true);
  } catch (e) {
    fail(`\`comment\` and \`telemetry\` take true or false: ${e.message}`);
  }

  const event = env.GITHUB_EVENT_PATH
    ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf-8'))
    : {};
  let preview;
  try {
    preview = resolvePreview(input('preview'), env.GITHUB_EVENT_NAME, event);
  } catch (e) {
    fail(`\`preview\` takes auto, true or false: ${e.message}`);
  }

  const bypassSecret = input('vercel-bypass-secret');
  const bypassHeaders = {};
  if (bypassSecret) {
    if (!/^[A-Za-z0-9_-]+$/.test(bypassSecret)) {
      fail('`vercel-bypass-secret` may only contain letters, digits, `_` and `-`.');
    }
    console.log(`::add-mask::${bypassSecret}`);
    bypassHeaders['x-vercel-protection-bypass'] = bypassSecret;
  }

  const protectedReason = await detectProtection(`${origin}/`, fetch, bypassHeaders);
  if (protectedReason) {
    const msg =
      `Skipped: ${origin} is not publicly reachable (${protectedReason}). ` +
      'The crawler would audit the login page instead of your site. ' +
      (bypassSecret
        ? "The `vercel-bypass-secret` was sent and did not get through: check it matches the project's Protection Bypass for Automation secret."
        : "For Vercel Deployment Protection, set `vercel-bypass-secret` to the project's Protection Bypass for Automation secret; otherwise point `url` at a public staging URL.");
    console.log(`::warning::${msg}`);
    summary(`### SEO check skipped\n\n${msg}`);
    setOutput('findings', '');
    return;
  }

  const work = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), 'seoagent-seo-check-'));
  const childEnv = { ...env, CI: 'true' };
  if (!telemetry) childEnv.SEOAGENT_TELEMETRY = '0';

  console.log(`::group::seoagent init (${CLI_PACKAGE})`);
  // No --domain: an unknown domain also skips init's first-run keyword peek.
  const initStatus = runCli(work, ['init', '--yes'], childEnv);
  console.log('::endgroup::');
  if (initStatus !== 0) fail(`\`seoagent init\` exited with code ${initStatus}.`);

  const crawlArgs = ['crawl', '--url', origin, '--max', String(maxPages)];
  if (preview) crawlArgs.push('--preview');
  if (bypassSecret) crawlArgs.push('--header', `x-vercel-protection-bypass: ${bypassSecret}`);
  console.log(
    `::group::seoagent crawl ${origin} (max ${maxPages} pages${preview ? ', preview' : ''})`
  );
  const crawlStatus = runCli(work, crawlArgs, childEnv);
  console.log('::endgroup::');

  // A preview crawl writes its reports to audit/preview/ (CLI 1.116.0+).
  const auditDir = join(work, '.seoagent', 'audit', ...(preview ? ['preview'] : []));
  const findingsPath = join(auditDir, 'findings.md');
  if (crawlStatus !== 0 || !existsSync(findingsPath)) {
    fail(
      `\`seoagent crawl\` exited with code ${crawlStatus} and wrote no findings report. See the step log.`
    );
  }
  const parsed = parseFindings(readFileSync(findingsPath, 'utf-8'));
  const evidencePath = join(auditDir, 'evidence.md');
  const evidence = parseEvidenceMeta(
    existsSync(evidencePath) ? readFileSync(evidencePath, 'utf-8') : ''
  );
  const count = parsed.findings.length;
  setOutput('findings', String(count));

  summary(buildReport(parsed, { url: origin, evidence, cliVersion: CLI_VERSION, preview }));

  if (comment) {
    const apiUrl = env.GITHUB_API_URL || 'https://api.github.com';
    const token = input('github-token');
    try {
      const pr = await findPullRequest({
        eventName: env.GITHUB_EVENT_NAME,
        event,
        sha: env.GITHUB_SHA,
        repo: env.GITHUB_REPOSITORY,
        token,
        apiUrl,
      });
      if (!pr) {
        console.log('No open pull request for this run — wrote the job summary only.');
      } else {
        const body = buildReport(parsed, {
          url: origin,
          evidence,
          cliVersion: CLI_VERSION,
          preview,
          marker: true,
        });
        const res = await upsertComment({
          repo: env.GITHUB_REPOSITORY,
          issueNumber: pr,
          body,
          token,
          apiUrl,
        });
        console.log(
          `${res.action === 'updated' ? 'Updated' : 'Posted'} the SEO check comment on #${pr}.`
        );
      }
    } catch (e) {
      // A missing permission must not hide the findings: they are in the summary.
      console.log(`::warning::${e.message}`);
    }
  }

  if (failOn === 'findings' && count > 0) {
    console.log(
      `::error::SEO check found ${count} ${count === 1 ? 'problem' : 'problems'} (fail-on: findings).`
    );
    process.exit(1);
  }
}

main().catch((e) => fail(e?.stack || String(e)));
