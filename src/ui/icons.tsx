import type { JSX } from 'preact';

/**
 * The icon set, inline.
 *
 * Drawn here rather than pulled from an icon package because the app ships no
 * runtime fetches and every byte is in the bundle: a dozen 24px paths cost less
 * than a dependency, and `currentColor` means they follow the theme for free.
 * Each is a 24×24 stroked path on the same grid, so they line up in a row.
 */

type IconProps = JSX.SVGAttributes<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

/** Headings are drawn as glyphs: a stroked "H1" reads faster than any symbol. */
export function HeadingIcon({ level }: { level: 1 | 2 | 3 }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <text
        x="12"
        y="17"
        text-anchor="middle"
        font-size="14"
        font-weight="700"
        fill="currentColor"
        font-family="inherit"
      >
        H{level}
      </text>
    </svg>
  );
}

export const BoldIcon = () => (
  <Icon>
    <path d="M7 5h6.5a3.5 3.5 0 0 1 0 7H7z" />
    <path d="M7 12h7.5a3.5 3.5 0 0 1 0 7H7z" />
  </Icon>
);

export const ItalicIcon = () => (
  <Icon>
    <path d="M14 5h5M9 19h5M14.5 5 10 19" />
  </Icon>
);

export const StrikeIcon = () => (
  <Icon>
    <path d="M4 12h16" />
    <path d="M16 7c-.8-1.3-2.3-2-4.3-2C9 5 7.5 6.2 7.5 8c0 1.4 1 2.3 2.8 2.9" />
    <path d="M8.5 17c.9 1.3 2.4 2 4.4 2 2.6 0 4.1-1.2 4.1-3 0-.5-.1-1-.4-1.4" />
  </Icon>
);

export const CodeIcon = () => (
  <Icon>
    <path d="m9 8-5 4 5 4M15 8l5 4-5 4" />
  </Icon>
);

export const CodeBlockIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m9.5 10-2 2 2 2M14.5 10l2 2-2 2" />
  </Icon>
);

export const QuoteIcon = () => (
  <Icon>
    <path d="M5 5v14" />
    <path d="M10 8h9M10 12h9M10 16h6" />
  </Icon>
);

export const BulletListIcon = () => (
  <Icon>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <circle cx="4.5" cy="6" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="18" r="1.1" fill="currentColor" stroke="none" />
  </Icon>
);

export const OrderedListIcon = () => (
  <Icon>
    <path d="M10 6h10M10 12h10M10 18h10" />
    <path d="M4 5h1v4M3.5 12.5h2M3.5 12.5c0-.8 2-.8 2 0s-2 1-2 2h2M3.5 17h2v3h-2" />
  </Icon>
);

export const TaskListIcon = () => (
  <Icon>
    <path d="M11 6h9M11 12h9M11 18h9" />
    <path d="m3 6 1.5 1.5L7.5 4.5" />
    <rect x="3" y="10" width="4" height="4" rx="1" />
    <rect x="3" y="16" width="4" height="4" rx="1" />
  </Icon>
);

export const LinkIcon = () => (
  <Icon>
    <path d="M10 13a4 4 0 0 0 5.7.4l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.5 1.5" />
    <path d="M14 11a4 4 0 0 0-5.7-.4l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.5-1.5" />
  </Icon>
);

export const NoteLinkIcon = () => (
  <Icon>
    <path d="M9 5 5 9l4 4M15 5l4 4-4 4" />
    <path d="M10 19h4" />
  </Icon>
);

export const ImageIcon = () => (
  <Icon>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <circle cx="8.5" cy="10" r="1.6" />
    <path d="m4 17 4.5-4.5 4 4 3-3L20 17" />
  </Icon>
);

export const TableIcon = () => (
  <Icon>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 10h18M9 10v9M15 10v9" />
  </Icon>
);

export const RuleIcon = () => (
  <Icon>
    <path d="M4 12h16" />
    <path d="M7 7h10M7 17h10" opacity="0.4" />
  </Icon>
);

export const MoreIcon = () => (
  <Icon>
    <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </Icon>
);

export const SidebarIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </Icon>
);

export const LockIcon = () => (
  <Icon>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Icon>
);

export const SearchIcon = () => (
  <Icon>
    <circle cx="11" cy="11" r="6" />
    <path d="m16 16 4 4" />
  </Icon>
);

export const PlusIcon = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const ExternalIcon = () => (
  <Icon>
    <path d="M14 5h5v5" />
    <path d="M19 5 11 13" />
    <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
  </Icon>
);
