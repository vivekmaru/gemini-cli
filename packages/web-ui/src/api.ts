import io from 'socket.io-client';

const API_URL = ''; // Relative path for production

export const socket = io();

export const fetchWorktrees = async () => {
  const res = await fetch(`${API_URL}/api/worktrees`);
  return res.json();
};

export const createWorktree = async (branch: string, path: string) => {
  const res = await fetch(`${API_URL}/api/worktrees`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch, path }),
  });
  return res.json();
};

export const fetchDiff = async (path: string) => {
    const res = await fetch(`${API_URL}/api/diff?path=${encodeURIComponent(path)}`);
    return res.json();
};

export const switchContext = async (path: string) => {
    const res = await fetch(`${API_URL}/api/context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
    });
    return res.json();
};
