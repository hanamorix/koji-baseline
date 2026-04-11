// markdown.ts — Lightweight markdown→HTML renderer for the agent pane
// Handles: code blocks, inline code, bold, italic, headers, lists, links, paragraphs.
// No external dependencies. Designed to match Claude Code's output style.

export function renderMarkdown(text: string): string {
  const lines = text.split("\n");
  let html = "";
  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeBlockContent = "";
  let inList = false;
  let listType: "ul" | "ol" = "ul";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── Code blocks (```) ─────────────────────────────────────────────
    if (line.trimStart().startsWith("```")) {
      if (inCodeBlock) {
        // Close code block
        html += `<pre class="md-code-block"><code class="md-lang-${esc(codeBlockLang)}">${esc(codeBlockContent.replace(/\n$/, ""))}</code></pre>`;
        inCodeBlock = false;
        codeBlockContent = "";
        codeBlockLang = "";
      } else {
        // Close any open list
        if (inList) { html += `</${listType}>`; inList = false; }
        // Open code block
        codeBlockLang = line.trimStart().slice(3).trim() || "text";
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent += line + "\n";
      continue;
    }

    // ── Headers ───────────────────────────────────────────────────────
    const headerMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headerMatch) {
      if (inList) { html += `</${listType}>`; inList = false; }
      const level = headerMatch[1].length;
      html += `<h${level} class="md-h${level}">${inlineMarkdown(headerMatch[2])}</h${level}>`;
      continue;
    }

    // ── Horizontal rule ───────────────────────────────────────────────
    if (/^[-*_]{3,}\s*$/.test(line)) {
      if (inList) { html += `</${listType}>`; inList = false; }
      html += `<hr class="md-hr">`;
      continue;
    }

    // ── Unordered list items ──────────────────────────────────────────
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)/);
    if (ulMatch) {
      if (!inList || listType !== "ul") {
        if (inList) html += `</${listType}>`;
        html += `<ul class="md-list">`;
        inList = true;
        listType = "ul";
      }
      html += `<li>${inlineMarkdown(ulMatch[2])}</li>`;
      continue;
    }

    // ── Ordered list items ────────────────────────────────────────────
    const olMatch = line.match(/^(\s*)\d+[.)]\s+(.+)/);
    if (olMatch) {
      if (!inList || listType !== "ol") {
        if (inList) html += `</${listType}>`;
        html += `<ol class="md-list">`;
        inList = true;
        listType = "ol";
      }
      html += `<li>${inlineMarkdown(olMatch[2])}</li>`;
      continue;
    }

    // ── Close list if we hit a non-list line ──────────────────────────
    if (inList && line.trim()) {
      html += `</${listType}>`;
      inList = false;
    }

    // ── Empty line ────────────────────────────────────────────────────
    if (!line.trim()) {
      if (inList) { html += `</${listType}>`; inList = false; }
      continue;
    }

    // ── Paragraph ─────────────────────────────────────────────────────
    html += `<p class="md-p">${inlineMarkdown(line)}</p>`;
  }

  // Close any unclosed blocks
  if (inCodeBlock) {
    html += `<pre class="md-code-block"><code>${esc(codeBlockContent)}</code></pre>`;
  }
  if (inList) {
    html += `</${listType}>`;
  }

  return html;
}

/** Process inline markdown: bold, italic, code, links */
function inlineMarkdown(text: string): string {
  let result = esc(text);

  // Inline code: `code`
  result = result.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  result = result.replace(/__(.+?)__/g, "<strong>$1</strong>");

  // Italic: *text* or _text_
  result = result.replace(/\*(.+?)\*/g, "<em>$1</em>");
  result = result.replace(/_(.+?)_/g, "<em>$1</em>");

  // Links: [text](url) — only allow http/https schemes
  result = result.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<a class="md-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  return result;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
