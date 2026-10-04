# edge/ — J.A.R.V.I.S. device agent (Go)

A single static binary that replaces the Node/Express agent this repo used to
carry in `vercel-leg/termux/`.

## Why this exists

The audit found the previous device agent was an **unauthenticated remote code
execution surface**. The full chain, all of which has been removed:

| Was | Problem |
|---|---|
| `vercel-leg/termux/server.js` → `POST /execute` → `execSync(command)` | **no authentication of any kind** — only `typeof command !== "string"` |
| `app.listen(PORT, "0.0.0.0")` | port 3900 exposed to the carrier network and every LAN the device joined |
| `vercel-leg/termux/start.sh` → `cloudflared tunnel --url` | published it to the open internet on a `trycloudflare.com` URL; quick tunnels are documented by Cloudflare as having **no access control** |
| `vercel-leg/termux/boot/10-jarvis.sh` | re-established that tunnel on every device boot |
| `vercel-leg/utils/termux_executor.py` blocklist | the only safety net, and it lived in the **cloud client**, so a direct POST never reached it. Bypassed by `$(echo … \| base64 -d)`, `python -c "import urllib…"`, `r''m -rf /sdcard` |
| `vercel-leg/api/orchestrator.py` `do_POST` | **no auth**, and it dispatched to `termux_command` |
| `vercel-leg/termux/anyclaw-server.js` → `POST /writefile` | arbitrary file write with `mkdirSync(recursive)`, also unauthenticated |

The `termux_command`, `device_read_file`, `device_write_file` and
`device_list_dir` tools have been removed from the LLM tool schema and from the
orchestrator dispatcher, so the model can no longer reach a device.

## What this binary does differently

- **A token is mandatory.** No token ⇒ the process refuses to start. There is
  no "run without auth" flag, because that is how the old agent ended up public.
- **Loopback by default.** `127.0.0.1:3900`. Opening the socket is a
  deliberate act, and a warning is logged when it is not loopback.
- **Policy is enforced server-side**, in `internal/policy`, from the same
  principles as `cf/src/lib/constitutional_guard.ts` (`no_destroy`,
  `no_exfiltrate`, `no_money`, `no_autonomy_destructive`).
- **Filesystem access is allowlisted by root**, with symlink resolution, and is
  read-only unless `--allow-write`. With no roots configured, all path access
  is denied.
- **Denials are visible.** A refused command answers `403` with the rule and
  reason. The old agent answered `200 {"success": true}` for a refusal, so an
  orchestrator could not tell a deny from a run.
- **Timeouts actually kill.** `context` + `exec.CommandContext` with a custom
  `Cancel` that signals the whole process group, plus `cmd.WaitDelay` to bound
  the wait on pipes that a surviving grandchild would otherwise hold.
  Measured: without `WaitDelay`, a 300 ms timeout on `sh -c "sleep 3; …"`
  returned after 3.06 s.
- **Writes are `0600`**, not the previous default-umask result.
- **Bounded everywhere**: body size, header size, output size, file read size,
  and a shutdown deadline.

## Build

```sh
make            # build for the host
make dist       # cross-compile the release matrix into dist/
make test       # go test ./...
make check      # gofmt -l + go vet + test
```

`make dist` produces statically linked binaries with `CGO_ENABLED=0`:

```
dist/jarvis-edge_linux_arm64      6.2M
dist/jarvis-edge_linux_amd64      6.7M
dist/jarvis-edge_linux_arm        6.6M
dist/jarvis-edge_android_arm64    6.9M
dist/jarvis-edge_darwin_arm64     6.3M
```

That is the whole point of using Go here: the old agent needed
`pkg install nodejs`, `npm init`, `npm install express`, a `node_modules` tree
and a process supervisor. This is one file with no runtime dependency at all.

## Run

The token is required. A token file is preferred so it never appears in `ps`.

```sh
umask 077
mkdir -p ~/.jarvis && head -c 32 /dev/urandom | base64 > ~/.jarvis/token
chmod 600 ~/.jarvis/token

./jarvis-edge \
  --token-file ~/.jarvis/token \
  --listen 127.0.0.1:3900 \
  --roots ~/jarvis-workspace \
  --timeout 30
```

Refuses to start if the token file is group- or world-readable.

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--token` | `JARVIS_EDGE_TOKEN` | — | bearer token |
| `--token-file` | `JARVIS_EDGE_TOKEN_FILE` | — | file holding the token (must be `0600`) |
| `--listen` | `JARVIS_EDGE_LISTEN` | `127.0.0.1:3900` | bind address |
| `--roots` | `JARVIS_EDGE_ROOTS` | — | comma-separated allowed roots; **empty denies all path access** |
| `--allow-write` | `JARVIS_EDGE_ALLOW_WRITE` | off | permit writes |
| `--allow-net` | `JARVIS_EDGE_ALLOW_NET` | off | permit network/egress tools |
| `--timeout` | `JARVIS_EDGE_TIMEOUT` | `30` | per-command seconds |

## API

Authenticate with `Authorization: Bearer <token>` or `X-Device-Key: <token>`
(the latter is what the existing long-poll client in
`vercel-leg/api/` speaks, so this drops into the existing protocol).

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/healthz`, `/ping` | no | liveness only; discloses nothing |
| GET | `/status` | yes | hostname, uptime |
| POST | `/execute` | yes | `{"command": "…"}`; `403` + `rule`/`reason` when denied |
| POST | `/readfile` | yes | `{"filepath": "…"}` |
| POST | `/writefile` | yes | `{"filepath": "…", "content": "…"}` |
| POST | `/listdir` | yes | `{"dirpath": "…"}` |

## Honest limitation

`internal/policy` is a lexical screen, not a sandbox. Any shell invocation
admits an unbounded number of equivalent spellings, so no denylist of this
shape can be sound on its own — which is exactly the lesson of the blocklist it
replaces, and `TestOldBlocklistBypassesAreNowDenied` documents the concrete
bypasses it does close. The load-bearing controls are the **token**, the
**loopback default**, and not pointing a `cloudflared tunnel --url` quick
tunnel at it. If you need to expose this, use a **named** tunnel with a
Cloudflare Access policy, and keep the token.