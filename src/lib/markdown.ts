import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';

/**
 * Schemes a link may use. Anything else - `javascript:`, `data:`, `vbscript:` -
 * is dropped by the sanitizer, which is the allowlist spec §8.2 requires.
 * Relative links (wikilinks, images inside the vault) carry no scheme and are
 * matched by the `#`/`.`/`/` alternatives.
 */
const ALLOWED_URI = /^(?:https?:|mailto:|[#./]|[^:]*$)/i;

const FORBID_TAGS = ['script', 'iframe', 'object', 'embed', 'form', 'style', 'base', 'link', 'meta'];
const FORBID_ATTR = ['srcset', 'formaction', 'ping', 'style'];

export interface RenderOptions {
  /** Resolve a wikilink target to a vault path; null renders the "missing" style. */
  resolve?: (target: string) => string | null;
}

/**
 * Wikilinks and inline tags are added as markdown-it *inline rules*, so their
 * text never re-enters the parser as a string and code spans and fences are
 * skipped for free. Attribute values go through markdown-it's own escaping,
 * never string concatenation (spec §10.4).
 */
function wikilink(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x5b /* [ */ || state.src.charCodeAt(start + 1) !== 0x5b) {
    return false;
  }
  const end = state.src.indexOf(']]', start + 2);
  if (end === -1) return false;

  const inner = state.src.slice(start + 2, end);
  if (inner.includes('[') || inner.includes(']') || inner.includes('\n')) return false;

  const pipe = inner.indexOf('|');
  const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
  const label = (pipe === -1 ? '' : inner.slice(pipe + 1).trim()) || target;
  if (!target) return false;

  if (!silent) {
    const resolve = (state.env as { topazius?: RenderOptions } | undefined)?.topazius?.resolve;
    const resolved = resolve ? resolve(target) : null;

    const open = state.push('link_open', 'a', 1);
    open.attrSet('class', resolved ? 'wikilink' : 'wikilink missing');
    open.attrSet('data-note', resolved ?? target);
    if (!resolved) open.attrSet('title', `${target} — no such note yet`);

    const text = state.push('text', '', 0);
    text.content = label;

    state.push('link_close', 'a', -1);
  }

  state.pos = end + 2;
  return true;
}

const TAG_CHAR = /[\w-]/;

function inlineTag(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x23 /* # */) return false;

  // Not a tag when glued to a word (`a#b`) or to another `#` (`##`).
  const before = start === 0 ? '' : state.src[start - 1];
  if (before && /[\w#&]/.test(before)) return false;

  let end = start + 1;
  if (!/[A-Za-z]/.test(state.src[end] ?? '')) return false;
  while (end < state.src.length && (TAG_CHAR.test(state.src[end] ?? '') || state.src[end] === '/')) {
    end++;
  }
  // A trailing separator is punctuation, not part of the tag.
  while (end > start + 1 && /[-/]/.test(state.src[end - 1] ?? '')) end--;

  if (!silent) {
    const name = state.src.slice(start + 1, end);
    const open = state.push('link_open', 'a', 1);
    open.attrSet('class', 'tag');
    open.attrSet('data-tag', name);
    const text = state.push('text', '', 0);
    text.content = `#${name}`;
    state.push('link_close', 'a', -1);
  }

  state.pos = end;
  return true;
}

function createRenderer(): MarkdownIt {
  const md = new MarkdownIt({
    html: false, // raw HTML in notes is never rendered; DOMPurify is the second line
    linkify: true,
    breaks: false,
    typographer: false,
  });

  md.inline.ruler.before('link', 'topazius_wikilink', wikilink);
  md.inline.ruler.push('topazius_tag', inlineTag);

  /**
   * The vault is private, so a relative image cannot be fetched by the browser
   * as an ordinary URL - it needs the token. Emit the path as data-vault-src
   * and no src at all; ui/Preview.tsx swaps in an object URL once the blob is
   * decrypted (spec §8.3). Absolute http(s) images are left alone.
   */
  md.renderer.rules['image'] = (tokens, index, options, _env, self) => {
    const token = tokens[index];
    if (!token) return '';
    const src = token.attrGet('src') ?? '';
    if (!/^(?:https?:)?\/\//i.test(src) && !src.startsWith('data:')) {
      token.attrSet('data-vault-src', src);
      const attrIndex = token.attrIndex('src');
      if (attrIndex >= 0) token.attrs?.splice(attrIndex, 1);
    }
    token.attrSet('alt', token.content);
    return self.renderToken(tokens, index, options);
  };

  return md;
}

const md = createRenderer();

let hooked = false;

/**
 * DOMPurify hooks are per-instance and installed once. Cannot run at module
 * scope: the sanitizer needs a DOM, and this module is imported by tests that
 * exercise the pure parsing path too.
 */
function ensureHooks(): void {
  if (hooked) return;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof Element)) return;
    if (node.tagName === 'A') {
      const href = node.getAttribute('href');
      // Only outbound links get a target; internal note links are handled by
      // the app, and a target on them would open a second copy of the app.
      if (href && /^https?:/i.test(href)) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      } else if (node.hasAttribute('target')) {
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }
    if (node.tagName === 'IMG') {
      node.setAttribute('loading', 'lazy');
    }
  });
  hooked = true;
}

export function sanitize(html: string): string {
  ensureHooks();
  return DOMPurify.sanitize(html, {
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOWED_URI_REGEXP: ALLOWED_URI,
    ADD_ATTR: ['target', 'data-note', 'data-tag', 'data-vault-src', 'loading'],
    ALLOW_DATA_ATTR: true,
  });
}

/** Markdown → sanitised HTML. Every render path in the app goes through here. */
export function renderMarkdown(source: string, options: RenderOptions = {}): string {
  const html = md.render(source, { topazius: options });
  return sanitize(html);
}
