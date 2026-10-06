# Mission service and dashboard

`autoresearch_service` turns the manual "point an agent at `program.md`" loop
into a long-running service that is driven by a message queue and observed
through an SSO-protected dashboard.

```
                    ┌──────────────────────────── AWS ─────────────────────────────┐
  corporate SSO ──► Cognito (SAML/OIDC)                                            │
                    │        ▲                                                     │
  browser ────────► CloudFront ── Lambda@Edge (auth.js) ──┬──► S3  /index.html,    │
                    │   research.corp.example.com         │       /app.js, ...     │
                    │                                     ├──► S3  /data/*  ◄──────┼──── writes ─┐
                    │                                     └──► API Gateway (JWT)    │             │
                    │                                              │ POST /api/commands            │
                    │                                              ▼                │             │
                    │                                           SQS commands ───────┼── consumes ─┤
                    └──────────────────────────────────────────────────────────────┘             │
                                                                                                  │
  GPU host:  python -m autoresearch_service run   ── git worktree ── uv run train.py ─────────────┘
```

* **Commands in** – any producer (the dashboard, a cron job, another service)
  publishes a JSON command to the queue. Supported backends: Amazon SQS,
  Redis, or a local directory for development.
* **Missions** – a `start_mission` command carries a *mission*: which branch
  to work on, how experiments are proposed, and when to stop. The service runs
  one mission at a time on the local GPU, queueing the rest.
* **Results out** – after every experiment the service writes the full mission
  record, a service heartbeat/index and the JSON Schema to a *result store*
  (S3 prefix or local directory). The dashboard is a static site that reads
  those files, so it needs no backend of its own.

## The mission schema

The authoritative schema is generated from the Pydantic models in
`autoresearch_service/schema.py` and published to
`<store>/schema/mission.schema.json` on start-up. Print it locally with:

```bash
uv run --extra service python -m autoresearch_service schema           # mission
uv run --extra service python -m autoresearch_service schema command   # queue command envelope
uv run --extra service python -m autoresearch_service example          # a filled-in example
```

Key fields:

| field | meaning |
|---|---|
| `name`, `tag` | Display name and run tag. Work happens on branch `autoresearch/<tag>`, which must not exist yet. |
| `base_ref` | Git ref to branch from (default `master`). |
| `strategy.type = "sweep"` | Run a fixed list of `experiments`, each a `description` plus `overrides` for the hyperparameter constants at the top of `train.py` (`MATRIX_LR`, `DEPTH`, ...). Only the listed constants can be changed; nothing else in the file is touched. |
| `strategy.type = "agent"` | Per iteration, invoke an external coding-agent CLI (`command`, with `{prompt_file}` / `{description_file}` / `{worktree}` placeholders) inside the worktree. The prompt contains `program.md`, the mission objective, results so far and any extra `instructions`. The agent edits `train.py`; the service commits, trains and judges. |
| `keep_policy` | Metric/direction, minimum improvement needed to keep a change, optional VRAM ceiling. |
| `budget` | `max_experiments`, optional `max_duration_minutes`, and a per-run `experiment_timeout_minutes` after which the training process is killed and recorded as a crash. |

Commands (`command` is the discriminator):

| command | effect |
|---|---|
| `start_mission` | Validate and queue a mission. |
| `pause_mission` / `resume_mission` | Pause after the current experiment finishes; resume later. |
| `stop_mission` | Let the current experiment finish, record it, then end the mission. |
| `cancel_mission` | Kill the running experiment immediately (or drop a queued mission). |
| `ping`, `publish_schema` | Health check; re-publish the schema files. |

Every command carries a `request_id` (generated if omitted) used for
idempotency, so at-least-once queue delivery is safe.

## How a mission runs

The loop is the one described in `program.md`, with the harness doing the
bookkeeping instead of the agent:

1. `git worktree add worktrees/<tag> -b autoresearch/<tag> <base_ref>`
2. Experiment 0 is always the untouched baseline.
3. For each further experiment: apply the change (sweep overrides or agent
   edit), commit, run `uv run --project <repo> python train.py > run.log`,
   parse the `val_bpb` / `peak_vram_mb` summary.
4. Keep (branch advances) or discard (`git reset --hard`) per `keep_policy`.
   Crashes and timeouts are recorded with the tail of `run.log`.
5. `results.tsv` is maintained in the worktree exactly as `program.md`
   specifies, so `analysis.ipynb` still works on a finished mission.

Pause/stop are honoured between experiments; cancel kills the training
process group. If the service restarts mid-mission, the mission is marked
`failed` on recovery and queued missions are re-queued.

## Running the service on the GPU host

```bash
uv sync --extra service          # adds pydantic + boto3 (and relocks uv.lock)
export AUTORESEARCH_QUEUE_URL="https://sqs.eu-west-1.amazonaws.com/123456789012/autoresearch-commands"
export AUTORESEARCH_STORE_URL="s3://autoresearch-dashboard-123456789012/data/"
uv run python -m autoresearch_service run
```

Credentials come from the usual AWS chain; attach the `autoresearch-service`
instance profile created by Terraform (or assume the role). Other knobs:

