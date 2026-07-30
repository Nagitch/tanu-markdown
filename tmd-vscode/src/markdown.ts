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
    return escapeHtml(trimmed);
  }
  return undefined;
}

function renderInline(value: string): string {
  let output = escapeHtml(value);
  output = output.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt: string, destination: string) => {
    const safe = safeDestination(destination);
    return safe
      ? `<span class="image-placeholder" data-source="${safe}">[image: ${alt}]</span>`
      : `[image: ${alt}]`;
  });
  output = output.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, destination: string) => {
    const safe = safeDestination(destination);
    return safe ? `<a href="${safe}">${label}</a>` : label;
  });
  output = output.replace(/`([^`]+)`/g, "<code>$1</code>");
  output = output.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  output = output.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return output;
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
