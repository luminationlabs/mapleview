import { Directory, File, Paths } from "expo-file-system";

const storageDir = new Directory(Paths.document, "kvstore");

function fileFor(key: string): File {
  return new File(storageDir, encodeURIComponent(key));
}

function ensureDir() {
  if (!storageDir.exists) storageDir.create({ idempotent: true });
}

export const kvStorage = {
  async getItem(key: string): Promise<string | null> {
    try {
      const file = fileFor(key);
      if (!file.exists) return null;
      return await file.text();
    } catch {
      return null;
    }
  },
  async setItem(key: string, value: string): Promise<void> {
    try {
      ensureDir();
      fileFor(key).write(value);
    } catch {
      // swallow to preserve fire-and-forget call sites
    }
  },
  async removeItem(key: string): Promise<void> {
    try {
      const file = fileFor(key);
      if (file.exists) file.delete();
    } catch {
      // ignore
    }
  },
};
