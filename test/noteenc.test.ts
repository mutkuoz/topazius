import { describe, expect, it } from 'vitest';
import { MAGIC, NoteEncError, defaultForFolder, isSealed, newNotePath, openNote, sealNote, toggledPath } from '../src/lib/noteenc';
import { createVaultKey } from '../src/lib/vaultkey';

const NOTE = `---
title: Therapy
tags: [private]
# a comment the user wrote
---

# Tuesday

Body with emoji 🎉 and accents: café
`;

const vault = await createVaultKey('correct horse battery staple');

describe('sealNote', () => {
  it('produces a text file that explains itself', async () => {
    const sealed = await sealNote(vault.vmk, 'journal/tue.md.enc', NOTE);
    const lines = sealed.split('\n');
    expect(lines[0]).toBe('# topazius-encrypted v1');
    expect(lines[1]).toContain('needs your passphrase or recovery key');
    expect(lines[2]?.startsWith(`${MAGIC}.`)).toBe(true);
    expect(sealed.endsWith('\n')).toBe(true);
  });

  it('leaks no plaintext into the sealed file', async () => {
    const sealed = await sealNote(vault.vmk, 'journal/tue.md.enc', NOTE);
    expect(sealed).not.toContain('Therapy');
    expect(sealed).not.toContain('Tuesday');
    expect(sealed).not.toContain('private');
  });

  it('uses a fresh IV per save, so the same note never seals identically', async () => {
    const a = await sealNote(vault.vmk, 'a.md.enc', NOTE);
    const b = await sealNote(vault.vmk, 'a.md.enc', NOTE);
    expect(a).not.toBe(b);
  });
});

describe('openNote', () => {
  it('round-trips the note byte-identically, frontmatter and all', async () => {
    const sealed = await sealNote(vault.vmk, 'journal/tue.md.enc', NOTE);
    expect(await openNote(vault.vmk, 'journal/tue.md.enc', sealed)).toBe(NOTE);
  });

  it('round-trips an empty note', async () => {
    const sealed = await sealNote(vault.vmk, 'empty.md.enc', '');
    expect(await openNote(vault.vmk, 'empty.md.enc', sealed)).toBe('');
  });

  it('refuses ciphertext that was relocated to another path', async () => {
    const sealed = await sealNote(vault.vmk, 'journal/private.md.enc', NOTE);
    await expect(openNote(vault.vmk, 'inbox/note.md.enc', sealed)).rejects.toThrow(NoteEncError);
  });

  it('refuses a different vault key', async () => {
    const other = await createVaultKey('some other passphrase entirely');
    const sealed = await sealNote(vault.vmk, 'a.md.enc', NOTE);
    await expect(openNote(other.vmk, 'a.md.enc', sealed)).rejects.toThrow(NoteEncError);
  });

  it('refuses a hand-edited payload', async () => {
    const sealed = await sealNote(vault.vmk, 'a.md.enc', NOTE);
    const tampered = sealed.replace(/(TPZ1\.[^.]+\.)(.)/, (_, head: string, first: string) => head + (first === 'A' ? 'B' : 'A'));
    await expect(openNote(vault.vmk, 'a.md.enc', tampered)).rejects.toThrow(NoteEncError);
  });

  it('names the problem when handed a file that is not sealed at all', async () => {
    await expect(openNote(vault.vmk, 'a.md.enc', '# Just a note\n')).rejects.toThrow(
      /not a sealed Topazius note/,
    );
  });

  it('tolerates CRLF line endings introduced by another editor', async () => {
    const sealed = (await sealNote(vault.vmk, 'a.md.enc', NOTE)).replace(/\n/g, '\r\n');
    expect(await openNote(vault.vmk, 'a.md.enc', sealed)).toBe(NOTE);
  });
});

describe('isSealed', () => {
  it('recognises a sealed body whatever the filename claims', async () => {
    expect(isSealed(await sealNote(vault.vmk, 'a.md', NOTE))).toBe(true);
    expect(isSealed('# Hello\n\nTPZ1 is a nice name\n')).toBe(false);
  });
});

describe('toggledPath', () => {
  it('moves a note between its two states and back', () => {
    expect(toggledPath('work/note.md')).toBe('work/note.md.enc');
    expect(toggledPath('work/note.md.enc')).toBe('work/note.md');
  });
});

describe('folder defaults', () => {
  const defaults = { 'journal/': 'encrypted' as const, 'work/': 'plain' as const, 'work/private/': 'encrypted' as const };

  it('applies the most specific matching prefix', () => {
    expect(defaultForFolder(defaults, 'journal')).toBe('encrypted');
    expect(defaultForFolder(defaults, 'work')).toBe('plain');
    expect(defaultForFolder(defaults, 'work/private')).toBe('encrypted');
    expect(defaultForFolder(defaults, 'work/private/deep')).toBe('encrypted');
  });

  it('defaults to plain for unmatched folders, the root, and no configuration', () => {
    expect(defaultForFolder(defaults, 'recipes')).toBe('plain');
    expect(defaultForFolder(defaults, '')).toBe('plain');
    expect(defaultForFolder(undefined, 'journal')).toBe('plain');
  });

  it('decides the extension a new note is created with', () => {
    expect(newNotePath('journal', 'today', defaults)).toBe('journal/today.md.enc');
    expect(newNotePath('recipes', 'pizza', defaults)).toBe('recipes/pizza.md');
    expect(newNotePath('', 'inbox-item', defaults)).toBe('inbox-item.md');
  });
});
