/**
 * SEO check — the pure parts of the action: read the SEOAgent CLI's crawl
 * output, render the report, and talk to the GitHub REST API.
 *
 * Dependency-free on purpose (Node 20+, global `fetch`): the action ships as
 * this folder with no install or bundle step. Everything that touches the
 * network takes a `fetchImpl` so it can be tested without one.
 */

/** Hidden marker that identifies the action's own PR comment (find-or-update). */
export const COMMENT_MARKER = '<!-- seoagent-seo-check -->';

/** Where the comment's last line points. */
export const CTA_URL =
  'https://seoagent.com/?utm_source=github-action&utm_medium=pr-comment&utm_campaign=seo-check';

/** GitHub caps a comment body at 65,536 characters; stay well under it. */
export const MAX_BODY_CHARS = 60_000;

/** URLs listed per finding inside the details block before "…and N more". */
const DETAIL_URL_LIMIT = 25;
/** Page paths shown inline on a finding's one-line summary. */
const INLINE_PATH_LIMIT = 3;
/** Per-URL detail text (e.g. the image srcs missing alt) before it is clipped. */
const DETAIL_TEXT_LIMIT = 120;

const SEVERITY_ICON = { Critical: '🔴', High: '🟠', Medium: '🟡', Low: '⚪' };

/** Read a `key: value` frontmatter block (flat scalars only). */
function parseFrontmatter(md) {
  const out = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

function toInt(v) {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse `.seoagent/audit/findings.md` (written by `seoagent crawl`).
 *
 * Findings are the `## [Severity] Title` sections; each carries a
 * `**Check:** \`id\`` line, an optional `Affected URLs:` list (`- <url>` or
 * `- <url> — detail`) and a `**Suggested fix:**` line. The
 * "excluded from search on purpose" section lists pages the crawl skipped
 * for page-level checks (noindex, robots Disallow, off-origin canonical).
 */
export function parseFindings(md) {
  const fm = parseFrontmatter(md);
  const findings = [];
  const excluded = [];
  let current = null;
  let section = null; // 'finding' | 'excluded' | null
  let inUrls = false;

  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const heading = /^## (.*)$/.exec(line);
    if (heading) {
      inUrls = false;
      const sev = /^\[(Critical|High|Medium|Low)\]\s+(.*)$/.exec(heading[1]);
      if (sev) {
        current = { severity: sev[1], title: sev[2].trim(), checkId: null, urls: [], fix: null };
        findings.push(current);
        section = 'finding';
      } else {
        current = null;
        section = /excluded from search/i.test(heading[1]) ? 'excluded' : null;
      }
      continue;
    }

    if (section === 'excluded') {
      const group = /^\*\*(\d+) pages? — (.*?):\*\*$/.exec(line);
      if (group) excluded.push({ count: Number(group[1]), reason: group[2] });
      continue;
    }
    if (section !== 'finding' || !current) continue;

    const check = /^\*\*Check:\*\*\s*`([a-z0-9_]+)`/.exec(line);
    if (check) {
      current.checkId = check[1];
      continue;
    }
    if (line === 'Affected URLs:') {
      inUrls = true;
      continue;
    }
    if (inUrls) {
      // `- <url>`, `- <url> — 11 images (…)` or `- <url> (HTTP 419)`.
      const item = /^- (\S+)(?:\s+(?:—\s+)?(.*))?$/.exec(line);
      if (item) {
        current.urls.push({ url: item[1], detail: item[2] || null });
        continue;
      }
      inUrls = false;
    }
    const fix = /^\*\*Suggested fix:\*\*\s*(.*)$/.exec(line);
    if (fix) current.fix = fix[1];
  }

  return {
    domain: fm.domain ?? null,
    origin: fm.origin ?? null,
    sourceRender: fm.source_render === 'true',
    declaredCount: toInt(fm.findings),
    findings,
    excluded,
  };
}

/** Parse the crawl stats from `.seoagent/audit/evidence.md` frontmatter. */
export function parseEvidenceMeta(md) {
  const fm = parseFrontmatter(md ?? '');
  return {
    pagesCrawled: toInt(fm.pages_crawled),
    pagesDiscovered: toInt(fm.pages_discovered),
    pagesCaptured: toInt(fm.pages_captured),
  };
}

/** `https://x.dev/blog/post?a=1` → `/blog/post?a=1`; other origins stay absolute. */
export function displayPath(url, origin) {
  try {
    const u = new URL(url);
    if (origin && u.origin !== new URL(origin).origin) return url;
    return `${u.pathname}${u.search}` || '/';
  } catch {
    return url;
  }
}

function plural(n, one, many) {
  return n === 1 ? one : (many ?? `${one}s`);
}

function clip(text, limit) {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** Escape text that came from a crawled site so it renders literally in markdown. */
function code(text) {
  return `\`${String(text).replace(/`/g, "'")}\``;
}

/**
 * Pages skipped because the preview tells crawlers not to index it. Vercel
 * and Netlify add `X-Robots-Tag: noindex` to every preview deployment, and a
 * preview's canonical tags point at production — so on a preview the CLI
 * holds these pages out of the page-level checks.
 */
