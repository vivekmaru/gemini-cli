import React, { useState } from 'react';
import { Sidebar } from './Sidebar';
import { WorktreeList } from './WorktreeList';
import { Chat } from './Chat';
import { DiffView } from './DiffView';
import { switchContext } from './api';

function App() {
  const [selectedWorktree, setSelectedWorktree] = useState<string | null>(null);

  const handleSelectWorktree = async (path: string) => {
      setSelectedWorktree(path);
      try {
          await switchContext(path);
      } catch (e) {
          console.error("Failed to switch context", e);
      }
  };

  return (
    <div className="flex h-screen w-screen bg-black text-white overflow-hidden">
      <Sidebar>
        <WorktreeList onSelect={handleSelectWorktree} />
      </Sidebar>
      <div className="flex-1 flex">
        <div className="flex-1 border-r border-gray-800">
             <Chat />
        </div>
        {selectedWorktree && (
             <div className="w-1/3">
                 <DiffView worktreePath={selectedWorktree} />
             </div>
        )}
      </div>
    </div>
  );
}

export default App;
