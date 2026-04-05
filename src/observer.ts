import * as vscode from "vscode";
import * as path from "path";
import * as cp from "child_process";
import { ChangeContext, ChangeType, ToolId, EditEvent } from "./types";
import { classifyChange } from "./classifier";
import { buildEvent, Debouncer, EventBatcher } from "./events";
import { logger } from "./logger";
import { LocalBuffer } from "./buffer";
import { Transport } from "./transport";
import { diffLines } from "./diff";

// ─── Git repo root cache ────────────────────────────────────────────

const repoRootCache = new Map<string, string | null>();
const gitRemoteCache = new Map<string, string>();
const gitUserEmailCache = new Map<string, string>();

function getRepoRoot(filePath: string): string {
  const dir = path.dirname(filePath);
  if (repoRootCache.has(dir)) return repoRootCache.get(dir)!;

  try {
    const root = cp
      .execSync("git rev-parse --show-toplevel", {
        cwd: dir,
        timeout: 2000,
        stdio: ["pipe", "pipe", "pipe"],
      })
      .toString()
      .trim();
    repoRootCache.set(dir, root);
    return root;
  } catch {
    repoRootCache.set(dir, dir);
    return dir;
  }
}

function getGitRemote(repoRoot: string): string {
  if (gitRemoteCache.has(repoRoot)) return gitRemoteCache.get(repoRoot)!;

  try {
    const raw = cp
      .execSync("git remote get-url origin", {
        cwd: repoRoot,
        timeout: 2000,
        stdio: ["pipe", "pipe", "pipe"],
      })
      .toString()
      .trim();
    const normalized = normalizeGitRemote(raw);
    gitRemoteCache.set(repoRoot, normalized);
    return normalized;
  } catch {
    gitRemoteCache.set(repoRoot, "");
    return "";
  }
}

function getGitUserEmail(repoRoot: string): string {
  if (gitUserEmailCache.has(repoRoot)) return gitUserEmailCache.get(repoRoot)!;

  try {
    const email = cp
      .execSync("git config user.email", {
        cwd: repoRoot,
        timeout: 2000,
        stdio: ["pipe", "pipe", "pipe"],
      })
      .toString()
      .trim();
    gitUserEmailCache.set(repoRoot, email);
    return email;
  } catch {
    gitUserEmailCache.set(repoRoot, "");
    return "";
  }
}

/**
 * Normalize git remote URL to a canonical form:
 *   git@github.com:Org/repo.git  →  github.com/Org/repo
 *   https://github.com/Org/repo.git  →  github.com/Org/repo
 */
