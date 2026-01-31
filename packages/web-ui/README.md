# Gemini Web UI

A web-based interface for Gemini CLI inspired by 1Code, featuring visual diffs, worktree isolation, and a rich chat experience.

## Features

- **Visual Diff View**: See changes in real-time as the agent modifies files.
- **Git Worktree Isolation**: Create and switch between isolated worktrees to work on multiple tasks in parallel without affecting your main branch.
- **Rich Chat Interface**: Markdown-supported chat with Gemini.

## Usage

To start the Web UI, run the following command from the `packages/web-ui` directory:

```bash
npm run gemini-web
```

Or if installed globally (future):

```bash
gemini-web
```

The interface will open in your default browser at `http://localhost:3000`.

## Architecture

The Web UI consists of:
- **Backend**: An Express.js server with Socket.io for real-time communication, handling Git operations and Gemini agent execution.
- **Frontend**: A React application built with Vite and Tailwind CSS.
