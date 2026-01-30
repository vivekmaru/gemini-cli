/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { SlashCommand, CommandContext } from './types.js';
import { CommandKind } from './types.js';
import { MessageType } from '../types.js';
import { expandHomeDir } from '../utils/directoryUtils.js';

export const contextCommand: SlashCommand = {
  name: 'context',
  description: 'Manage pinned context files',
  kind: CommandKind.BUILT_IN,
  subCommands: [
    {
      name: 'add',
      description: 'Add a file to the pinned context',
      kind: CommandKind.BUILT_IN,
      action: async (context: CommandContext, args: string) => {
        const {
          ui: { addItem },
          services: { config },
        } = context;

        if (!config) {
          addItem({ type: MessageType.ERROR, text: 'Config not available' });
          return;
        }

        const filePath = args.trim();
        if (!filePath) {
          addItem({
            type: MessageType.ERROR,
            text: 'Please specify a file path.',
          });
          return;
        }

        const expandedPath = path.resolve(expandHomeDir(filePath));

        if (!fs.existsSync(expandedPath)) {
          addItem({
            type: MessageType.ERROR,
            text: `File not found: ${expandedPath}`,
          });
          return;
        }

        if (!fs.statSync(expandedPath).isFile()) {
          addItem({
            type: MessageType.ERROR,
            text: `Not a file: ${expandedPath}`,
          });
          return;
        }

        config.addPinnedFile(expandedPath);
        addItem({
          type: MessageType.INFO,
          text: `Pinned file: ${expandedPath}`,
        });
      },
    },
    {
      name: 'remove',
      description: 'Remove a file from the pinned context',
      kind: CommandKind.BUILT_IN,
      action: async (context: CommandContext, args: string) => {
        const {
          ui: { addItem },
          services: { config },
        } = context;

        if (!config) return;

        const filePath = args.trim();
        if (!filePath) {
          addItem({
            type: MessageType.ERROR,
            text: 'Please specify a file path.',
          });
          return;
        }

        // Try to find the file in pinned files (exact match or resolve)
        const pinnedFiles = config.getPinnedFiles();
        const targetPath = filePath;

        // simple resolution attempt
        const resolved = path.resolve(expandHomeDir(filePath));

        if (pinnedFiles.includes(targetPath)) {
          config.removePinnedFile(targetPath);
          addItem({
            type: MessageType.INFO,
            text: `Removed pinned file: ${targetPath}`,
          });
        } else if (pinnedFiles.includes(resolved)) {
          config.removePinnedFile(resolved);
          addItem({
            type: MessageType.INFO,
            text: `Removed pinned file: ${resolved}`,
          });
        } else {
          addItem({
            type: MessageType.ERROR,
            text: `File not found in pinned context: ${filePath}`,
          });
        }
      },
    },
    {
      name: 'list',
      description: 'List pinned files',
      kind: CommandKind.BUILT_IN,
      action: async (context: CommandContext) => {
        const {
          ui: { addItem },
          services: { config },
        } = context;
        if (!config) return;

        const files = config.getPinnedFiles();
        if (files.length === 0) {
          addItem({ type: MessageType.INFO, text: 'No pinned files.' });
        } else {
          addItem({
            type: MessageType.INFO,
            text: `Pinned files:\n${files.map((f) => `- ${f}`).join('\n')}`,
          });
        }
      },
    },
    {
      name: 'clear',
      description: 'Clear all pinned files',
      kind: CommandKind.BUILT_IN,
      action: async (context: CommandContext) => {
        const {
          ui: { addItem },
          services: { config },
        } = context;
        if (!config) return;
        config.clearPinnedFiles();
        addItem({ type: MessageType.INFO, text: 'Cleared all pinned files.' });
      },
    },
  ],
};