function excludedNote(excluded, preview) {
  if (excluded.length === 0) return null;
  const total = excluded.reduce((n, e) => n + e.count, 0);
  const reasons = excluded.map((e) => `${e.count} ${e.reason.replace(/`/g, '')}`).join('; ');
  const note =
    `> ${total} crawled ${plural(total, 'page was', 'pages were')} left out of the page-level checks ` +
    `because ${plural(total, 'it is', 'they are')} excluded from search (${reasons}).`;
  // In preview mode the CLI already reads the host's preview noindex and
  // production canonicals as they will ship, so what is left is the site's own.
  return preview
    ? note
    : `${note} Preview deployments on Vercel and Netlify send \`X-Robots-Tag: noindex\` and usually ` +
        'canonicalize to production; set `preview: true` to check those pages as they will ship.';
}

/**
 * Render the report. The same markdown is the job summary and (with the
 * marker) the PR comment.
 *
 * @param {ReturnType<typeof parseFindings>} parsed
 * @param {{ url: string, evidence?: ReturnType<typeof parseEvidenceMeta>, cliVersion?: string, preview?: boolean, marker?: boolean, maxChars?: number }} opts
 */
export function buildReport(parsed, opts) {
  const { findings, excluded } = parsed;
  const origin = parsed.origin ?? opts.url;
  const crawled = opts.evidence?.pagesCrawled;
  const discovered = opts.evidence?.pagesDiscovered;
  const lines = [];
  if (opts.marker) lines.push(COMMENT_MARKER);

  const n = findings.length;
  lines.push(
    n === 0
      ? `### ✅ SEO check: no problems found`
      : `### SEO check: ${n} ${plural(n, 'problem')} found`
  );
  const stats = [`Crawled ${origin}`];
  if (crawled !== null && crawled !== undefined) {
    stats.push(
      discovered !== null && discovered !== undefined && discovered > crawled
        ? `${crawled} of ${discovered} discovered pages`
        : `${crawled} ${plural(crawled, 'page')}`
    );
  }
  if (opts.preview) stats.push('preview build');
  if (opts.cliVersion) stats.push(`SEOAgent CLI ${opts.cliVersion}`);
  lines.push(`<sub>${stats.join(' · ')}</sub>`);
  lines.push('');

  for (const f of findings) {
    const paths = f.urls.map((u) => code(displayPath(u.url, origin)));
    let where = '';
    if (paths.length > 0) {
      const shown = paths.slice(0, INLINE_PATH_LIMIT).join(', ');
      const more = paths.length - INLINE_PATH_LIMIT;
      where = ` — ${shown}${more > 0 ? ` and ${more} more` : ''}`;
    }
    lines.push(`- ${SEVERITY_ICON[f.severity] ?? '•'} **${f.severity}** · ${f.title}${where}`);
  }
  if (n > 0) lines.push('');

  const note = excludedNote(excluded, opts.preview === true);
  if (note) {
    lines.push(note);
    lines.push('');
  }

  const footer = [];
  footer.push(
    n === 0
      ? `SEOAgent keeps it that way on autopilot → ${CTA_URL}`
      : `SEOAgent can open a PR that fixes these → ${CTA_URL}`
  );

  // Details: every affected page plus the suggested fix, collapsed. Built
  // last and trimmed to fit, so a huge site can never push the body past
  // GitHub's comment limit or drop the footer.
  const maxChars = opts.maxChars ?? MAX_BODY_CHARS;
  const tail = footer.join('\n');
  let head = lines.join('\n');
  if (head.length + tail.length + 2 > maxChars) {
    // Only reachable with absurdly long titles; keep whole lines that fit.
    const kept = [];
    let size = tail.length + 80;
    for (const l of lines) {
      if (size + l.length + 1 > maxChars) break;
      kept.push(l);
      size += l.length + 1;
    }
    head = [...kept, '- …(list truncated)', ''].join('\n');
  }
  const details = [];
  const withDetails = findings.filter((f) => f.urls.length > 0 || f.fix);
  if (withDetails.length > 0) {
    details.push('<details><summary>Affected pages and suggested fixes</summary>');
    details.push('');
    for (const f of withDetails) {
      details.push(`**${f.title}**${f.checkId ? ` (${code(f.checkId)})` : ''}`);
      if (f.fix) details.push(`Fix: ${f.fix}`);
      for (const u of f.urls.slice(0, DETAIL_URL_LIMIT)) {
        details.push(
          `- ${code(displayPath(u.url, origin))}${u.detail ? ` — ${clip(u.detail, DETAIL_TEXT_LIMIT)}` : ''}`
        );
      }
      const rest = f.urls.length - DETAIL_URL_LIMIT;
      if (rest > 0) details.push(`- …and ${rest} more`);
      details.push('');
    }
    details.push('</details>');
    details.push('');
  }

  let middle = details.join('\n');
  const budget = maxChars - head.length - tail.length - 4;
  if (middle.length > budget) {
    const cut =
      '\n…(truncated — run `npx @seoagent-official/seoagent crawl` locally for the full list)\n\n</details>\n';
    middle = budget > cut.length + 60 ? middle.slice(0, budget - cut.length) + cut : '';
  }
  return [head, middle, tail].filter(Boolean).join('\n');
}

