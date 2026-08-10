import { Children, type ReactNode } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const URL_TOKEN = /https:\/\/[^\s]+/gu;

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionPattern(mentionNames: string[]): RegExp {
  const knownMentions = mentionNames
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .map((name) => escapePattern(`@${name}`));
  const mention = [...knownMentions, "@[\\p{L}\\p{N}._-]+"].join("|");
  return new RegExp(`(${mention})`, "gu");
}

function renderMentions(
  children: ReactNode,
  mentionNames: string[],
): ReactNode {
  const pattern = mentionPattern(mentionNames);
  return Children.map(children, (child) => {
    if (typeof child !== "string") return child;
    const output: ReactNode[] = [];
    let cursor = 0;
    for (const part of child.split(pattern)) {
      if (part.startsWith("@")) {
        output.push(
          <span className="bluplai-chat__mention" key={`${part}-${cursor}`}>
            {part}
          </span>,
        );
      } else if (part) {
        output.push(part);
      }
      cursor += part.length;
    }
    return output;
  });
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

function safeExternalHref(value: string | undefined): string | null {
  const hasControl = [...(value ?? "")].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (!value || value.startsWith("//") || value.includes("\\") || hasControl)
    return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "mailto:"
      ? value
      : null;
  } catch {
    return null;
  }
}

function markdownComponents(mentionNames: string[]): Components {
  return {
    a: ({ children, href, ...props }) => {
      const safeHref = safeExternalHref(href);
      return safeHref ? (
        <a {...props} href={safeHref} rel="noopener noreferrer" target="_blank">
          {children}
        </a>
      ) : (
        <span>{children}</span>
      );
    },
    img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : "[Image]"}</span>,
    blockquote: ({ children, ...props }) => (
      <blockquote {...props}>
        {renderMentions(children, mentionNames)}
      </blockquote>
    ),
    em: ({ children, ...props }) => (
      <em {...props}>{renderMentions(children, mentionNames)}</em>
    ),
    h1: ({ children, ...props }) => (
      <h1 {...props}>{renderMentions(children, mentionNames)}</h1>
    ),
    h2: ({ children, ...props }) => (
      <h2 {...props}>{renderMentions(children, mentionNames)}</h2>
    ),
    h3: ({ children, ...props }) => (
      <h3 {...props}>{renderMentions(children, mentionNames)}</h3>
    ),
    h4: ({ children, ...props }) => (
      <h4 {...props}>{renderMentions(children, mentionNames)}</h4>
    ),
    li: ({ children, ...props }) => (
      <li {...props}>{renderMentions(children, mentionNames)}</li>
    ),
    p: ({ children, ...props }) => (
      <p {...props}>{renderMentions(children, mentionNames)}</p>
    ),
    strong: ({ children, ...props }) => (
      <strong {...props}>{renderMentions(children, mentionNames)}</strong>
    ),
    table: ({ children, ...props }) => (
      <section
        aria-label="Scrollable message table"
        className="bluplai-chat__table-scroll"
      >
        <table {...props}>{children}</table>
      </section>
    ),
    td: ({ children, ...props }) => (
      <td {...props}>{renderMentions(children, mentionNames)}</td>
    ),
    th: ({ children, ...props }) => (
      <th {...props}>{renderMentions(children, mentionNames)}</th>
    ),
  };
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

  return (
    <div className="bluplai-chat__message-content">
      {text ? (
        <ReactMarkdown
          components={markdownComponents(mentionNames)}
          remarkPlugins={[remarkGfm]}
        >
          {text}
        </ReactMarkdown>
      ) : null}
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
