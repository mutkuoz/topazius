/**
 * @vitest-environment jsdom
 *
 * Not happy-dom, deliberately: happy-dom defines `nodeName` on Element rather
 * than making Node.prototype's getter work for elements, and DOMPurify reads it
 * through the cached `Node.prototype` getter (its defence against a clobbered
 * property). Every tag name comes back empty there, so the sanitizer silently
 * strips the first element and stops - it would appear to pass tests while
 * testing nothing. jsdom gets this right, and this suite is the one place the
 * real sanitizer must be exercised.
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown, sanitize } from '../src/lib/markdown';

const render = (source: string, resolve?: (target: string) => string | null) =>
  renderMarkdown(source, resolve ? { resolve } : {});

describe('markdown rendering', () => {
  it('renders GFM basics', () => {
    expect(render('# Title\n\n- one\n- two')).toContain('<h1>Title</h1>');
    expect(render('| a | b |\n|---|---|\n| 1 | 2 |')).toContain('<table>');
    expect(render('~~gone~~')).toContain('<s>gone</s>');
  });

  it('escapes text that looks like HTML instead of rendering it', () => {
    const html = render('a < b & c > d');
    expect(html).toContain('&lt;');
    expect(html).toContain('&amp;');
  });
});

describe('sanitizer', () => {
  const corpus = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<iframe src="about:blank"></iframe>',
    '<a href="javascript:alert(1)">click</a>',
    '<a href="JaVaScRiPt:alert(1)">click</a>',
    '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">click</a>',
    '<svg><script>alert(1)</script></svg>',
    '<object data="evil.swf"></object>',
    '<embed src="evil.swf">',
    '<form action="/steal"><input name="token"></form>',
    '<style>body{display:none}</style>',
    '<body onload=alert(1)>',
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
    '<div onmouseover="alert(1)">hover</div>',
    '<a href="vbscript:msgbox(1)">click</a>',
    // Targets kept relative: the payload is about the tag, and a live URL here
    // would have the test environment try to fetch it.
    '<base href="/evil/">',
    '<meta http-equiv="refresh" content="0;url=#evil">',
    '<link rel="stylesheet" href="evil.css">',
  ];

  it('neutralises the XSS corpus', () => {
    for (const payload of corpus) {
      const html = sanitize(payload);
      expect(html.toLowerCase(), payload).not.toContain('<script');
      expect(html.toLowerCase(), payload).not.toContain('<iframe');
      expect(html.toLowerCase(), payload).not.toContain('onerror');
      expect(html.toLowerCase(), payload).not.toContain('onload');
      expect(html.toLowerCase(), payload).not.toContain('onmouseover');
      expect(html.toLowerCase(), payload).not.toContain('javascript:');
      expect(html.toLowerCase(), payload).not.toContain('vbscript:');
      expect(html.toLowerCase(), payload).not.toContain('<form');
      expect(html.toLowerCase(), payload).not.toContain('<style');
      expect(html.toLowerCase(), payload).not.toContain('<base');
    }
  });

  it('does not render raw HTML written in a note at all', () => {
    expect(render('<script>alert(1)</script>')).not.toContain('alert(1)</script>');
    expect(render('<b>bold?</b>')).toContain('&lt;b&gt;');
  });

  it('keeps http, https and mailto links', () => {
    expect(render('[x](https://example.com)')).toContain('href="https://example.com"');
    expect(render('[x](mailto:me@example.com)')).toContain('href="mailto:me@example.com"');
  });

  it('forces rel=noopener noreferrer on links that open a new tab', () => {
    const html = render('[x](https://example.com)');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('does not send internal note links to a new tab', () => {
    const html = render('[[work/standup]]', () => 'work/standup.md');
    expect(html).not.toContain('target="_blank"');
  });
});

describe('wikilinks', () => {
  it('resolves a link and carries the path as data', () => {
    const html = render('see [[work/standup]]', () => 'work/standup.md');
    expect(html).toContain('data-note="work/standup.md"');
    expect(html).toContain('class="wikilink"');
    expect(html).toContain('>work/standup</a>');
  });

  it('marks an unresolved link as missing', () => {
    const html = render('see [[nowhere]]', () => null);
    expect(html).toContain('wikilink missing');
    expect(html).toContain('data-note="nowhere"');
  });

  it('renders the alias, not the target', () => {
    const html = render('[[work/standup|yesterday]]', () => 'work/standup.md');
    expect(html).toContain('>yesterday</a>');
  });

  it('escapes a target crafted to break out of the attribute', () => {
    const html = render('[[a" onmouseover="alert(1)]]', (t) => t);
    const host = document.createElement('div');
    host.innerHTML = html;
    const anchor = host.querySelector('a');
    expect(anchor?.getAttributeNames().sort()).toEqual(['class', 'data-note']);
    expect(anchor?.getAttribute('data-note')).toBe('a" onmouseover="alert(1)');
  });

  it('leaves wikilinks inside code spans alone', () => {
    expect(render('`[[literal]]`')).toContain('<code>[[literal]]</code>');
  });
});

describe('inline tags', () => {
  it('renders a tag as a clickable element carrying its name', () => {
    const html = render('see #planning today');
    expect(html).toContain('class="tag"');
    expect(html).toContain('data-tag="planning"');
    expect(html).toContain('>#planning</a>');
  });

  it('leaves headings, hex colours glued to words, and code alone', () => {
    expect(render('# Heading')).toContain('<h1>Heading</h1>');
    expect(render('`#nope`')).toContain('<code>#nope</code>');
    expect(render('a#b')).not.toContain('data-tag');
  });

  it('drops a trailing dash from the tag name', () => {
    expect(render('#work- done')).toContain('data-tag="work"');
  });
});

describe('images', () => {
  it('defers a vault-relative image to the resolver instead of emitting a src', () => {
    const html = render('![a picture](assets/2026/08/pic-a1b2.png)');
    const host = document.createElement('div');
    host.innerHTML = html;
    const image = host.querySelector('img');
    expect(image?.getAttribute('data-vault-src')).toBe('assets/2026/08/pic-a1b2.png');
    expect(image?.hasAttribute('src')).toBe(false);
    expect(image?.getAttribute('alt')).toBe('a picture');
  });

  it('leaves an absolute image source alone', () => {
    expect(render('![x](https://example.com/x.png)')).toContain('src="https://example.com/x.png"');
  });

  it('marks images lazy', () => {
    expect(render('![x](https://example.com/x.png)')).toContain('loading="lazy"');
  });

  it('never builds an image element for a javascript: source', () => {
    // markdown-it refuses the scheme outright, so the line stays literal text -
    // escaped, inert, and visible, which is the honest outcome.
    const html = render('![x](javascript:alert(1))');
    expect(html).not.toContain('<img');
    const host = document.createElement('div');
    host.innerHTML = html;
    expect(host.textContent).toContain('![x](javascript:alert(1))');
  });
});
