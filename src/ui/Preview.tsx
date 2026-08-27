import { useEffect, useRef } from 'preact/hooks';
import { parseNote } from '../lib/frontmatter';
import { createObjectUrlCache } from '../lib/images';
import { renderMarkdown } from '../lib/markdown';
import './preview.css';

export interface PreviewProps {
  path: string;
  text: string;
  /** Resolve a wikilink target to a vault path, or null when it does not exist. */
  resolveLink: (target: string) => string | null;
  onOpenNote: (path: string) => void;
  /** A click on an unresolved wikilink offers to create it. */
  onCreateNote: (target: string) => void;
  onSelectTag: (tag: string) => void;
  /** Decrypt and hand back an image's bytes, or null when it is missing. */
  loadImage: (src: string) => Promise<{ bytes: Uint8Array; mime: string } | null>;
}

/**
 * The rendered note (spec §8.2). Everything here goes through renderMarkdown,
 * which ends in DOMPurify: this component never assembles HTML itself, and the
 * only thing it writes into the DOM afterwards is an object URL it created.
 */
export function Preview({
  path,
  text,
  resolveLink,
  onOpenNote,
  onCreateNote,
  onSelectTag,
  loadImage,
}: PreviewProps) {
  const host = useRef<HTMLElement>(null);
  const urls = useRef(createObjectUrlCache());
  /** What is currently in the DOM, and which node it was written into. */
  const painted = useRef<{ html: string; node: Element } | null>(null);
  /** Bumped per paint; an image that resolves after the next one is discarded. */
  const generation = useRef(0);

  const parsed = parseNote(text);
  const html = renderMarkdown(parsed.body, { resolve: resolveLink });

  useEffect(() => {
    const cache = urls.current;
    return () => {
      // Each object URL pins its blob until revoked, so the whole cache is
      // dropped when the pane unmounts (spec §8.3).
      cache.releaseAll();
    };
  }, []);

  /**
   * Sanitised HTML, assigned in one place. Rendering it through Preact instead
   * would mean rebuilding markdown-it's output as a virtual tree for no gain,
   * and dangerouslySetInnerHTML on unsanitised text is exactly the mistake
   * §10.4 exists to prevent.
   *
   * Deliberately without a dependency array. The check is against what is
   * *actually in the DOM*, not against what the last render thought it put
   * there: if Preact ever replaces this element - the surrounding tree changes
   * shape when a dialog or a toast appears - a dependency-guarded effect would
   * not re-run, and the pane would sit there blank with no way back.
   */
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    if (painted.current?.html === html && painted.current.node === element) return;

    element.innerHTML = html;
    painted.current = { html, node: element };

    const mine = ++generation.current;
    const current = () => generation.current === mine;

    for (const image of element.querySelectorAll<HTMLImageElement>('img[data-vault-src]')) {
      const src = image.getAttribute('data-vault-src') ?? '';
      const known = urls.current.get(src);
      if (known) {
        image.src = known;
        continue;
      }

      image.classList.add('image-loading');
      void loadImage(src)
        .then((asset) => {
          if (!current()) return;
          if (!asset) {
            markMissing(image, src);
            return;
          }
          image.src = urls.current.set(src, asset.bytes, asset.mime);
          image.classList.remove('image-loading');
        })
        .catch((error: unknown) => {
          if (!current()) return;
          markMissing(image, src, error instanceof Error ? error.message : undefined);
        });
    }
  });

  return (
    <article
      class="preview"
      ref={host}
      data-path={path}
      onClick={(event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;

        const link = target.closest('a');
        if (!(link instanceof HTMLAnchorElement)) return;

        const note = link.getAttribute('data-note');
        if (note !== null) {
          event.preventDefault();
          if (link.classList.contains('missing')) onCreateNote(note);
          else onOpenNote(note);
          return;
        }

        const tag = link.getAttribute('data-tag');
        if (tag !== null) {
          event.preventDefault();
          onSelectTag(tag);
        }
      }}
    />
  );
}

/** Name what is missing rather than leaving a broken image icon (spec §8.3). */
function markMissing(image: HTMLImageElement, src: string, detail?: string): void {
  const note = image.ownerDocument.createElement('span');
  note.className = 'image-missing';
  note.textContent = detail ? `${src} — ${detail}` : `Image not found: ${src}`;
  image.replaceWith(note);
}