/** The pull request a run belongs to, or null. */
export async function findPullRequest({
  eventName,
  event,
  sha,
  repo,
  token,
  apiUrl,
  fetchImpl = fetch,
}) {
  const fromPayload = event?.pull_request?.number ?? null;
  if (fromPayload) return fromPayload;

  // deployment_status (Vercel/Netlify previews) carries the commit, not the
  // PR: ask GitHub which open PRs contain it. Same for push/workflow_dispatch.
  const commit = (eventName === 'deployment_status' ? event?.deployment?.sha : null) ?? sha;
  if (!commit || !repo) return null;
  const res = await fetchImpl(`${apiUrl}/repos/${repo}/commits/${commit}/pulls?per_page=100`, {
    headers: ghHeaders(token),
  });
  if (!res.ok) throw new GitHubError('look up the pull request for this commit', res.status);
  const pulls = await res.json();
  const open = Array.isArray(pulls) ? pulls.filter((p) => p.state === 'open') : [];
  // A merged PR's commit lands on the base branch too (a production deploy):
  // only an OPEN PR is one whose reviewers want this comment.
  const exact = open.find((p) => p.head?.sha === commit);
  return (exact ?? open[0])?.number ?? null;
}

/** Create the comment, or update the one carrying the marker. */
export async function upsertComment({ repo, issueNumber, body, token, apiUrl, fetchImpl = fetch }) {
  let existing = null;
  for (let page = 1; page <= 20 && !existing; page++) {
    const res = await fetchImpl(
      `${apiUrl}/repos/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      { headers: ghHeaders(token) }
    );
    if (!res.ok) throw new GitHubError('list the pull request comments', res.status);
    const comments = await res.json();
    if (!Array.isArray(comments) || comments.length === 0) break;
    existing =
      comments.find((c) => typeof c.body === 'string' && c.body.includes(COMMENT_MARKER)) ?? null;
    if (comments.length < 100) break;
  }

  const init = {
    headers: { ...ghHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  };
  if (existing) {
    const res = await fetchImpl(`${apiUrl}/repos/${repo}/issues/comments/${existing.id}`, {
      ...init,
      method: 'PATCH',
    });
    if (!res.ok) throw new GitHubError('update the SEO check comment', res.status);
    return { action: 'updated', id: existing.id };
  }
  const res = await fetchImpl(`${apiUrl}/repos/${repo}/issues/${issueNumber}/comments`, {
    ...init,
    method: 'POST',
  });
  if (!res.ok) throw new GitHubError('create the SEO check comment', res.status);
  const created = await res.json();
  return { action: 'created', id: created?.id ?? null };
}

export class GitHubError extends Error {
  constructor(what, status) {
    const hint =
      status === 403 || status === 404
        ? ' — give the job `permissions: pull-requests: write` (a pull request from a fork only gets a read-only token)'
        : '';
    super(`Could not ${what}: GitHub API returned HTTP ${status}${hint}`);
    this.status = status;
  }
}

function ghHeaders(token) {
  const h = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'seoagent-seo-check',
  };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

/**
 * Is the URL behind a login wall the crawler cannot pass? Vercel Deployment
 * Protection answers a 302 to vercel.com/sso-api (or a 401); Netlify password
 * protection and basic auth answer 401. Crawling that would audit the login
 * page and report its gaps as the site's. Returns a reason, or null.
 */
export async function detectProtection(url, fetchImpl = fetch, headers = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      redirect: 'manual',
      headers: { 'user-agent': 'seoagent-seo-check', ...headers },
    });
  } catch {
    return null; // unreachable is the crawl's to report
  }
  const location = res.headers?.get?.('location') ?? '';
  if (res.status >= 300 && res.status < 400 && /vercel\.com\/(sso-api|login)/.test(location)) {
    return 'Vercel Deployment Protection redirects the crawler to a Vercel login';
  }
  if (res.status === 401) return 'the URL answered HTTP 401 (password or SSO protection)';
  return null;
}

/**
 * Should the crawl run in preview mode (`seoagent crawl --preview`)? `auto`
 * is on for a pull request run and for a `deployment_status` run whose
 * deployment is not production: those URLs are previews or staging, which
 * hosts mark noindex and canonicalize to production.
 */
export function resolvePreview(value, eventName, event) {
  const v = String(value ?? '')
    .trim()
    .toLowerCase();
  if (v !== '' && v !== 'auto') return parseBool(v, false);
  if (eventName === 'pull_request' || eventName === 'pull_request_target') return true;
  if (eventName === 'deployment_status') {
    const d = event?.deployment ?? {};
    const env = String(event?.deployment_status?.environment ?? d.environment ?? '');
    const production = d.production_environment === true || /^production$/i.test(env);
    return !production;
  }
  return false;
}

/** `true`/`false` style action input → boolean. */
export function parseBool(value, fallback) {
  const v = String(value ?? '')
    .trim()
    .toLowerCase();
  if (v === '') return fallback;
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  throw new Error(`Expected true or false, got ${JSON.stringify(value)}`);
}
