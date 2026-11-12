# Gitera Cache

> Full guide: [docs.gitera.io/docs/remote-cache](https://docs.gitera.io/docs/remote-cache). Remote cache is in beta.

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

The folder is saved at the end of the job, only when the job succeeded, and
not when the exact key was restored. Files are packed with `tar` (zstd when
the runner has it, else gzip) and restored to the same absolute paths, so a
cache only matches jobs with the same `path` list, compression and OS. Linux
and macOS runners are supported.

### Work started at job start

The action has a `pre` step, which runs when the job starts, before checkout.
It logs in to Gitera in the background, and with `restore-keys` it also
downloads and unpacks the newest match into a folder in `RUNNER_TEMP` while
your first steps run. When the action's own step comes:

- If that match is what a restore would pick now (its name is the key, or
  one lookup returns it), its folders are moved into place in a moment.
- If nothing matched `restore-keys` and the key starts with one of them, the
  miss is known already and no further call is made.
- Otherwise the background work is stopped and the restore runs as usual.

`hashFiles()` in `key` is still empty when the job starts, so the background
download relies on `restore-keys`. It only uses `RUNNER_TEMP` and never
touches your workspace before the action's step runs.

## Permissions

`id-token: write` lets the action prove which repository and run it is.
No Gitera secret is needed.

## Failures never break the build

If Gitera or the storage cannot be reached, a read becomes a miss and a write
is skipped, with a warning.
