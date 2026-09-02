# Level 10 — Free Tier Optimization & Monitoring Guide

Fly.io free allowances that constrain this system:
- **3 × shared-cpu-1x 256MB VMs** (total, all regions)
- **3GB persistent volume** (total, all regions)

Follow this to stay inside those numbers and degrade gracefully.

## 1. Memory profiling & reduction

The container is a single Uvicorn worker on a 256MB instance. To keep RSS down:

- Set `PYTHONHASHSEED=0`, `OMP_NUM_THREADS=1` (avoid thread oversubscription).
- Set `MPLCONFIGDIR=/tmp` and disable heavy libs (torch/tensorflow are NOT in
  the Dockerfile runtime image — they only run on Oracle/Colab).
- Use `/tmp` (RAM-backed or ephemeral) for scratch — it disappears on destroy.
- `MAX_CONCURRENT` workers = 2, so transient memory spikes are isolated.

Profile the running box:

```bash
fly ssh console
ps -o rss,vsz,comm -p 1                 # RSS is what matters vs 256MB
cat /sys/fs/cgroup/memory/memory.usage_in_bytes
```

Deploy a version with periodic RSS logging in `api/fly_app.py`'s `/health` if
you want an external signal. Watch for RSS > ~80% → split the workload (reserve
ephemeral machines for burst rather than growing the primary).

## 2. Machine sizing calculator (free tier)

We have 256MB × 3 machines and 3GB disk. Allocate by responsibility:

| Slot | Role | Memory | Volume | Always-on? |
|---|---|---|---|---|
| 1 | Primary app (sin) | 256MB | `/data/jarvis` 1-2GB | Yes |
| 2 | Failover standby (nrt) | 256MB | read-only/0 | auto-stop |
| 3 | Ephemeral burst / legacy monitor | 256MB | 0 (tmpfs) | as needed |

Rule: any third capacity comes at the cost of the failover or monitor. If you
need ephemeral workers, run them in slot 3 and let the legacy monitor alternate
(they are not simultaneous).

Volume: 3GB each for one slice. Keep only encrypted blobs + compact state on the
volume; the real corpus lives in Supabase. Do **not** shard the volume across
regions in the free tier.

## 3. Cost estimation per operation

Under free tier most continuous ops cost $0. The billable risks are:

| Operation | Free-tier exposure |
|---|---|
| Always-on primary (sin) | $0 (1st shared-cpu-1x 256MB) |
| Failover standby (nrt) | $0 while auto-stopped; ~0 if started |
| Ephemeral worker burst | Tiny CPU-seconds; auto-destroy prevents real cost |
| Volume growth | Exceeding 3GB triggers storage billing |
| Extra machines not destroyed | Each beyond 3 = billable |

Keep `fly.toml` `auto_stop_machines=true` + ephemeral `auto_destroy=true` so
idle capacity collapses to zero and you never run more than 3 machines.

## 4. Alerts for billing / capacity thresholds

- **Machine count** = 3 exactly. Add a fly CLI cron or the L9 monitor to warn
  when `fly machine list` returns > 3 running.
- **Volume usage** > 80% of 3GB. Script:
  ```bash
  fly volumes list | grep -E 'jarvis_state' && du -sh /data/jarvis
  ```
- **Memory RSS** > 200MB on the primary → degrade (below).
- Alert channel: send to the Telegram owner via `OWNER_CHAT_ID`.

## 5. Graceful degradation when approaching limits

Ordered degradation (external knob `JARVIS_AUTO_DEGRADE`):

1. **Disable ephemeral worker bursts** (`ephemeral_worker.MAX_CONCURRENT=0`)
   first — background tasks defer to Oracle/local.
2. **Disable failover standby spin-up** under pressure; stay pinned to primary.
3. **Stop the L9 legacy monitor** last (it is the least compute-hungry, keep it
   running as long as possible).

Implementation is guarded so nothing ever throws: all modules catch and degrade
rather than crash. If memory pressure is CPU from the pipeline, the hybrid
router already prefers Oracle/local for heavy inference, keeping the L10 primary
thin.

## 6. Recommended env (apply via `fly secrets set`)

```bash
JARVIS_EPH_MAX_CONCURRENT=2
JARVIS_EPH_QUEUE_MAX=5
JARVIS_AUTO_DEGRADE=1
LOG_LEVEL=INFO
JARVIS_HEALTH_SKIP_DEPCHECK=0
```

## 7. Daily hygiene

- `fly deploy --strategy rolling` keeps zero downtime on pushes.
- Delete any stray ephemeral machines: `fly machine destroy <id>`.
- Re-run `tools/apply_sql.py` migrations idempotently (no data loss).
- Watch `fly logs -a jarvis-ubiquitous` for repeated OOM/circuit-open logs.