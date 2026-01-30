import React, { useEffect, useState } from 'react';
import { fetchWorktrees, createWorktree } from './api';

export function WorktreeList({ onSelect }: { onSelect: (path: string) => void }) {
  const [worktrees, setWorktrees] = useState<any[]>([]);
  const [newBranch, setNewBranch] = useState('');
  const [newPath, setNewPath] = useState('');

  useEffect(() => {
    loadWorktrees();
  }, []);

  const loadWorktrees = async () => {
    try {
        const list = await fetchWorktrees();
        setWorktrees(list);
    } catch (e) {
        console.error("Failed to load worktrees", e);
    }
  };

  const handleCreate = async () => {
    if (!newBranch || !newPath) return;
    await createWorktree(newBranch, newPath);
    setNewBranch('');
    setNewPath('');
    loadWorktrees();
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-gray-400 text-sm font-semibold mb-2">WORKTREES</h3>
        <ul className="space-y-2">
          {worktrees.map((wt) => (
            <li
                key={wt.path}
                className="p-2 bg-gray-800 rounded cursor-pointer hover:bg-gray-700"
                onClick={() => onSelect(wt.path)}
            >
              <div className="font-medium text-sm text-white">{wt.branch}</div>
              <div className="text-xs text-gray-500 truncate">{wt.path}</div>
            </li>
          ))}
        </ul>
      </div>

      <div className="pt-4 border-t border-gray-800">
        <h3 className="text-gray-400 text-sm font-semibold mb-2">NEW SESSION</h3>
        <input
          className="w-full bg-gray-800 text-white p-2 rounded mb-2 text-sm"
          placeholder="Branch Name"
          value={newBranch}
          onChange={(e) => setNewBranch(e.target.value)}
        />
        <input
          className="w-full bg-gray-800 text-white p-2 rounded mb-2 text-sm"
          placeholder="Path (e.g. .worktrees/task-1)"
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
        />
        <button
          className="w-full bg-blue-600 text-white p-2 rounded text-sm hover:bg-blue-500"
          onClick={handleCreate}
        >
          Create & Start
        </button>
      </div>
    </div>
  );
}
