import type { ComponentChildren } from 'preact';
import { useRef } from 'preact/hooks';
import type { EditorAction } from '../editor/setup';
import {
  BoldIcon,
  BulletListIcon,
  CodeBlockIcon,
  CodeIcon,
  HeadingIcon,
  ImageIcon,
  ItalicIcon,
  LinkIcon,
  NoteLinkIcon,
  OrderedListIcon,
  QuoteIcon,
  RuleIcon,
  StrikeIcon,
  TableIcon,
  TaskListIcon,
} from './icons';

export interface ToolbarProps {
  /** Runs a named editing command against the open editor. */
  run: (action: EditorAction) => void;
  /** Opens the file picker for an image upload. */
  onPickImage: (files: File[]) => void;
  disabled?: boolean;
}

interface ButtonProps {
  label: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
  children: ComponentChildren;
}

function ToolButton({ label, hint, onClick, disabled, children }: ButtonProps) {
  return (
    <button
      type="button"
      class="tool"
      title={hint ? `${label} · ${hint}` : label}
      aria-label={label}
      disabled={disabled}
      // The editor must keep the caret: without this the button steals focus
      // on mousedown and the command runs against a collapsed, invisible
      // selection.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * The formatting toolbar.
 *
 * Everything here is a markdown construct — which is also why there is no
 * paragraph alignment control: markdown has no such thing, and faking it with
 * raw HTML would be stripped by the sanitizer and unreadable in Obsidian.
 * Alignment exists per column inside a table, which the table button writes as
 * the `| --- |` row for you to change to `:---:`.
 */
export function Toolbar({ run, onPickImage, disabled }: ToolbarProps) {
  const picker = useRef<HTMLInputElement>(null);

  return (
    <div class="toolbar" role="toolbar" aria-label="Formatting" aria-disabled={disabled}>
      <div class="tool-group">
        <ToolButton label="Heading 1" onClick={() => run('h1')} disabled={disabled}>
          <HeadingIcon level={1} />
        </ToolButton>
        <ToolButton label="Heading 2" onClick={() => run('h2')} disabled={disabled}>
          <HeadingIcon level={2} />
        </ToolButton>
        <ToolButton label="Heading 3" onClick={() => run('h3')} disabled={disabled}>
          <HeadingIcon level={3} />
        </ToolButton>
      </div>

      <div class="tool-group">
        <ToolButton label="Bold" hint="⌘B" onClick={() => run('bold')} disabled={disabled}>
          <BoldIcon />
        </ToolButton>
        <ToolButton label="Italic" hint="⌘I" onClick={() => run('italic')} disabled={disabled}>
          <ItalicIcon />
        </ToolButton>
        <ToolButton label="Strikethrough" onClick={() => run('strike')} disabled={disabled}>
          <StrikeIcon />
        </ToolButton>
        <ToolButton label="Inline code" onClick={() => run('code')} disabled={disabled}>
          <CodeIcon />
        </ToolButton>
      </div>

      <div class="tool-group">
        <ToolButton label="Bulleted list" onClick={() => run('bullet')} disabled={disabled}>
          <BulletListIcon />
        </ToolButton>
        <ToolButton label="Numbered list" onClick={() => run('ordered')} disabled={disabled}>
          <OrderedListIcon />
        </ToolButton>
        <ToolButton label="Task list" onClick={() => run('task')} disabled={disabled}>
          <TaskListIcon />
        </ToolButton>
        <ToolButton label="Quote" onClick={() => run('quote')} disabled={disabled}>
          <QuoteIcon />
        </ToolButton>
      </div>

      <div class="tool-group">
        <ToolButton label="Link" onClick={() => run('link')} disabled={disabled}>
          <LinkIcon />
        </ToolButton>
        <ToolButton label="Link to a note" hint="[[wikilink]]" onClick={() => run('wikilink')} disabled={disabled}>
          <NoteLinkIcon />
        </ToolButton>
        <ToolButton
          label="Image"
          hint="or paste one"
          onClick={() => picker.current?.click()}
          disabled={disabled}
        >
          <ImageIcon />
        </ToolButton>
      </div>

      <div class="tool-group">
        <ToolButton label="Code block" onClick={() => run('codeblock')} disabled={disabled}>
          <CodeBlockIcon />
        </ToolButton>
        <ToolButton
          label="Table"
          hint="column alignment goes in the | --- | row"
          onClick={() => run('table')}
          disabled={disabled}
        >
          <TableIcon />
        </ToolButton>
        <ToolButton label="Divider" onClick={() => run('rule')} disabled={disabled}>
          <RuleIcon />
        </ToolButton>
      </div>

      <input
        ref={picker}
        class="visually-hidden"
        type="file"
        accept="image/*"
        multiple
        tabIndex={-1}
        onChange={(event) => {
          const input = event.currentTarget;
          const files = [...(input.files ?? [])];
          // Cleared so choosing the same file twice in a row fires again.
          input.value = '';
          if (files.length > 0) onPickImage(files);
        }}
      />
    </div>
  );
}
