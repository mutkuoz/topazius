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

  it('says so when the vault has no notes yet', () => {
    render(<Tree paths={[]} selected={null} onSelect={vi.fn()} />);
    expect(document.body.textContent).toMatch(/no notes/i);
  });
});
