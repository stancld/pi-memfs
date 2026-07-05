# pi-memfs

Experiment: a sandbox-free workspace for Pi agents. File tools (`read`,
`write`, `edit`, `ls`, `grep`, `find`) run against an **in-memory virtual
filesystem** — metadata per `chat_id` in PostgreSQL, file contents as
content-addressed blobs in S3. No bash, no containers, no real FS.

See [DESIGN_DOC.md](DESIGN_DOC.md) for the concept and the code snippets to
materialize.

## Run

```sh
npm install
cp .env.sample .env   # fill in Postgres / S3 / AWS
npm start
```

`schema.sql` holds the Postgres DDL:

```sh
psql "$DATABASE_URL" -f schema.sql
```
