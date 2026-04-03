// ─── Author Classification ─────────────────────────────────────────

export type AuthorType = "ai" | "human";

export type ChangeType = "insert" | "delete" | "replace";

// Known AI tool identifiers
export type ToolId =
  | "copilot"
  | "claude"
  | "cursor"
  | "codeium"
  | "continue"
  | "unknown-ai"
  | "";

// ─── Edit Event (emitted by the extension) ─────────────────────────

export interface EditEvent {
  event_id: string;
  event_type: "edit";
  file_path: string; // relative to repo root, e.g. "src/auth/handler.ts"
  file_uri: string; // full file:// URI
  repo_root: string; // absolute path to git repo root
  line_start: number; // 1-based
  line_end: number; // 1-based, inclusive
  char_start: number;
  char_end: number;
  author_type: AuthorType;
  tool_id: ToolId;
  content_hash: string; // sha256 of inserted/changed text
  lines_changed: number;
  change_type: ChangeType;
  session_id: string; // ties events to a continuous editing session
  timestamp: number; // unix ms
}

// ─── Classification Result ──────────────────────────────────────────

export interface ClassificationResult {
  author_type: AuthorType;
  tool_id: ToolId;
  confidence: number; // 0.0 – 1.0
}

// ─── Change Context (passed from observer to classifier) ────────────

export interface ChangeContext {
  /** The text that was inserted/replaced */
  text: string;
  /** Number of lines in the change */
  lineCount: number;
  /** Was an inline completion recently accepted? */
  inlineCompletionJustAccepted: boolean;
  /** The tool that provided the completion, if known */
  completionProvider?: ToolId;
  /** Was this a paste operation? */
  isPaste: boolean;
  /** Was this an undo/redo operation? */
  isUndoRedo: boolean;
  /** Did the change come from an extension command? */
  isExtensionCommand: boolean;
  /** Source extension ID if known (e.g. "github.copilot") */
  sourceExtensionId?: string;
  /** Time since last keystroke in ms */
  timeSinceLastKeystroke: number;
  /** Number of characters inserted */
  charCount: number;
  /** Size of the text replaced from the old document */
  rangeLength: number;
  /** True if the change only modifies whitespace */
  isPureFormatting: boolean;
}

// ─── Batch Payload (sent to Ingestion Service) ──────────────────────

export interface EventBatch {
  events: EditEvent[];
  installation_id: string;
  sent_at: number; // unix ms
}

// ─── Extension Configuration ────────────────────────────────────────

export interface TrackerConfig {
  enabled: boolean;
  ingestionUrl: string;
  debounceMs: number;
  batchSize: number;
  batchIntervalMs: number;
  installationId: string;
}
