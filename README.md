# SEO Check (by SEOAgent)

Crawl your pull request's preview deployment and get one PR comment listing the SEO problems it found. Free, no account, no API key.

The action runs the open-source [SEOAgent CLI](https://www.npmjs.com/package/@seoagent-official/seoagent) (`seoagent crawl`) against the URL you give it. The CLI reads the homepage, the sitemap and the links on every page it fetches, then checks:

- titles, meta descriptions and H1s (missing or duplicated)
- canonical tags
- structured data (JSON-LD)
- images with no `alt` text
- pages that render as an empty client-side shell (crawlers see no content)
- `robots.txt` and `sitemap.xml` (missing, unreachable, pages left out of the sitemap)
- pages that could not be crawled at all

It writes a job summary on every run and keeps **one** comment on the PR up to date (it edits its own comment instead of adding a new one on each push):

```md
### SEO check: 3 problems found

<sub>Crawled https://my-app-git-feature-acme.vercel.app · 50 pages · preview build · SEOAgent CLI 1.117.6</sub>

- 🟠 **High** · sitemap.xml is missing or unreachable
- 🟡 **Medium** · 4 pages are missing a meta description — `/pricing`, `/blog`, `/about` and 1 more
- 🟡 **Medium** · 12 images are missing alt text across 3 pages — `/`, `/features`, `/blog`

<details><summary>Affected pages and suggested fixes</summary> … </details>

SEOAgent can open a PR that fixes these → https://seoagent.com/
```

## Usage

### Vercel or Netlify preview deployments

Vercel and Netlify report each preview as a GitHub deployment, so the check runs as soon as the preview is ready. The pull request is found from the deployment's commit.

```yaml
# .github/workflows/seo-check.yml
name: SEO check
on: deployment_status

permissions:
  contents: read
  pull-requests: write

jobs:
  seo-check:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: SEOAgent-app/seo-check@v1
        with:
          url: ${{ github.event.deployment_status.target_url }}
```

No checkout step is needed: the action never reads or writes your repository files.

If the commit has no open pull request (for example a production deploy of `main`), the job summary is still written and no comment is posted.

### A fixed staging URL on `pull_request`

```yaml
name: SEO check
on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  seo-check:
    runs-on: ubuntu-latest
    steps:
      # Deploy your branch to staging first (your own step), then:
      - uses: SEOAgent-app/seo-check@v1
        with:
          url: https://staging.example.com
          max-pages: 100
```

## Inputs

| Input                  | Default               | Description                                                                                                                                                                                                |
| ---------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`                  | (required)            | Origin to crawl, e.g. `${{ github.event.deployment_status.target_url }}`. Only the origin is used; the crawl starts at `/`.                                                                                |
| `github-token`         | `${{ github.token }}` | Token used to find the pull request and post the comment.                                                                                                                                                  |
| `max-pages`            | `50`                  | Most pages to crawl (1 to 500). The default keeps PR runs to a minute or two.                                                                                                                              |
| `comment`              | `true`                | Post or update the PR comment. The job summary is written either way.                                                                                                                                      |
| `fail-on`              | `none`                | `none`: never fail the job because of findings. `findings`: fail it when any problem is found. (v1 compares nothing against production, so `findings` fails on problems that already exist on `main` too.) |
| `preview`              | `auto`                | `auto`: on for `pull_request` runs and for `deployment_status` runs on a non-production environment. `true` / `false` to force it. See below.                                                              |
| `vercel-bypass-secret` | (none)                | Vercel Protection Bypass for Automation secret for protected previews. See below.                                                                                                                          |
| `telemetry`            | `true`                | `false` turns off the CLI's anonymous usage ping (see below).                                                                                                                                              |

Output: `findings`, the number of problems found (empty when the check was skipped).

## Permissions

Commenting needs `pull-requests: write` (or `issues: write`; PR comments are issue comments). Without it the action logs a warning, writes the job summary and does not fail.

Pull requests opened from forks get a read-only `GITHUB_TOKEN` on `pull_request`, so they get the job summary but no comment.

## Protected previews

If the preview sits behind Vercel Deployment Protection, give the action the project's **Protection Bypass for Automation** secret (Vercel → Project Settings → Deployment Protection), stored as a repository secret:

```yaml
- uses: SEOAgent-app/seo-check@v1
  with:
    url: ${{ github.event.deployment_status.target_url }}
    vercel-bypass-secret: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}
```

The secret is sent as the `x-vercel-protection-bypass` header to the `url` origin only, never to another host, even across redirects.

Without it, or behind Netlify password protection or any other login (a `401`, or a redirect to `vercel.com/sso-api`), the action skips the crawl and says so in the job summary, rather than auditing the login page.

## Preview deployments are checked as they will ship

Vercel and Netlify add `X-Robots-Tag: noindex` to preview deployments, and most sites' canonical tags point at the production domain. Read literally, that excludes every preview page from search, so a plain crawl would skip the page-level checks (titles, meta descriptions, canonicals, structured data, alt text).

With `preview` (on by default for pull request runs and non-production deployments), the CLI reads those signals as they will be once the change ships: a noindex sent only as a header is ignored, and a canonical pointing at the same path on another domain counts as self-referencing. A `<meta name="robots" content="noindex">` in the page itself still counts, because it ships with the page. Set `preview: false` when `url` is the production site.

## Telemetry

The SEOAgent CLI sends one anonymous ping when the action runs `seoagent init`: a random install id, the CLI version and the platform. No domain, no paths, no repository data. Inside GitHub Actions the ping is marked as a CI run (`init_ci`), so it is never counted as an install. Turn it off with either:

```yaml
- uses: SEOAgent-app/seo-check@v1
  with:
    url: ...
    telemetry: false
```

or the environment variables the CLI already honours, `SEOAGENT_TELEMETRY=0` or `DO_NOT_TRACK=1`, set on the job or the step.

## How it works

A composite action with no build step:

1. `src/main.mjs` (Node 20+, no dependencies) checks the URL is publicly reachable.
2. It creates a scratch directory under `$RUNNER_TEMP` and runs `npx -y @seoagent-official/seoagent@<pinned version> init --yes` and `crawl --url <origin> --max <max-pages>` there (plus `--preview` and the bypass header when set). Nothing is written to your checkout.
3. It parses `.seoagent/audit/findings.md` (`audit/preview/findings.md` in preview mode), writes the job summary, finds the pull request (from the `pull_request` payload, or `GET /repos/{owner}/{repo}/commits/{sha}/pulls` for `deployment_status`) and creates or updates the comment marked `<!-- seoagent-seo-check -->`.

The CLI version is pinned in `src/main.mjs` (`CLI_VERSION`), so a CLI release never changes what an existing action tag does.

Tested on `ubuntu-latest`; macOS runners should work the same way. A self-hosted runner needs Node 20 or later and `npx` on `PATH`.

## Want the fixes, not just the list?

SEOAgent can open a pull request that fixes these problems, and keeps your site's SEO on autopilot: <https://seoagent.com/?utm_source=github-action&utm_medium=readme&utm_campaign=seo-check>

## License

MIT
