/**
 * markdown-it-footnote ships no type declarations. It is a plugin function in
 * the markdown-it sense and nothing more, so that is all this needs to say.
 */
declare module 'markdown-it-footnote' {
  import type MarkdownIt from 'markdown-it';
  const footnote: MarkdownIt.PluginSimple;
  export default footnote;
}
