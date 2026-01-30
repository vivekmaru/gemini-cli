import { simpleGit, SimpleGit } from 'simple-git';
import path from 'path';

export interface Worktree {
  path: string;
  head: string;
  branch: string;
}

export class WorktreeManager {
  private git: SimpleGit;
  private rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
    this.git = simpleGit(rootPath);
  }

  async listWorktrees(): Promise<Worktree[]> {
    const raw = await this.git.raw(['worktree', 'list', '--porcelain']);
    const worktrees: Worktree[] = [];
    let current: Partial<Worktree> = {};

    const lines = raw.split('\n');
    for (const line of lines) {
      if (!line) {
        if (current.path && current.head && current.branch) {
          worktrees.push(current as Worktree);
        }
        current = {};
        continue;
      }

      const [key, ...values] = line.split(' ');
      const value = values.join(' ');

      if (key === 'worktree') {
        current.path = value;
      } else if (key === 'HEAD') {
        current.head = value;
      } else if (key === 'branch') {
        current.branch = value.replace('refs/heads/', '');
      }
    }
    // Push the last one if exists
    if (current.path && current.head && current.branch) {
      worktrees.push(current as Worktree);
    }

    return worktrees;
  }

  async createWorktree(branchName: string, relativePath: string): Promise<Worktree> {
    const fullPath = path.resolve(this.rootPath, relativePath);
    if (!fullPath.startsWith(this.rootPath)) {
        throw new Error("Invalid path: traversal not allowed");
    }

    // Check if branch exists
    const branches = await this.git.branchLocal();
    const branchExists = branches.all.includes(branchName);

    if (branchExists) {
        await this.git.raw(['worktree', 'add', fullPath, branchName]);
    } else {
        await this.git.raw(['worktree', 'add', '-b', branchName, fullPath]);
    }

    return {
        path: fullPath,
        head: 'unknown', // Would need to fetch
        branch: branchName
    };
  }

  async removeWorktree(relativePath: string): Promise<void> {
     const fullPath = path.resolve(this.rootPath, relativePath);
     if (!fullPath.startsWith(this.rootPath)) {
        throw new Error("Invalid path: traversal not allowed");
     }
     await this.git.raw(['worktree', 'remove', fullPath]);
  }

  async getDiff(worktreePath: string): Promise<string> {
      const worktreeGit = simpleGit(worktreePath);
      return worktreeGit.diff();
  }

  async getStatus(worktreePath: string) {
      const worktreeGit = simpleGit(worktreePath);
      return worktreeGit.status();
  }
}
