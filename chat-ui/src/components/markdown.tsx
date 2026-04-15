// Streaming markdown renderer.
// Uses a simple HTML rendering approach for v1.
// streamdown integration will be added when the package stabilizes for React 19.

import { useMemo } from "react";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderMarkdown(text: string): string {
  let html = escapeHtml(text);

  // Code blocks (```...```)
  html = html.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_match, lang: string, code: string) =>
      `<pre class="my-2 overflow-x-auto rounded-lg bg-muted p-3 font-mono text-sm"><code data-lang="${lang}">${code}</code></pre>`,
  );

  // Inline code
  html = html.replace(
    /`([^`]+)`/g,
    '<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">$1</code>',
  );

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Italic
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Headers
  html = html.replace(
    /^### (.+)$/gm,
    '<h3 class="mt-4 mb-2 text-base font-semibold">$1</h3>',
  );
  html = html.replace(
    /^## (.+)$/gm,
    '<h2 class="mt-4 mb-2 text-lg font-semibold">$1</h2>',
  );
  html = html.replace(
    /^# (.+)$/gm,
    '<h1 class="mt-4 mb-2 text-xl font-semibold">$1</h1>',
  );

  // Unordered lists
  html = html.replace(
    /^- (.+)$/gm,
    '<li class="ml-4 list-disc">$1</li>',
  );

  // Ordered lists
  html = html.replace(
    /^\d+\. (.+)$/gm,
    '<li class="ml-4 list-decimal">$1</li>',
  );

  // Links
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-primary underline underline-offset-2 hover:text-primary/80">$1</a>',
  );

  // Paragraphs (double newlines)
  html = html.replace(/\n\n/g, '</p><p class="mb-2">');
  html = `<p class="mb-2">${html}</p>`;

  // Single newlines to br
  html = html.replace(/\n/g, "<br />");

  return html;
}

export function Markdown({ content }: { content: string }) {
  const html = useMemo(() => renderMarkdown(content), [content]);

  return (
    <div
      className="prose prose-sm max-w-none text-foreground"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
