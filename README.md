# Trace — VS Code Authorship Tracker Extension

A VS Code extension that tracks **who actually wrote each line of code** — human or AI — in real time.

## What it does

Every time code changes in your editor, this extension silently classifies the edit as either **human-authored** or **AI-generated** and records a structured event with precise line-level granularity.

It works by intercepting VS Code's text change events, running them through a multi-stage classification pipeline, and emitting granular edit events to a local buffer (and optionally to a remote ingestion service).

## How it detects AI

The classifier uses a layered decision flow:

1. **Inline completion interception** — Intercepts Tab/Ctrl+Right keybindings to catch accepted ghost-text suggestions (Copilot, Codeium, etc.) with high confidence.
2. **Extension command detection** — Identifies edits triggered by known AI extension APIs.
3. **Paste heuristics** — Compares inserted text against the clipboard to distinguish human pastes from programmatic insertions.
4. **Volume-based heuristics** — Large, non-paste, non-formatting insertions that appear instantaneously are flagged as AI-generated.
5. **Installed tool attribution** — Probes `vscode.extensions.getExtension()` to attribute heuristic detections to whichever AI tool is actually installed (e.g., Copilot, Claude, Codeium).

## The hard problem it solves

When AI tools like Copilot Chat apply edits, they don't surgically replace the 2 lines you asked them to change — they replace the **entire surrounding code block** (sometimes 100+ lines). Naively tracking this would overwrite the authorship of all the unchanged human code inside that block.

This extension solves that with a built-in **Myers LCS diff engine** (`src/diff.ts`) that runs inside the observer loop. It compares the old block against the new block line-by-line, extracts only the lines that actually changed, and emits **separate sub-events** for each real mutation — preserving the authorship of everything else.

## Event output

Each edit produces a JSON event like:

```json
{
  "event_type": "edit",
  "file_path": "pkg/redis/scheduler.go",
  "line_start": 24,
  "line_end": 24,
  "author_type": "ai",
  "tool_id": "copilot",
  "lines_changed": 1,
  "change_type": "replace",
  "timestamp": 1775249535795
}
```

Events are written to `events.jsonl` locally and batched for optional transport to a remote ingestion service.

## Supported AI tools

| Tool | Extension ID | Detection |
|------|-------------|-----------|
| GitHub Copilot | `github.copilot` | Keybinding + heuristic |
| Copilot Chat | `github.copilot-chat` | Heuristic + tool probe |
| Claude | `anthropic.claude-code` | Heuristic + tool probe |
| Continue | `continue.continue` | Heuristic + tool probe |
| Codeium | `codeium.codeium` | Heuristic + tool probe |
| Cursor | `cursor.cursor` | Heuristic + tool probe |
