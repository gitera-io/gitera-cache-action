# Gitera Cache

> Work in progress. This build only checks its inputs; caching is not active yet.

A remote build cache for GitHub Actions, stored by Gitera. One step gives you:

- a remote cache for **Turbo** and **Nx**, and
- a cache for **any folder**, with the same inputs as `actions/cache`.

Each cache belongs to one repository. Pull requests (also from forks) read
the repository's cache but write only to their own, so a pull request can
never plant a file that the default branch later restores.

Requires a paid Gitera plan with the GitHub App installed on the repository.

## Turbo and Nx

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - uses: actions/checkout@v4
  - uses: gitera-io/gitera-cache-action@v1
  - run: npx turbo run build    # or: npx nx run-many -t build
```

The action starts a local cache server for the job and sets `TURBO_API`,
`TURBO_TOKEN`, `TURBO_TEAM` and `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` for the
steps after it.

## Any folder

```yaml
- uses: gitera-io/gitera-cache-action@v1
  with:
    path: |
      ~/.cache/pip
      node_modules
    key: deps-${{ runner.os }}-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      deps-${{ runner.os }}-
```

| Input | Default | |
|---|---|---|
| `path` | | Files, folders or globs, one per line. Turns on folder mode. |
| `key` | | Exact key to restore and save. Required with `path`. |
| `restore-keys` | | Key prefixes to fall back to, most specific first. |
| `lookup-only` | `false` | Only check whether the key exists. |
| `fail-on-cache-miss` | `false` | Fail the step when no key matches. |
| `tools` | `auto` | Build-tool cache: `auto`, `turbo`, `nx` or `none`. |
| `api-url` | `https://app.gitera.io` | Gitera API base URL. |

| Output | |
|---|---|
| `cache-hit` | `true` when the exact key was restored. |
| `cache-matched-key` | The key that was restored. |

The folder is saved at the end of the job, only when the job succeeded.

## Permissions

`id-token: write` lets the action prove which repository and run it is.
No Gitera secret is needed.

## Failures never break the build

If Gitera or the storage cannot be reached, a read becomes a miss and a write
is skipped, with a warning.