| env var / flag | default | purpose |
|---|---|---|
| `AUTORESEARCH_REPO_DIR` / `--repo-dir` | cwd | The autoresearch checkout to run missions in. |
| `AUTORESEARCH_QUEUE_URL` / `--queue-url` | `./queue` | SQS URL, `redis://host/0?key=...`, or a local directory. |
| `AUTORESEARCH_STORE_URL` / `--store-url` | `./results` | `s3://bucket/prefix/` or a local directory. |
| `AUTORESEARCH_WORKTREES_DIR` | `<repo>/worktrees` | Where mission worktrees are created (already git-ignored). |
| `AUTORESEARCH_TRAIN_COMMAND` / `--train-command` | `uv run --project <repo> python train.py` | Override the training command (tests use a fake trainer). |
| `AUTORESEARCH_POLL_SECONDS`, `AUTORESEARCH_HEARTBEAT_SECONDS` | 10 / 30 | Queue long-poll wait and index refresh cadence. |

A minimal systemd unit:

```ini
[Unit]
Description=autoresearch mission service
After=network-online.target

[Service]
User=research
WorkingDirectory=/opt/autoresearch
Environment=AUTORESEARCH_QUEUE_URL=https://sqs.eu-west-1.amazonaws.com/123456789012/autoresearch-commands
Environment=AUTORESEARCH_STORE_URL=s3://autoresearch-dashboard-123456789012/data/
ExecStart=/home/research/.local/bin/uv run python -m autoresearch_service run
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### Local development (no AWS)

```bash
uv run --extra service python -m autoresearch_service run --with-devserver \
    --queue-url ./queue --store-url ./results
# dashboard at http://127.0.0.1:8080/ (unauthenticated; devserver reports you as dev@localhost)

# enqueue a mission from the CLI
uv run --extra service python -m autoresearch_service example > mission.json
uv run --extra service python -m autoresearch_service send start_mission --mission mission.json --queue-url ./queue
```

The dev server mimics the AWS edge: it serves `dashboard/`, exposes the store
under `/data/`, answers `/api/me`, and turns `POST /api/commands` into a queue
message.

## Dashboard

`dashboard/` is a dependency-free static site (plain ES modules, no build
step). Views:

* **Overview** – service heartbeat, GPU, current/queued missions, last
  command, and a searchable, filterable history of every mission.
* **Mission** – baseline/best/improvement cards, a `val_bpb` progress chart
  (kept, discarded, crashed, running-best frontier, baseline line), the
  experiment table with per-experiment deltas, overrides and crash logs, the
  event timeline, and Pause / Resume / Stop / Cancel / Clone actions.
* **New mission** – a form prefilled with a working sweep (name, tag, one
  experiment). Empty optional fields show placeholders, including the
  `train.py` baseline next to every hyperparameter. A side panel shows the
  schema entry for the focused field and the exact JSON that will be sent,
  validated in the browser before submit. Example and agent templates too.
* **Schema** – the mission and command schemas rendered as documentation:
  each field with its description, required/optional, constraints and an
  example, plus a copyable payload for every command. Raw JSON stays
  downloadable.

Runtime configuration lives in `dashboard/config.js` (`dataBaseUrl`,
`apiBaseUrl`, `refreshSeconds`).

## AWS deployment (S3 static hosting behind internal SSO)

Everything is in `infra/terraform`; see `terraform.tfvars.example`.

Design:

* The S3 bucket is private (public access blocked, OAC-only reads). "Static
  hosting" is done by CloudFront, which is the only principal allowed to read
  objects.
* A Lambda@Edge viewer-request function (`infra/edge/auth.js`) runs on **every**
  request. Without a valid session cookie it starts an OpenID Connect
  authorization-code + PKCE flow against the Cognito hosted UI, which is
  federated to your corporate IdP (SAML or OIDC). Cognito has no local users:
  the app client only lists the federated provider. Optional allow-lists on
  email domain and group membership are enforced at the edge.
* ID tokens are verified at the edge against the user pool JWKS (RS256,
  issuer, audience, expiry) before any object is served from S3 — including
  `/data/*`.
* `POST /api/commands` is routed by CloudFront to an API Gateway HTTP API with
  a Cognito JWT authorizer and a direct `SQS-SendMessage` integration (no
  Lambda in the request path). The edge function forwards the ID token as a
  Bearer header and overwrites `issued_by` in the command body with the
  verified email, so the service's audit trail cannot be spoofed by the
  client. Viewer-request body access caps the body at 40 KB, which is ample
  for a mission.
* `/api/me` and `/auth/logout` are answered at the edge.

Deploy:

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # fill in hostname, cert, IdP details
terraform init && terraform apply

# Register the SAML/OIDC outputs (entity id, ACS URL / redirect URI) in your IdP,
# then create a CNAME: <domain_name> -> <cloudfront_domain_name>.

cd ../..
scripts/deploy_dashboard.sh "$(terraform -chdir=infra/terraform output -raw dashboard_bucket)" \
                            "$(terraform -chdir=infra/terraform output -raw cloudfront_distribution_id)"
```

Then start the service on the GPU host with the `commands_queue_url` and
`store_url` outputs. The `publish_schema` command (or a restart) populates
`/data/schema/*.json`.

## Tests

```bash
uv run --extra service --group dev pytest          # service, runner (with a fake trainer), queues, store, devserver
node --test infra/edge/auth.test.js                 # edge auth function
node --test dashboard/lib/mission-form.test.js       # form prefill, placeholders, schema doc
terraform -chdir=infra/terraform validate
```
