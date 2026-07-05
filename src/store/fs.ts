import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

/** Fixed-width UTC stamp, so lexical order == chronological order. */
function timestamp(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, ""); // "20260705120000000"
}

/** Cosmetic only — one canonical key per logical path. Not a security boundary. */
function normalize(path: string): string {
  if (path.includes("@"))
    throw new Error(`invalid path (@ is reserved): ${path}`);
  return path.replace(/\/+/g, "/").replace(/^\/|\/$/g, ""); // "notes/plan.md"
}

export class VirtualFs {
  constructor(
    private readonly chatId: string,
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  /** All keys under a prefix, sorted oldest→newest (fixed-width stamp ⇒ lexical == chronological). */
  private async keysUnder(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const o of res.Contents ?? []) keys.push(o.Key!);
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return keys.sort();
  }

  async read(path: string): Promise<string> {
    const key = (await this.keysUnder(`${this.chatId}/${normalize(path)}@`)).at(
      -1,
    ); // newest
    if (!key) throw new Error(`ENOENT: ${path}`);
    const res = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return res.Body!.transformToString();
  }

  async write(path: string, content: string): Promise<void> {
    const key = `${this.chatId}/${normalize(path)}@${timestamp()}`;
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: content }),
    );
  }

  async ls(): Promise<string[]> {
    const keys = await this.keysUnder(`${this.chatId}/`);
    const paths = new Set(
      keys.map((k) => k.slice(this.chatId.length + 1, k.lastIndexOf("@"))),
    );
    return [...paths].sort();
  }
}
