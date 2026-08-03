function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeDestination(destination: string): string | undefined {
  const trimmed = destination.trim();
  if (
    trimmed.startsWith("attach:") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("mailto:")
  ) {
    return trimmed;
  }
  return undefined;
}

function renderTextFormatting(value: string): string {
  let output = escapeHtml(value);
  output = output.replace(/`([^`]+)`/g, "<code>$1</code>");
  output = output.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  output = output.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return output;
}

function renderInline(value: string): string {
  const links = /(!?)\[([^\]]*)\]\(([^)]+)\)/g;
  const output: string[] = [];
  let cursor = 0;

  for (const match of value.matchAll(links)) {
    const index = match.index ?? 0;
    output.push(renderTextFormatting(value.slice(cursor, index)));
    const image = match[1] === "!";
    const label = match[2] ?? "";
    const safe = safeDestination(match[3] ?? "");
    if (image) {
      output.push(
        safe
          ? `<span class="image-placeholder" data-source="${escapeHtml(safe)}">[image: ${escapeHtml(label)}]</span>`
          : `[image: ${escapeHtml(label)}]`,
      );
    } else {
      output.push(
        safe
          ? `<a href="${escapeHtml(safe)}">${renderTextFormatting(label)}</a>`
          : renderTextFormatting(label),
      );
    }
    cursor = index + match[0].length;
  }
  output.push(renderTextFormatting(value.slice(cursor)));
  return output.join("");
}

/**
 * Render a deliberately small Markdown subset after escaping all source HTML.
 * Container parsing remains exclusively in `tmd-core`; this is only a live,
 * non-executable editor preview.
 */
export function renderSafeMarkdown(markdown: string): string {
  const output: string[] = [];
  let inCodeBlock = false;
  let inList = false;

  for (const line of markdown.replaceAll("\r\n", "\n").split("\n")) {
    if (line.startsWith("```")) {
      if (inList) {
        output.push("</ul>");
        inList = false;
      }
      output.push(inCodeBlock ? "</code></pre>" : "<pre><code>");
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      output.push(`${escapeHtml(line)}\n`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      if (inList) {
        output.push("</ul>");
        inList = false;
      }
      const level = heading[1]?.length ?? 1;
      output.push(`<h${level}>${renderInline(heading[2] ?? "")}</h${level}>`);
      continue;
    }

    const listItem = /^[-*]\s+(.*)$/.exec(line);
    if (listItem) {
      if (!inList) {
        output.push("<ul>");
        inList = true;
      }
      output.push(`<li>${renderInline(listItem[1] ?? "")}</li>`);
      continue;
    }
    if (inList) {
      output.push("</ul>");
      inList = false;
    }

    if (line.trim() === "") {
      continue;
    }
    output.push(`<p>${renderInline(line)}</p>`);
  }

  if (inCodeBlock) {
    output.push("</code></pre>");
  }
  if (inList) {
    output.push("</ul>");
  }
  return output.join("\n");
}

/**
 * Render the basic safe preview together with an escaped explanation of why
 * the CLI-backed dynamic preview is unavailable.
 */
export function renderSafeMarkdownFallback(
  markdown: string,
  reason: string,
  detail: string,
): string {
  const diagnostic = [
    '<aside class="preview-diagnostic" role="status">',
    `<p><strong>Dynamic preview unavailable.</strong> ${escapeHtml(reason)}</p>`,
    "<p>Showing the basic safe Markdown preview. Install or update the TMD CLI, then run <code>TMD: Select CLI Executable</code>.</p>",
    "<details><summary>Technical details</summary>",
    `<code>${escapeHtml(detail)}</code>`,
    "</details></aside>",
  ].join("");
  return `${diagnostic}\n${renderSafeMarkdown(markdown)}`;
}
