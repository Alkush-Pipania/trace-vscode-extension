import { createHash, randomUUID } from "crypto";
import { EditEvent, ClassificationResult, ChangeType, EventBatch } from "./types";
import { logger } from "./logger";

// ─── UUIDv7-like: time-sortable unique ID ───────────────────────────

let _sequence = 0;

export function generateEventId(): string {
  // UUIDv7: timestamp prefix for natural ordering, random suffix for uniqueness
  const now = Date.now();
  const hex = now.toString(16).padStart(12, "0");
  const seq = (_sequence++ & 0xfff).toString(16).padStart(3, "0");
  const rand = randomUUID().replace(/-/g, "").slice(0, 13);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${seq}-${rand.slice(0, 4)}-${rand.slice(4)}`;
}

// ─── Content Hashing ────────────────────────────────────────────────

export function hashContent(text: string): string {
  if (!text) return "";
  return "sha256:" + createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// ─── Session ID ─────────────────────────────────────────────────────

let _sessionId: string | null = null;

export function getSessionId(): string {
  if (!_sessionId) {
    _sessionId = `sess_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  }
  return _sessionId;
}

export function resetSessionId(): void {
  _sessionId = null;
}

// ─── Build a single EditEvent ───────────────────────────────────────

export interface BuildEventParams {
  filePath: string;
  fileUri: string;
  repoRoot: string;
  lineStart: number; // 1-based
  lineEnd: number; // 1-based, inclusive
  charStart: number;
  charEnd: number;
  text: string;
  changeType: ChangeType;
  classification: ClassificationResult;
}

export function buildEvent(params: BuildEventParams): EditEvent {
  const linesChanged = params.lineEnd - params.lineStart + 1;
  return {
    event_id: generateEventId(),
    event_type: "edit",
    file_path: params.filePath,
    file_uri: params.fileUri,
    repo_root: params.repoRoot,
    line_start: params.lineStart,
    line_end: params.lineEnd,
    char_start: params.charStart,
    char_end: params.charEnd,
    author_type: params.classification.author_type,
    tool_id: params.classification.tool_id,
    content_hash: hashContent(params.text),
    lines_changed: linesChanged,
    change_type: params.changeType,
    session_id: getSessionId(),
    timestamp: Date.now(),
  };
}

// ─── Event Batcher ──────────────────────────────────────────────────
//
// Collects events and flushes when either:
//   - batch reaches maxSize (default 50)
//   - interval timer fires (default 1000ms)
//
// The flush callback receives an EventBatch.

export type FlushCallback = (batch: EventBatch) => void;

export class EventBatcher {
  private queue: EditEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly maxSize: number;
  private readonly intervalMs: number;
  private readonly onFlush: FlushCallback;
  private readonly installationId: string;

  constructor(
    onFlush: FlushCallback,
    opts: { maxSize?: number; intervalMs?: number; installationId?: string } = {}
  ) {
    this.onFlush = onFlush;
    this.maxSize = opts.maxSize ?? 50;
    this.intervalMs = opts.intervalMs ?? 1000;
    this.installationId = opts.installationId ?? "";
    this.startTimer();
  }

  push(event: EditEvent): void {
    logger.debug(`[EventBatcher] Queuing event: ${event.change_type} | Lines: ${event.line_start}-${event.line_end} | Author: ${event.author_type}`);
    this.queue.push(event);
    if (this.queue.length >= this.maxSize) {
      logger.info(`[EventBatcher] Max batch size (${this.maxSize}) reached. Flushing immediately.`);
      this.flush();
    }
  }

  flush(): void {
    if (this.queue.length === 0) return;
    const events = this.queue.splice(0);
    const batch: EventBatch = {
      events,
      installation_id: this.installationId,
      sent_at: Date.now(),
    };
    logger.debug(`[EventBatcher] Firing flush payload to handlers with ${events.length} events`);
    this.onFlush(batch);
  }

  get pending(): number {
    return this.queue.length;
  }

  dispose(): void {
    this.flush();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private startTimer(): void {
    this.timer = setInterval(() => this.flush(), this.intervalMs);
  }
}

// ─── Debouncer ──────────────────────────────────────────────────────
//
// Groups rapid keystrokes into a single logical event.
// After `delayMs` of inactivity, fires the callback with the accumulated context.

export class Debouncer<T> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: T | null = null;
  private readonly delayMs: number;
  private readonly merge: (prev: T, next: T) => T;
  private readonly onFire: (value: T) => void;

  constructor(
    onFire: (value: T) => void,
    merge: (prev: T, next: T) => T,
    delayMs: number = 300
  ) {
    this.onFire = onFire;
    this.merge = merge;
    this.delayMs = delayMs;
  }

  call(value: T): void {
    if (this.pending !== null) {
      this.pending = this.merge(this.pending, value);
    } else {
      this.pending = value;
    }

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.pending !== null) {
        this.onFire(this.pending);
        this.pending = null;
      }
    }, this.delayMs);
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
  }

  hasPending(): boolean {
    return this.pending !== null;
  }

  getPending(): T {
    if (this.pending === null) {
      throw new Error("No pending value");
    }
    return this.pending;
  }

  flush(): void {
    if (this.pending !== null) {
      this.onFire(this.pending);
      this.pending = null;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.flush();
  }
}
