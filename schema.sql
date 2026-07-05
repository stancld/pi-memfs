-- pi-memfs metadata store. Blobs live in S3 at blobs/{chat_id}/{blob_sha}.
CREATE TABLE IF NOT EXISTS vfs_files (
  chat_id    text        NOT NULL,
  path       text        NOT NULL, -- normalized, '/'-rooted: '/notes/plan.md'
  blob_sha   text        NOT NULL, -- sha256 hex of content
  size       integer     NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, path)
);
