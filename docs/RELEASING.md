# Releasing ghcp-maestro

How to cut a tagged release and publish it to the GitHub Copilot CLI plugin
marketplace. The runtime is zero-deps; a "release" is a git tag + GitHub Release
plus the marketplace entry that points at it.

## Versioning

One version number, kept in sync across four places. Bump them together:

- `plugin.json` → `version`
- `package.json` → `version` (dev workspace)
- `extensions/ghcp-maestro/package.json` → `version`
- `.github/plugin/marketplace.json` → `metadata.version` **and** `plugins[0].version`

The git tag is `v<version>` (e.g. `v0.5.0`) and must match `plugin.json`'s
`version`. Versions follow SemVer; `docs/CHANGELOG.md` follows Keep a Changelog.

## What ships vs. what's dev-only

Installable files only: `plugin.json`, `extensions/`, `README*`, `LICENSE`,
`docs/CHANGELOG.md`, and `.github/plugin/marketplace.json`. Everything else —
`tests/`, `eslint.config.mjs`, `.github/workflows/`, `docs/PLAN.md`,
`docs/REQUIREMENTS.md`, `docs/specs/`, `docs/RELEASING.md`, `AGENTS.md`,
`package-lock.json` — is dev tooling and is kept out of release archives via
`export-ignore` in `.gitattributes`.

Preview exactly what a release archive contains (honors `export-ignore`):

```sh
git archive --format=tar HEAD | tar -t | sort
```

> Note: `export-ignore` applies to `git archive` and the GitHub Release source
> tarballs. A direct `copilot plugin install owner/repo` may fetch the repo
> tree rather than an archive, so do not rely on `export-ignore` for secrecy —
> it is for keeping release artifacts lean, not for hiding anything.

## Release steps

The release is automated: pushing a `vX.Y.Z` tag triggers
`.github/workflows/release.yml`, which re-runs the gate, **verifies** the tag
matches every version field, the changelog has a matching section, and the
archive is lean — then creates the GitHub Release from the changelog notes. Your
job is to get the versions and changelog right, then push the tag.

1. **Land everything on `main`.** All PRs merged, working tree clean, CI green.

2. **Bump the version** in the four files above and **cut the changelog**: move
   the `[Unreleased]` entries under a new `## [<version>] - <YYYY-MM-DD>` heading
   and leave a fresh empty `## [Unreleased]`. Open this as a `release/vX.Y.Z` PR,
   get review, merge.

3. **Verify locally before tagging** (the workflow checks the same things, but
   catch mistakes early):

   ```sh
   git checkout main && git pull --ff-only
   npm run check                 # ESLint + node:test, all green
   git archive --format=tar HEAD | tar -t | sort   # sanity-check the file list
   ```

4. **Tag and push.** The annotated tag must match `plugin.json` (`vX.Y.Z`):

   ```sh
   git tag -a v0.5.0 -m "ghcp-maestro v0.5.0"
   git push origin v0.5.0
   ```

   The **Release** workflow then runs and, on success, publishes the GitHub
   Release automatically. Watch it with `gh run watch` (or in the Actions tab).
   If a check fails (version mismatch, missing changelog section, a dev-only file
   leaking into the archive) the release is **not** created — fix it, delete the
   tag (`git push origin :v0.5.0`), and re-tag.

5. **Grab the SHA** for the community-marketplace submission (optional):

   ```sh
   git rev-list -n 1 v0.5.0      # full 40-char SHA — needed for awesome-copilot
   ```

> Doing it by hand instead? `gh release create v0.5.0 --title v0.5.0
> --notes-file <(awk '/^## \[0.5.0\]/{f=1;next}/^## \[/{f=0}f' docs/CHANGELOG.md)`
> reproduces what the workflow does.

## Publishing to the marketplace

There are three ways users can get the plugin; pick per audience.

### A. Direct install (works immediately, no marketplace)

Any Copilot CLI user can install straight from the repo once it's public:

```sh
copilot plugin install hellices/ghcp-maestro
copilot plugin list
```

### B. Self-served marketplace (this repo, no approval)

`.github/plugin/marketplace.json` makes this repo its own marketplace. Users:

```sh
copilot plugin marketplace add hellices/ghcp-maestro
copilot plugin install ghcp-maestro@ghcp-maestro
```

Keep `marketplace.json`'s versions in step with `plugin.json` on every release.

### C. Community marketplace (`github/awesome-copilot`)

For broad discoverability, submit to the community marketplace. It uses an
**issue-based intake**, not a direct PR:

1. Open the "External Plugin Submission" issue at
   <https://github.com/github/awesome-copilot/issues/new/choose>.
2. Provide: name `ghcp-maestro`, repo `hellices/ghcp-maestro`, path `/`, the
   tag `ref` (`v0.5.0`) **and** the full `sha` from step 4, version `0.5.0`,
   license `MIT`, author + keywords.
3. Automated intake runs `vally lint` + an install smoke test; on pass it's
   labeled `ready-for-review`, a maintainer approves, and automation opens the
   PR that lists the plugin. Then users run
   `copilot plugin install ghcp-maestro@awesome-copilot`.

The `ref`/`sha` must be immutable (a release tag, never a branch) — which is why
steps 4–5 come first.

## Pre-publish checklist

- [ ] Versions synced in all four files + tag `v<version>` == `plugin.json`
- [ ] `docs/CHANGELOG.md` has a dated `[<version>]` section
- [ ] `npm run check` green on `main`
- [ ] `git archive … | tar -t` shows only the installable files
- [ ] Repo is **public**
- [ ] Local install works: `copilot plugin install ./`
- [ ] Push tag `v<version>` → **Release** workflow goes green and publishes the
      GitHub Release
- [ ] (Optional) `awesome-copilot` submission filed with `ref` + `sha`
