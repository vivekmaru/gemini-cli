import React, { useEffect, useState } from 'react';
import { fetchDiff } from './api';

export function DiffView({ worktreePath }: { worktreePath: string }) {
    const [diff, setDiff] = useState('');

    useEffect(() => {
        if(worktreePath) {
            fetchDiff(worktreePath).then(data => setDiff(data.diff));
        }
    }, [worktreePath]);

    return (
        <div className="h-full bg-gray-950 p-4 overflow-auto">
            <h3 className="text-gray-400 font-bold mb-4">CHANGES</h3>
            <pre className="text-sm font-mono text-green-400 whitespace-pre-wrap">
                {diff || "No changes"}
            </pre>
        </div>
    );
}
