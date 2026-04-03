import * as vscode from "vscode";
import { ChangeContext, ClassificationResult, ToolId } from "./types";
import { logger } from "./logger";

// ─── Known AI extension IDs → tool mapping ──────────────────────────

const EXTENSION_TOOL_MAP: Record<string, ToolId> = {
  "github.copilot": "copilot",
  "github.copilot-chat": "copilot",
  "anthropic.claude-code": "claude",
  "continue.continue": "continue",
  "codeium.codeium": "codeium",
  "cursor.cursor": "cursor",
};

// Priority-ordered list of AI extension IDs to check for installation
const AI_EXTENSION_PRIORITY: string[] = [
  "github.copilot",
  "github.copilot-chat",
  "anthropic.claude-code",
  "continue.continue",
  "codeium.codeium",
  "cursor.cursor",
];

// Heuristic thresholds
const LARGE_PASTE_CHAR_THRESHOLD = 200;
const LARGE_PASTE_LINE_THRESHOLD = 5;

/**
 * Detect the most likely AI tool installed in the current VS Code instance.
 * Checks extensions in priority order and returns the first active one.
 * Cached after first call for performance.
 */
let _cachedInstalledAiTool: ToolId | null = null;
let _cacheChecked = false;

function detectInstalledAiTool(): ToolId {
  if (_cacheChecked) {
    return _cachedInstalledAiTool ?? "unknown-ai";
  }
  _cacheChecked = true;

  for (const extId of AI_EXTENSION_PRIORITY) {
    const ext = vscode.extensions.getExtension(extId);
    if (ext) {
      _cachedInstalledAiTool = EXTENSION_TOOL_MAP[extId] ?? "unknown-ai";
      logger.debug(`[Classifier] Detected installed AI tool: ${extId} -> ${_cachedInstalledAiTool}`);
      return _cachedInstalledAiTool;
    }
  }

  logger.debug("[Classifier] No known AI extension detected, defaulting to unknown-ai");
  return "unknown-ai";
}

/**
 * Classify a text change as AI or human.
 *
 * Decision flow (matches PROJECT_CONTEXT.md):
 *
 * 1. Was an inline completion just accepted?  → ai
 * 2. Did the change come from an extension API/command?  → ai
 * 3. Was it a paste operation?  → heuristic (large paste from AI chat = ai)
 * 4. Was it a suspiciously large insertion?  → ai (attributed to installed tool)
 * 5. Otherwise  → human (direct keystrokes)
 */
export function classifyChange(ctx: ChangeContext): ClassificationResult {
  // Undo/redo is always attributed to the original author — skip classification,
  // let the observer handle this by ignoring undo/redo events.
  if (ctx.isUndoRedo) {
    logger.debug("[Classifier] Result: human (Reason: Undo/Redo)");
    return { author_type: "human", tool_id: "", confidence: 0.5 };
  }

  // ── Step 1: Inline completion accepted ────────────────────────────
  if (ctx.inlineCompletionJustAccepted) {
    const tool_id = ctx.completionProvider ?? detectInstalledAiTool();
    logger.debug(`[Classifier] Result: ai (Reason: Inline Completion Accepted, Tool: ${tool_id})`);
    return { author_type: "ai", tool_id, confidence: 1.0 };
  }

  // ── Step 2: Extension command / API insertion ─────────────────────
  if (ctx.isExtensionCommand && ctx.sourceExtensionId) {
    const tool_id =
      EXTENSION_TOOL_MAP[ctx.sourceExtensionId] ?? "unknown-ai";
    logger.debug(`[Classifier] Result: ai (Reason: Extension API Insertion, Tool: ${tool_id})`);
    return { author_type: "ai", tool_id, confidence: 0.95 };
  }

  // ── Step 3: Paste operation ───────────────────────────────────────
  if (ctx.isPaste) {
    // Large multi-line paste is likely from an AI chat window
    if (
      ctx.charCount > LARGE_PASTE_CHAR_THRESHOLD &&
      ctx.lineCount > LARGE_PASTE_LINE_THRESHOLD
    ) {
      const tool_id = detectInstalledAiTool();
      logger.debug(`[Classifier] Result: ai (Reason: Massive Paste, Chars: ${ctx.charCount}, Tool: ${tool_id})`);
      return { author_type: "ai", tool_id, confidence: 0.7 };
    }
    // Small paste — could be anything, treat as human
    logger.debug(`[Classifier] Result: human (Reason: Safe Paste, Chars: ${ctx.charCount})`);
    return { author_type: "human", tool_id: "", confidence: 0.85 };
  }

  // ── Step 4: Suspiciously large insertion ────────────────────────────
  // If an insertion is sizeable, wasn't a paste, wasn't an undo,
  // and wasn't a pure space-reformatting sequence, it's highly likely to be AI.
  if (ctx.charCount > 15 && !ctx.isPaste && !ctx.isUndoRedo && !ctx.isPureFormatting) {
    const tool_id = detectInstalledAiTool();
    logger.debug(`[Classifier] Result: ai (Reason: Quick Significant Insertion, Chars: ${ctx.charCount}, Tool: ${tool_id})`);
    return { author_type: "ai", tool_id, confidence: 0.6 };
  }

  // ── Step 5: Default — human keystrokes ────────────────────────────
  logger.debug("[Classifier] Result: human (Reason: Default Fallthrough)");
  return { author_type: "human", tool_id: "", confidence: 1.0 };
}

/**
 * Map a VS Code extension ID to our tool identifier.
 * Returns undefined if the extension is not a known AI tool.
 */
export function resolveToolId(extensionId: string): ToolId | undefined {
  return EXTENSION_TOOL_MAP[extensionId];
}