function normalizeGitRemote(raw: string): string {
  let url = raw.trim();
  // SSH format: git@github.com:Org/repo.git
  const sshMatch = url.match(/^[^@]+@([^:]+):(.+)$/);
  if (sshMatch) {
    url = sshMatch[1] + "/" + sshMatch[2];
  } else {
    // HTTPS format: strip protocol
    url = url.replace(/^https?:\/\//, "");
  }
  // Strip trailing .git
  url = url.replace(/\.git$/, "");
  return url;
}

// ─── Observer ───────────────────────────────────────────────────────

/**
 * The Observer is the orchestrator of the extension.
 * It wires together: VS Code events → classifier → debouncer → batcher → transport + buffer.
 *
 * Design: The extension is DUMB. It observes, classifies, emits. No state management,
 * no interval tree, no storage logic. All intelligence lives server-side.
 */
export class Observer {
  private disposables: vscode.Disposable[] = [];
  private batcher: EventBatcher;
  private buffer: LocalBuffer;
  private transport: Transport;
  private retryTimer: ReturnType<typeof setInterval> | null = null;

  // ── AI completion tracking state ────────────────────────────────
  private inlineCompletionAccepted = false;
  private lastCompletionProvider: ToolId | undefined;
  private completionResetTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Keystroke timing ────────────────────────────────────────────
  private lastKeystrokeTime = 0;

  // ── Per-file debouncers for grouping rapid human keystrokes ─────
  private debouncers = new Map<string, Debouncer<PendingEdit>>();

  // ── Document content cache for computing actual differences ─────
  private documentCache = new Map<string, string>();

  constructor(transport: Transport, buffer: LocalBuffer, batcher: EventBatcher) {
    this.transport = transport;
    this.buffer = buffer;
    this.batcher = batcher;
  }

  activate(): void {
    // ── Core: observe every text mutation ──────────────────────────
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocumentChange(e))
    );

    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => {
        if (doc.uri.scheme === "file") {
          this.documentCache.set(doc.uri.toString(), doc.getText());
        }
      })
    );

    this.disposables.push(
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.documentCache.delete(doc.uri.toString());
      })
    );

    // Initialize cache for already open documents
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === "file") {
        this.documentCache.set(doc.uri.toString(), doc.getText());
      }
    }

    // ── Intercept inline completion acceptance via keybinding override ──
    // package.json rebinds Tab/Ctrl+Right/Cmd+Right to our commands
    // ONLY when `inlineSuggestionVisible` is true. We set a flag, then
    // delegate to the real VS Code accept command. The next text change
    // event is guaranteed to be the AI-inserted code.
    this.disposables.push(
      vscode.commands.registerCommand(
        "authorship-tracker.interceptInlineAccept",
        async () => {
          logger.debug("[Observer] Tab Keybinding intercepted -> inline completion committed.");
          this.markCompletionAccepted();
          await vscode.commands.executeCommand("editor.action.inlineSuggest.commit");
        }
      )
    );

    this.disposables.push(
      vscode.commands.registerCommand(
        "authorship-tracker.interceptInlineAcceptWord",
        async () => {
          this.markCompletionAccepted();
          await vscode.commands.executeCommand("editor.action.inlineSuggest.acceptNextWord");
        }
      )
    );

    this.disposables.push(
      vscode.commands.registerCommand(
        "authorship-tracker.interceptInlineAcceptLine",
        async () => {
          this.markCompletionAccepted();
          await vscode.commands.executeCommand("editor.action.inlineSuggest.acceptNextLine");
        }
      )
    );

    // ── Background retry: flush local buffer to Ingestion Service ──
    this.retryTimer = setInterval(() => this.retryBuffered(), 10_000);

    // ── Periodically rotate buffer file if too large ──────────────
    this.disposables.push(
      new vscode.Disposable(() => {
        this.buffer.rotateIfNeeded();
      })
    );
  }

  deactivate(): void {
    // Flush all pending debouncers
    for (const [, debouncer] of this.debouncers) {
      debouncer.dispose();
    }
    this.debouncers.clear();

    // Flush batcher (writes remaining events to buffer + transport)
    this.batcher.dispose();

    // Stop retry timer
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }

    // Dispose VS Code subscriptions
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];

    // Close buffer file
    this.buffer.dispose();
    
    this.documentCache.clear();
  }

  // ─── Text Change Handler ────────────────────────────────────────

  private async onDocumentChange(e: vscode.TextDocumentChangeEvent): Promise<void> {
    // Ignore non-file schemes (output panels, git diffs, etc.)
    if (e.document.uri.scheme !== "file") return;

    // Ignore empty changes
    if (e.contentChanges.length === 0) return;

    const filePath = e.document.uri.fsPath;
    const repoRoot = getRepoRoot(filePath);
    const relativePath = path.relative(repoRoot, filePath);
    const gitRemote = getGitRemote(repoRoot);
    const gitUserEmail = getGitUserEmail(repoRoot);
    const now = Date.now();
    const docUriStr = e.document.uri.toString();
    const cachedDoc = this.documentCache.get(docUriStr);

    for (const change of e.contentChanges) {
      const originalText = change.text;
      const originalRangeLength = change.rangeLength;
      
      let isPaste = false;
      // Robust detection: verify against clipboard if large enough
      if (originalText.length > 15) {
        const clipboardText = await vscode.env.clipboard.readText();
        if (clipboardText && (originalText === clipboardText || originalText.trim() === clipboardText.trim())) {
          isPaste = true;
        }
      }

      let text = originalText;
      let lineStart = change.range.start.line + 1;
      let lineCount = text.split("\n").length;
      let isDelete = text.length === 0 && originalRangeLength > 0;
      let isReplace = text.length > 0 && originalRangeLength > 0;

      let isPureFormatting = false;

      interface SubEdit {
        text: string;
        lineStart: number;
        lineCount: number;
        isDelete: boolean;
        isReplace: boolean;
        originalRangeLength: number;
        isPureFormatting: boolean;
        charStart: number;
        charEnd: number;
      }
      const subEdits: SubEdit[] = [];

      // ── Bounding Box Shrinker & Slicer ──────────────────────────────
      // Because `npm diff` is unavailable, we use a robust, whitespace-agnostic
      // prefix/suffix shrinker.
      if (cachedDoc && isReplace && originalRangeLength > 0) {
        const oldSegment = cachedDoc.substring(change.rangeOffset, change.rangeOffset + originalRangeLength);
        
        // Check if this is exclusively a whitespace formatting sweep
        if (oldSegment.replace(/\s/g, "") === originalText.replace(/\s/g, "")) {
          isPureFormatting = true;
        }

        const oldLines = oldSegment.split("\n");
        const newLines = text.split("\n");

        let startMatch = 0;
        while (
          startMatch < oldLines.length && 
          startMatch < newLines.length && 
          oldLines[startMatch].trim() === newLines[startMatch].trim()
        ) {
          startMatch++;
        }

        let endMatch = 0;
        while (
          endMatch < oldLines.length - startMatch && 
          endMatch < newLines.length - startMatch && 
          oldLines[oldLines.length - 1 - endMatch].trim() === newLines[newLines.length - 1 - endMatch].trim()
        ) {
          endMatch++;
        }

        let reducedOldLines = oldLines;
        let actualNewLines = newLines;

        if (startMatch !== oldLines.length || startMatch !== newLines.length) {
          reducedOldLines = oldLines.slice(startMatch, oldLines.length - endMatch);
          actualNewLines = newLines.slice(startMatch, newLines.length - endMatch);
        }

        const chunks = diffLines(reducedOldLines, actualNewLines);
        let currentLineOffset = change.range.start.line + startMatch + 1;

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          if (!chunk.added && !chunk.removed) {
            currentLineOffset += chunk.count;
          } else if (chunk.removed && i + 1 < chunks.length && chunks[i+1].added) {
            const next = chunks[i+1];
            const joinedText = next.lines.join("\n");
            subEdits.push({
              text: joinedText,
              lineStart: currentLineOffset,
              lineCount: next.count,
              isDelete: false,
              isReplace: true,
              originalRangeLength: chunk.lines.join("\n").length,
              isPureFormatting,
              charStart: 0,
              charEnd: next.lines.length > 0 ? next.lines[next.lines.length - 1].length : 0
            });
            currentLineOffset += next.count;
            i++;
          } else if (chunk.removed) {
            subEdits.push({
              text: "",
              lineStart: currentLineOffset,
              lineCount: 0,
              isDelete: true,
              isReplace: false,
              originalRangeLength: chunk.lines.join("\n").length,
              isPureFormatting,
              charStart: 0,
              charEnd: 0
            });
          } else if (chunk.added) {
            const joinedText = chunk.lines.join("\n");
            subEdits.push({
              text: joinedText,
              lineStart: currentLineOffset,
              lineCount: chunk.count,
              isDelete: false,
              isReplace: false,
              originalRangeLength: 0,
              isPureFormatting,
              charStart: 0,
              charEnd: chunk.lines.length > 0 ? chunk.lines[chunk.lines.length - 1].length : 0
            });
            currentLineOffset += chunk.count;
          }
        }
      } else {
        subEdits.push({
          text,
          lineStart,
          lineCount,
          isDelete,
          isReplace,
          originalRangeLength,
          isPureFormatting,
          charStart: change.range.start.character,
          charEnd: change.range.end.character
        });
      }

      for (const edit of subEdits) {
        const changeType: ChangeType = edit.isDelete ? "delete" : (edit.isReplace) ? "replace" : "insert";

        // Build classification context
        const ctx: ChangeContext = {
          text: edit.text,
          lineCount: edit.lineCount,
          inlineCompletionJustAccepted: this.inlineCompletionAccepted,
          completionProvider: this.lastCompletionProvider,
          isPaste: isPaste,
          isUndoRedo: e.reason === vscode.TextDocumentChangeReason.Undo ||
                      e.reason === vscode.TextDocumentChangeReason.Redo,
          isExtensionCommand: false,
          sourceExtensionId: undefined,
          timeSinceLastKeystroke: now - this.lastKeystrokeTime,
          charCount: edit.text.length,
          rangeLength: edit.originalRangeLength,
          isPureFormatting: edit.isPureFormatting,
        };

        const lineEnd = edit.lineStart + Math.max(0, edit.lineCount - 1);
        logger.debug(`[Observer] Handled text sub-edit payload => ${relativePath}:${edit.lineStart}-${lineEnd} | type: ${changeType} | isPaste: ${isPaste} | pureFormat: ${edit.isPureFormatting} | rangeLength: ${edit.originalRangeLength}`);

      // Skip undo/redo — these replay previous edits, not new authorship
      if (ctx.isUndoRedo) {
        this.lastKeystrokeTime = now;
        continue;
      }

      // Classify
      const classification = classifyChange(ctx);

      // Reset completion flag after consuming it
      if (this.inlineCompletionAccepted) {
        this.clearCompletionFlag();
      }

      // For AI edits or Pasting, emit immediately — no debounce
      if (classification.author_type === "ai" || isPaste) {
        logger.info(`[Observer] Emitting explicit event (ai/paste) directly: Lines ${lineStart}-${lineEnd}`);
        // Flush any active debouncer to preserve order
        const debouncer = this.debouncers.get(relativePath);
        if (debouncer && debouncer.hasPending()) {
          debouncer.flush();
        }

        const event = buildEvent({
          filePath: relativePath,
          gitRemote,
          gitUserEmail,
          lineStart: edit.lineStart,
          lineEnd,
          charStart: edit.charStart,
          charEnd: edit.charEnd,
          text: edit.text,
          changeType,
          classification,
        });
        this.batcher.push(event);
        this.lastKeystrokeTime = now;
        continue;
      }

      // For human keystrokes, debounce to group rapid typing into one event
      this.debounceHumanEdit(relativePath, {
        filePath: relativePath,
        gitRemote,
        gitUserEmail,
        lineStart: edit.lineStart,
        lineEnd,
        charStart: edit.charStart,
        charEnd: edit.charEnd,
        text: edit.text,
        changeType,
        classification,
      });

      this.lastKeystrokeTime = now;
    } // end subEdits loop
  } // end changes loop

    // Update document cache for future bounding box shrink operations
    this.documentCache.set(docUriStr, e.document.getText());
  }

  // ─── Debounce human edits (300ms window) ────────────────────────

  private debounceHumanEdit(fileKey: string, edit: PendingEdit): void {
    let debouncer = this.debouncers.get(fileKey);
    if (debouncer && debouncer.hasPending()) {
      const pending = debouncer.getPending();
      // If the new edit is disjoint (not adjacent to the pending edit)
      if (Math.abs(pending.lineEnd - edit.lineStart) > 1 && Math.abs(edit.lineEnd - pending.lineStart) > 1) {
        debouncer.flush();
      }
    }

    if (!debouncer) {
      debouncer = new Debouncer<PendingEdit>(
        (merged) => {
          const event = buildEvent(merged);
          this.batcher.push(event);
        },
        mergeEdits,
        300
      );
      this.debouncers.set(fileKey, debouncer);
    }
    debouncer.call(edit);
  }

  // ─── Inline completion tracking ─────────────────────────────────

  private markCompletionAccepted(): void {
    this.inlineCompletionAccepted = true;
    // Detect which AI tool is providing completions
    this.lastCompletionProvider = this.detectActiveAITool();

    // Auto-reset after 500ms if no text change consumed the flag
    if (this.completionResetTimer) clearTimeout(this.completionResetTimer);
    this.completionResetTimer = setTimeout(() => this.clearCompletionFlag(), 500);
  }

  private clearCompletionFlag(): void {
    this.inlineCompletionAccepted = false;
    this.lastCompletionProvider = undefined;
    if (this.completionResetTimer) {
      clearTimeout(this.completionResetTimer);
      this.completionResetTimer = null;
    }
  }

  private detectActiveAITool(): ToolId {
    // Check which AI extensions are active
    const copilot = vscode.extensions.getExtension("github.copilot");
    const codeium = vscode.extensions.getExtension("codeium.codeium");
    const continueExt = vscode.extensions.getExtension("continue.continue");

    // Prioritize: the most recently active one is likely the source.
    // In practice, only one inline completion provider is active at a time.
    if (copilot?.isActive) return "copilot";
    if (codeium?.isActive) return "codeium";
    if (continueExt?.isActive) return "continue";
    return "unknown-ai";
  }

  // ─── Retry buffered events ──────────────────────────────────────

  private async retryBuffered(): Promise<void> {
    const batch = this.buffer.drain();
    if (!batch || batch.events.length === 0) return;

    const ok = await this.transport.send(batch);
    if (!ok) {
      // Re-buffer — transport is still down
      this.buffer.append(batch);
    }
  }
}

// ─── Helper types for debouncing ────────────────────────────────────

interface PendingEdit {
  filePath: string;
  gitRemote: string;
  gitUserEmail: string;
  lineStart: number;
  lineEnd: number;
  charStart: number;
  charEnd: number;
  text: string;
  changeType: ChangeType;
  classification: { author_type: "ai" | "human"; tool_id: ToolId; confidence: number };
}

/**
 * Merge two rapid human edits into one event.
 * Expands the line range and concatenates text.
 */
function mergeEdits(a: PendingEdit, b: PendingEdit): PendingEdit {
  return {
    filePath: a.filePath,
    gitRemote: a.gitRemote,
    gitUserEmail: a.gitUserEmail,
    lineStart: Math.min(a.lineStart, b.lineStart),
    lineEnd: Math.max(a.lineEnd, b.lineEnd),
    charStart: a.lineStart <= b.lineStart ? a.charStart : b.charStart,
    charEnd: a.lineEnd >= b.lineEnd ? a.charEnd : b.charEnd,
    text: a.text + b.text,
    changeType: "replace", // merged edits are effectively a replace
    classification: a.classification, // both are human
  };
}
