/**
 * Server-side cleanup of email HTML. The client additionally renders it in a
 * sandboxed iframe (no scripts) with a restrictive CSP, so this pass only needs
 * to drop active content and rewrite cid: references to signed URLs.
 */

const STRIP = 'script, iframe, frame, frameset, object, embed, applet, base, link, meta[http-equiv]';
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'background', 'xlink:href', 'poster']);

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export async function sanitizeEmailHtml(html: string, cidUrls: Map<string, string>): Promise<string> {
  const rewriter = new HTMLRewriter()
    .on(STRIP, {
      element(el) {
        el.remove();
      },
    })
    .on('form', {
      element(el) {
        el.removeAndKeepContent();
      },
    })
    .on('*', {
      element(el) {
        const drop: string[] = [];
        const replace: [string, string][] = [];
        for (const [name, value] of el.attributes) {
          if (name.startsWith('on')) drop.push(name);
          else if (URL_ATTRS.has(name)) {
            const v = value.trim();
            if (/^(javascript|vbscript|data:text\/html)/i.test(v)) drop.push(name);
            else if (/^cid:/i.test(v)) {
              const url = cidUrls.get(safeDecode(v.slice(4)).replace(/^<|>$/g, ''));
              if (url) replace.push([name, url]);
              else drop.push(name);
            }
          }
        }
        for (const name of drop) el.removeAttribute(name);
        for (const [name, url] of replace) el.setAttribute(name, url);
        if (el.tagName === 'a') {
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer');
        }
      },
    });
  return rewriter.transform(new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })).text();
}
