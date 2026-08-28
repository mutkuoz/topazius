import { cleanup, render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Tree } from '../src/ui/Tree';

afterEach(cleanup);

const PATHS = ['work/standup.md', 'work/roadmap.md', 'journal/aug27.md.enc', 'inbox.md'];

describe('<Tree />', () => {
  it('exposes tree semantics to assistive technology', () => {
    render(<Tree paths={PATHS} selected={null} onSelect={vi.fn()} />);

    expect(screen.getByRole('tree')).toBeInTheDocument();
    expect(screen.getAllByRole('treeitem').length).toBeGreaterThan(0);
  });

  it('marks encrypted notes', () => {
    render(<Tree paths={PATHS} selected={null} onSelect={vi.fn()} />);
    expect(screen.getByText('aug27').closest('[role="treeitem"]')?.textContent).toContain('enc');
  });

  it('selects a note when clicked', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<Tree paths={PATHS} selected={null} onSelect={onSelect} />);

    await user.click(screen.getByText('standup'));
    expect(onSelect).toHaveBeenCalledWith('work/standup.md');
  });

  it('collapses and expands a folder', async () => {
    const user = userEvent.setup();
    render(<Tree paths={PATHS} selected={null} onSelect={vi.fn()} />);

    expect(screen.getByText('standup')).toBeInTheDocument();
    await user.click(screen.getByText('work'));
    expect(screen.queryByText('standup')).toBeNull();

    await user.click(screen.getByText('work'));
    expect(screen.getByText('standup')).toBeInTheDocument();
  });

  it('reports the selected note as the active treeitem', () => {
    render(<Tree paths={PATHS} selected="work/standup.md" onSelect={vi.fn()} />);
    expect(screen.getByText('standup').closest('[role="treeitem"]')).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('says so when the vault has no notes yet, and offers to fix that', async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(<Tree paths={[]} selected={null} onSelect={vi.fn()} onAction={onAction} />);

    expect(document.body.textContent).toMatch(/nothing here yet/i);
    await user.click(screen.getByRole('button', { name: /write your first note/i }));
    expect(onAction).toHaveBeenCalledWith({ kind: 'new', folder: '' });
  });

  it('offers per-row actions without requiring a right-click', async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(<Tree paths={PATHS} selected={null} onSelect={vi.fn()} onAction={onAction} />);

    // A folder's "+" creates a note in it.
    await user.click(screen.getByRole('button', { name: 'New note in work' }));
    expect(onAction).toHaveBeenCalledWith({ kind: 'new', folder: 'work' });

    // A note's menu carries the rest.
    await user.click(screen.getByRole('button', { name: 'Actions for standup' }));
    await user.click(screen.getByRole('menuitem', { name: /rename or move/i }));
    expect(onAction).toHaveBeenCalledWith({ kind: 'rename', path: 'work/standup.md' });
  });

  it('hides the row actions from a read-only tree', () => {
    render(<Tree paths={PATHS} selected={null} onSelect={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /actions for/i })).toBeNull();
  });
});
