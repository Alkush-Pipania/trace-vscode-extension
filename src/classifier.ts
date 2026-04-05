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
 * Detect ALL installed AI tools in the current VS Code instance.
 * Cached after first call for performance.
 */
let _cachedInstalledAiTools: ToolId[] | null = null;
let _cacheChecked = false;

function detectInstalledAiTools(): ToolId[] {
  if (_cacheChecked && _cachedInstalledAiTools) {
    return _cachedInstalledAiTools;
  }
  _cacheChecked = true;

  const found: ToolId[] = [];
  const seen = new Set<ToolId>();

  for (const extId of AI_EXTENSION_PRIORITY) {
    const ext = vscode.extensions.getExtension(extId);
    if (ext) {
      const toolId = EXTENSION_TOOL_MAP[extId] ?? "unknown-ai";
      if (!seen.has(toolId)) {
        seen.add(toolId);
        found.push(toolId);
        logger.debug(`[Classifier] Detected installed AI tool: ${extId} -> ${toolId}`);
      }
    }
  }

  _cachedInstalledAiTools = found.length > 0 ? found : ["unknown-ai"];
  return _cachedInstalledAiTools;
}

/**
 * Pick the best tool_id for a heuristic AI detection.
 * 
 * If only one AI tool is installed → use it.
 * If multiple are installed → we can't know for sure which one did it,
 * so return the most likely one based on the edit characteristics.
 * 
 * For "replace" operations (how Claude Code and Copilot Chat work),
 * we check if the edit looks like an agent-style edit (large rangeLength)
 * vs an inline completion style.
 */
function pickToolForHeuristic(ctx: ChangeContext): ToolId {
  const tools = detectInstalledAiTools();

  if (tools.length === 1) {
    return tools[0];
  }

  // Multiple AI tools installed. Use heuristics:
  // Claude Code typically does full-line replacements via workspace edit API.
  // Copilot inline completions are caught by Step 1 (keybinding intercept).
  // If we're here at Step 4 (heuristic), it's NOT an inline completion,
  // so it's more likely a chat/agent edit. Prefer claude if installed.
  if (tools.includes("claude")) {
    return "claude";
  }

  return tools[0];
}

/**
 * Classify a text change as AI or human.
 *
 * Decision flow:
 *
 * 1. Was an inline completion just accepted?  → ai
 * 2. Did the change come from an extension API/command?  → ai
 * 3. Was it a paste operation?  → heuristic (large paste from AI chat = ai)
 * 4. Was it a sizeable replace/insertion (not a paste, not undo)?  → ai
 * 5. Otherwise  → human (direct keystrokes)
 */
export function classifyChange(ctx: ChangeContext): ClassificationResult {
  // Undo/redo is always attributed to the original author — skip classification.
  if (ctx.isUndoRedo) {
    logger.debug("[Classifier] Result: human (Reason: Undo/Redo)");
    return { author_type: "human", tool_id: "", confidence: 0.5 };
  }

  // ── Step 1: Inline completion accepted ────────────────────────────
  if (ctx.inlineCompletionJustAccepted) {
    const tool_id = ctx.completionProvider ?? pickToolForHeuristic(ctx);
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
    if (
      ctx.charCount > LARGE_PASTE_CHAR_THRESHOLD &&
      ctx.lineCount > LARGE_PASTE_LINE_THRESHOLD
    ) {
      const tool_id = pickToolForHeuristic(ctx);
      logger.debug(`[Classifier] Result: ai (Reason: Massive Paste, Chars: ${ctx.charCount}, Tool: ${tool_id})`);
      return { author_type: "ai", tool_id, confidence: 0.7 };
    }
    logger.debug(`[Classifier] Result: human (Reason: Safe Paste, Chars: ${ctx.charCount})`);
    return { author_type: "human", tool_id: "", confidence: 0.85 };
  }

  // ── Step 4: Suspiciously large insertion or replacement ───────────
  // Key insight: AI tools (Claude Code, Copilot Chat) apply edits via
  // WorkspaceEdit which appears as a "replace" with a large rangeLength.
  // isPureFormatting ONLY blocks detection for trivial whitespace-only changes
  // where the rangeLength is similar to charCount (true reformatting).
  // When rangeLength is large but content genuinely changed, it's AI.
  const isSignificantReplace = ctx.rangeLength > 15 && ctx.charCount > 15;
  const isSignificantInsert = ctx.charCount > 15 && ctx.rangeLength === 0;

  if ((isSignificantReplace || isSignificantInsert) && !ctx.isPaste && !ctx.isUndoRedo) {
    // Only skip if it's TRULY pure formatting (whitespace-only, no semantic change)
    if (ctx.isPureFormatting && !isSignificantReplace) {
      logger.debug(`[Classifier] Result: human (Reason: Pure Formatting, Chars: ${ctx.charCount})`);
      return { author_type: "human", tool_id: "", confidence: 0.9 };
    }

    const tool_id = pickToolForHeuristic(ctx);
    logger.debug(`[Classifier] Result: ai (Reason: Significant Automated Edit, Chars: ${ctx.charCount}, RangeLen: ${ctx.rangeLength}, Tool: ${tool_id})`);
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
