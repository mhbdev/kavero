import type { CatalogDocument } from "@Kavero/catalog-engine";
import {
  applyCloudLink, assertExpected, assertValid, summarize, type CatalogRepository, type CatalogSummary, type CloudLink, type SaveOptions, type StoredAsset,
} from "./repository";

const DB_NAME = "kavero";
const DB_VERSION = 2;
const DOCS = "documents";
const SUMMARIES = "summaries";
const ASSETS = "assets";
const BLOBS = "assetBlobs";

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
  });
}

/**
 * Browser persistence. Documents and summaries are separate stores so the
 * dashboard lists catalogs without loading every slide. Assets are Blobs,
 * never inlined into the document JSON.
 */
export class IndexedDbCatalogRepository implements CatalogRepository {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly dbName = DB_NAME, private readonly factory: IDBFactory = globalThis.indexedDB) {}

  private db(): Promise<IDBDatabase> {
    if (!this.factory) return Promise.reject(new Error("IndexedDB is not available in this environment"));
    this.dbPromise ??= new Promise((resolve, reject) => {
      const open = this.factory.open(this.dbName, DB_VERSION);
      open.onupgradeneeded = (event) => {
        const db = open.result;
        if (!db.objectStoreNames.contains(DOCS)) db.createObjectStore(DOCS, { keyPath: "id" });
        if (!db.objectStoreNames.contains(SUMMARIES)) db.createObjectStore(SUMMARIES, { keyPath: "id" }).createIndex("updatedAt", "updatedAt");
        const blobs = db.objectStoreNames.contains(BLOBS) ? open.transaction!.objectStore(BLOBS) : db.createObjectStore(BLOBS, { keyPath: "hash" });
        const assets = db.objectStoreNames.contains(ASSETS)
          ? open.transaction!.objectStore(ASSETS)
          : db.createObjectStore(ASSETS, { keyPath: "id" });
        if (!assets.indexNames.contains("catalogId")) assets.createIndex("catalogId", "catalogId");
        if (!assets.indexNames.contains("hash")) assets.createIndex("hash", "hash");
        if (event.oldVersion > 0 && event.oldVersion < 2) {
          const cursorRequest = assets.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const old = cursor.value as StoredAsset;
            const hash = old.hash || old.id;
            if (old.blob instanceof Blob) blobs.put({ hash, blob: old.blob });
            cursor.update({ id: old.id, catalogId: old.catalogId, hash });
            cursor.continue();
          };
        }
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error("Kavero storage is blocked by another open tab. Close other tabs and retry."));
    });
    return this.dbPromise;
  }

  async list(): Promise<CatalogSummary[]> {
    const db = await this.db();
    const all = await req(db.transaction(SUMMARIES).objectStore(SUMMARIES).getAll() as IDBRequest<CatalogSummary[]>);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<CatalogDocument | null> {
    const db = await this.db();
    return ((await req(db.transaction(DOCS).objectStore(DOCS).get(id))) as CatalogDocument | undefined) ?? null;
  }

  async getSummary(id: string): Promise<CatalogSummary | null> {
    const db = await this.db();
    return ((await req(db.transaction(SUMMARIES).objectStore(SUMMARIES).get(id))) as CatalogSummary | undefined) ?? null;
  }

  async getWithSummary(id: string): Promise<{ document: CatalogDocument; summary: CatalogSummary } | null> {
    const db = await this.db();
    const tx = db.transaction([DOCS, SUMMARIES]);
    const [document, summary] = await Promise.all([
      req(tx.objectStore(DOCS).get(id)) as Promise<CatalogDocument | undefined>,
      req(tx.objectStore(SUMMARIES).get(id)) as Promise<CatalogSummary | undefined>,
    ]);
    return document && summary ? { document, summary } : null;
  }

  async save(doc: CatalogDocument, { expect, ...extra }: SaveOptions = {}): Promise<CatalogSummary> {
    const valid = assertValid(doc);
    const db = await this.db();
    const tx = db.transaction([DOCS, SUMMARIES], "readwrite");
    const summaries = tx.objectStore(SUMMARIES);
    const prev = ((await req(summaries.get(doc.id))) as CatalogSummary | undefined) ?? null;
    // Compare-and-swap inside the transaction, so no other tab can write in between.
    try {
      assertExpected(doc.id, prev, expect);
    } catch (e) {
      tx.abort();
      throw e;
    }
    const summary = { ...summarize(valid, prev), ...extra };
    tx.objectStore(DOCS).put(valid);
    summaries.put(summary);
    await done(tx);
    return summary;
  }

  async delete(id: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction([DOCS, SUMMARIES, ASSETS, BLOBS], "readwrite");
    tx.objectStore(DOCS).delete(id);
    tx.objectStore(SUMMARIES).delete(id);
    const assets = tx.objectStore(ASSETS);
    const refs = await req(assets.index("catalogId").getAll(id)) as Array<{ id: string; hash: string }>;
    for (const ref of refs) assets.delete(ref.id);
    for (const hash of new Set(refs.map((ref) => ref.hash))) {
      if (await req(assets.index("hash").count(hash)) === 0) tx.objectStore(BLOBS).delete(hash);
    }
    await done(tx);
  }

  async setCloudLink(id: string, link: CloudLink | null, syncedRevision?: number): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(SUMMARIES, "readwrite");
    const store = tx.objectStore(SUMMARIES);
    const prev = (await req(store.get(id))) as CatalogSummary | undefined;
    if (!prev) throw new Error("Catalog not found");
    store.put(applyCloudLink(prev, link, syncedRevision));
    await done(tx);
  }

  async putAsset(asset: StoredAsset): Promise<void> {
    const db = await this.db();
    const hash = await sha256(asset.blob);
    const tx = db.transaction([ASSETS, BLOBS], "readwrite");
    const assets = tx.objectStore(ASSETS);
    const previous = await req(assets.get(asset.id)) as { id: string; hash: string } | undefined;
    assets.put({ id: asset.id, catalogId: asset.catalogId, hash });
    tx.objectStore(BLOBS).put({ hash, blob: asset.blob });
    if (previous && previous.hash !== hash && await req(assets.index("hash").count(previous.hash)) === 0) tx.objectStore(BLOBS).delete(previous.hash);
    await done(tx);
  }

  async removeAsset(id: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction([ASSETS, BLOBS], "readwrite");
    const assets = tx.objectStore(ASSETS);
    const previous = await req(assets.get(id)) as { hash: string } | undefined;
    assets.delete(id);
    if (previous && await req(assets.index("hash").count(previous.hash)) === 0) tx.objectStore(BLOBS).delete(previous.hash);
    await done(tx);
  }

  async getAsset(id: string): Promise<StoredAsset | null> {
    const db = await this.db();
    const tx = db.transaction([ASSETS, BLOBS]);
    const ref = await req(tx.objectStore(ASSETS).get(id)) as { id: string; catalogId: string; hash: string } | undefined;
    if (!ref) return null;
    const stored = await req(tx.objectStore(BLOBS).get(ref.hash)) as { blob?: Blob } | undefined;
    return stored?.blob ? { ...ref, blob: stored.blob } : null;
  }

  async listAssets(catalogId: string): Promise<StoredAsset[]> {
    const db = await this.db();
    const tx = db.transaction([ASSETS, BLOBS]);
    const refs = await req(tx.objectStore(ASSETS).index("catalogId").getAll(catalogId)) as Array<{ id: string; catalogId: string; hash: string }>;
    const blobs = await Promise.all(refs.map((ref) => req(tx.objectStore(BLOBS).get(ref.hash)) as Promise<{ blob?: Blob } | undefined>));
    return refs.flatMap((ref, index) => blobs[index]?.blob ? [{ ...ref, blob: blobs[index]!.blob! }] : []);
  }
}

async function sha256(blob: Blob): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
