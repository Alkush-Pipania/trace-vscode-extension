import * as fs from "fs";
import * as path from "path";
import { EventBatch } from "./types";

declare const __dirname: string;

// Save events.jsonl in the extension folder for easy visibility during dev.
const BUFFER_DIR = path.resolve(__dirname, "..");
const EVENTS_FILE = path.join(BUFFER_DIR, "events.jsonl");
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB — rotate after this

/**
 * Local JSONL file buffer for crash safety.
 *
 * Events are appended to ~/.authorship/events.jsonl as newline-delimited JSON.
 * If the Ingestion Service is down, events accumulate here and are retried later.
 *
 * This is the last line of defense — if the editor crashes, if the network is down,
 * events survive on disk.
 */
export class LocalBuffer {
  private readonly filePath: string;
  private writeStream: fs.WriteStream | null = null;

  constructor(filePath: string = EVENTS_FILE) {
    this.filePath = filePath;
    this.ensureDir();
  }

  /**
   * Append a batch of events to the local buffer file.
   * Each event is written as a separate JSON line for easy streaming reads.
   */
  append(batch: EventBatch): void {
    const stream = this.getStream();
    for (const event of batch.events) {
      stream.write(JSON.stringify(event) + "\n");
    }
  }

  /**
   * Read all buffered events from disk.
   * Returns parsed events and clears the file.
   */
  drain(): EventBatch | null {
    this.closeStream();

    if (!fs.existsSync(this.filePath)) return null;

    const content = fs.readFileSync(this.filePath, "utf-8").trim();
    if (!content) return null;

    const events = content
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((e) => e !== null);

    if (events.length === 0) return null;

    // Truncate the file after successful read
    fs.writeFileSync(this.filePath, "");

    return {
      events,
      installation_id: "",
      sent_at: Date.now(),
    };
  }

  /**
   * Number of lines (events) currently buffered on disk.
   */
  lineCount(): number {
    if (!fs.existsSync(this.filePath)) return 0;
    const content = fs.readFileSync(this.filePath, "utf-8");
    return content.split("\n").filter((l) => l.length > 0).length;
  }

  /**
   * Rotate the buffer file if it exceeds the size limit.
   * Old events are moved to a timestamped archive file.
   */
  rotateIfNeeded(): void {
    if (!fs.existsSync(this.filePath)) return;
    const stat = fs.statSync(this.filePath);
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      this.closeStream();
      const archive = this.filePath + `.${Date.now()}.bak`;
      fs.renameSync(this.filePath, archive);
    }
  }

  dispose(): void {
    this.closeStream();
  }

  private ensureDir(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private getStream(): fs.WriteStream {
    if (!this.writeStream || this.writeStream.destroyed) {
      this.writeStream = fs.createWriteStream(this.filePath, { flags: "a" });
    }
    return this.writeStream;
  }

  private closeStream(): void {
    if (this.writeStream && !this.writeStream.destroyed) {
      this.writeStream.end();
      this.writeStream = null;
    }
  }
}
