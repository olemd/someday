// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A small, safe Markdown subset for item notes (§3.2): paragraphs, line
 * breaks, bullet and numbered lists, **bold**, *italic*, `code`, [links](…)
 * and bare URLs. Output is Preact elements, never HTML strings, so notes
 * cannot inject markup; only http(s) and mailto links are rendered as links.
 */
import type { ComponentChildren } from 'preact';

const SAFE_URL = /^(https?:\/\/|mailto:)/i;
const INLINE =
  /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s<>()]+)/g;

function inline(text: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const tok = m[0];
    if (m.index! > last) out.push(text.slice(last, m.index));
    if (tok.startsWith('**')) out.push(<strong>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) out.push(<code>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('*')) out.push(<em>{tok.slice(1, -1)}</em>);
    else if (tok.startsWith('[')) {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      out.push(
        SAFE_URL.test(mm[2]!) ? (
          <a href={mm[2]} rel="noopener noreferrer" target="_blank">
            {mm[1]}
          </a>
        ) : (
          mm[1]
        ),
      );
    } else {
      // Trailing punctuation is usually sentence punctuation, not URL.
      const url = tok.replace(/[.,;:!?]+$/, '');
      out.push(
        <a href={url} rel="noopener noreferrer" target="_blank">
          {url}
        </a>,
      );
      if (url.length < tok.length) out.push(tok.slice(url.length));
    }
    last = m.index! + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks = text
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n{2,}/);
  return (
    <div class="notes">
      {blocks.map((b, i) => {
        const lines = b.split('\n');
        if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
          return (
            <ul key={i}>
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*[-*]\s+/, ''))}</li>
              ))}
            </ul>
          );
        }
        if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
          return (
            <ol key={i}>
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>
              ))}
            </ol>
          );
        }
        return (
          <p key={i}>
            {lines.flatMap((l, j) => (j ? [<br key={`br${j}`} />, ...inline(l)] : inline(l)))}
          </p>
        );
      })}
    </div>
  );
}
