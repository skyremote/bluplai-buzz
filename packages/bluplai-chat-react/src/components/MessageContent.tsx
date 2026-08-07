import type { ReactNode } from "react";

const URL_TOKEN = /https:\/\/[^\s]+/gu;

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inlineToken(mentionNames: string[]): RegExp {
  const knownMentions = mentionNames
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .map((name) => escapePattern(`@${name}`));
  const mention = [...knownMentions, "@[\\p{L}\\p{N}._-]+"].join("|");
  return new RegExp(
    `(https:\\/\\/[^\\s]+|\\*\\*[^*\\n]+\\*\\*|~~[^~\\n]+~~|\`[^\`\\n]+\`|\\*[^*\\n]+\\*|${mention})`,
    "gu",
  );
}

function isGifUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      ((host === "giphy.com" || host.endsWith(".giphy.com")) &&
        (/\.gif$/i.test(url.pathname) || url.pathname.includes("/media/"))) ||
      ((host === "media.tenor.com" || host === "c.tenor.com") &&
        /\.(gif|webp)$/i.test(url.pathname))
    );
  } catch {
    return false;
  }
}

function renderInline(
  line: string,
  lineIndex: number,
  mentionNames: string[],
): ReactNode[] {
  const output: ReactNode[] = [];
  let cursor = 0;
  for (const match of line.matchAll(inlineToken(mentionNames))) {
    const index = match.index ?? 0;
    if (index > cursor) output.push(line.slice(cursor, index));
    const token = match[0];
    const key = `${lineIndex}-${index}`;
    if (token.startsWith("https://")) {
      output.push(
        <a href={token} key={key} rel="noopener noreferrer" target="_blank">
          {token}
        </a>,
      );
    } else if (token.startsWith("**")) {
      output.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("~~")) {
      output.push(<s key={key}>{token.slice(2, -2)}</s>);
    } else if (token.startsWith("`")) {
      output.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("*")) {
      output.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      output.push(
        <span className="bluplai-chat__mention" key={key}>
          {token}
        </span>,
      );
    }
    cursor = index + token.length;
  }
  if (cursor < line.length) output.push(line.slice(cursor));
  return output;
}

export function MessageContent({
  body,
  mentionNames = [],
}: {
  body: string;
  mentionNames?: string[];
}) {
  const gifUrls = Array.from(
    body.matchAll(URL_TOKEN),
    (match) => match[0],
  ).filter(isGifUrl);
  let text = body;
  for (const gifUrl of gifUrls) text = text.replace(gifUrl, "");
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  let lineOffset = 0;
  const lines = text.split("\n").map((line) => {
    const segment = { key: `${lineOffset}-${line}`, line, offset: lineOffset };
    lineOffset += line.length + 1;
    return segment;
  });

  return (
    <div className="bluplai-chat__message-content">
      {text
        ? lines.map((segment) => (
            <span className="bluplai-chat__message-line" key={segment.key}>
              {segment.line ? (
                renderInline(segment.line, segment.offset, mentionNames)
              ) : (
                <br />
              )}
            </span>
          ))
        : null}
      {gifUrls.length ? (
        <div className="bluplai-chat__message-gifs">
          {gifUrls.map((gifUrl) => (
            <a
              href={gifUrl}
              key={gifUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              <img alt="Shared GIF" loading="lazy" src={gifUrl} />
              <span>GIF</span>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}
