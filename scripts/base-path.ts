/**
 * GitHub Pages serves a project site from /<repo-name>/, so the bundle's asset
 * URLs must be prefixed to match. Local dev and user/organisation sites use '/'.
 */
export function resolveBase(env: Record<string, string | undefined>): string {
  const trimmed = (env.PAGES_BASE ?? '').trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}/` : '/';
}
