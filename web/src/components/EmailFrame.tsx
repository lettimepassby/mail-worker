import { useEffect, useMemo, useRef, useState } from 'react';

const BASE_STYLE = `
  html { color-scheme: light; }
  body { margin: 0; padding: 20px; background: #fff; color: #1f2937;
         font: 14px/1.6 ui-sans-serif, system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
         overflow-wrap: anywhere; }
  img, video { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  pre { white-space: pre-wrap; }
  blockquote { margin-left: 0; padding-left: 12px; border-left: 3px solid #e5e7eb; color: #4b5563; }
`;

const REMOTE_RE = /(<img\b[^>]*\bsrc\s*=\s*["']?\s*(https?:)?\/\/)|(url\(\s*["']?\s*(https?:)?\/\/)|(\bbackground\s*=\s*["']?\s*https?:)/i;

export function hasRemoteContent(html: string): boolean {
  return REMOTE_RE.test(html);
}

/**
 * Renders untrusted email HTML. The iframe is sandboxed without scripts, and a
 * CSP blocks remote resources (tracking pixels) unless the user allows them.
 * allow-same-origin is only there so the parent can measure the content height;
 * with scripts disabled the email can't use it.
 */
export default function EmailFrame({ html, allowRemote }: { html: string; allowRemote: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);

  const srcDoc = useMemo(() => {
    const origin = window.location.origin;
    const remote = allowRemote ? ' https: http:' : '';
    const csp = [
      "default-src 'none'",
      `img-src data: ${origin}${remote}`,
      `style-src 'unsafe-inline'${remote}`,
      `font-src data:${remote}`,
    ].join('; ');
    return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><meta charset="utf-8"><base target="_blank"><style>${BASE_STYLE}</style>${html}`;
  }, [html, allowRemote]);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | null = null;
    const measure = () => {
      const doc = frame.contentDocument;
      // documentElement.scrollHeight never drops below the iframe's own height, so use the content box.
      if (doc?.documentElement) {
        const content = Math.ceil(doc.documentElement.getBoundingClientRect().height);
        setHeight(Math.max(content, doc.body?.scrollHeight ?? 0, 60));
      }
    };
    const onLoad = () => {
      measure();
      const doc = frame.contentDocument;
      if (!doc?.body) return;
      observer = new ResizeObserver(measure);
      observer.observe(doc.body);
      doc.querySelectorAll('img').forEach((img) => img.addEventListener('load', measure));
    };
    frame.addEventListener('load', onLoad);
    return () => {
      frame.removeEventListener('load', onLoad);
      observer?.disconnect();
    };
  }, [srcDoc]);

  return (
    <iframe
      ref={ref}
      title="邮件正文"
      srcDoc={srcDoc}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      className="block w-full rounded-xl border-0 bg-white ring-1 ring-zinc-200 dark:ring-zinc-800"
      style={{ height }}
    />
  );
}
