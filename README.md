# pi-memfs

Experiment: a sandbox-free workspace for Pi agents. Tools (`read`, `write`,
`ls`, `jq`) read and write files in **S3, scoped by `chat_id`** — no bash, no
containers, no real FS, no database. Every write is a new timestamped version;
"latest" wins.

See [DESIGN_DOC.md](DESIGN_DOC.md) for the concept and the code snippets to
materialize.

## Run

```sh
npm install
cp .env.sample .env                        # fill in S3 / AWS creds
docker compose up -d minio createbuckets   # local S3 (MinIO) + bucket
npm start -- --chat demo
```

Requires the `jq` binary on PATH.
