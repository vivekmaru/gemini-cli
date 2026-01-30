/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { contextCommand } from './contextCommand.js';
import type { Config } from '@google/gemini-cli-core';
import type { CommandContext } from './types.js';
import { MessageType } from '../types.js';
import * as fs from 'node:fs';

vi.mock('node:fs');

describe('contextCommand', () => {
  let mockContext: CommandContext;
  let mockConfig: Config;

  const addCommand = contextCommand.subCommands?.find((c) => c.name === 'add');
  const removeCommand = contextCommand.subCommands?.find(
    (c) => c.name === 'remove',
  );
  const listCommand = contextCommand.subCommands?.find(
    (c) => c.name === 'list',
  );
  const clearCommand = contextCommand.subCommands?.find(
    (c) => c.name === 'clear',
  );

  beforeEach(() => {
    mockConfig = {
      addPinnedFile: vi.fn(),
      removePinnedFile: vi.fn(),
      getPinnedFiles: vi.fn().mockReturnValue([]),
      clearPinnedFiles: vi.fn(),
    } as unknown as Config;

    mockContext = {
      services: {
        config: mockConfig,
      },
      ui: {
        addItem: vi.fn(),
      },
    } as unknown as CommandContext;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('add', () => {
    it('should show error if config is missing', async () => {
      const ctx = {
        ...mockContext,
        services: { config: null },
      } as unknown as CommandContext;
      if (!addCommand?.action) throw new Error('No action');
      await addCommand.action(ctx, 'file.ts');
      expect(ctx.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({ type: MessageType.ERROR }),
      );
    });

    it('should show error if path is missing', async () => {
      if (!addCommand?.action) throw new Error('No action');
      await addCommand.action(mockContext, '');
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: 'Please specify a file path.',
        }),
      );
    });

    it('should show error if file does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      if (!addCommand?.action) throw new Error('No action');
      await addCommand.action(mockContext, 'missing.ts');
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: expect.stringContaining('File not found'),
        }),
      );
    });

    it('should add file if it exists', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true } as any);
      if (!addCommand?.action) throw new Error('No action');
      await addCommand.action(mockContext, 'exists.ts');
      expect(mockConfig.addPinnedFile).toHaveBeenCalled();
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({ type: MessageType.INFO }),
      );
    });
  });

  describe('list', () => {
    it('should list files', async () => {
      vi.mocked(mockConfig.getPinnedFiles).mockReturnValue(['/path/to/a.ts']);
      if (!listCommand?.action) throw new Error('No action');
      await listCommand.action(mockContext, '');
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: expect.stringContaining('/path/to/a.ts'),
        }),
      );
    });
  });

  describe('remove', () => {
    it('should remove file', async () => {
      vi.mocked(mockConfig.getPinnedFiles).mockReturnValue(['/path/to/a.ts']);
      if (!removeCommand?.action) throw new Error('No action');
      await removeCommand.action(mockContext, '/path/to/a.ts');
      expect(mockConfig.removePinnedFile).toHaveBeenCalledWith('/path/to/a.ts');
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({ type: MessageType.INFO }),
      );
    });
  });

  describe('clear', () => {
    it('should clear files', async () => {
      if (!clearCommand?.action) throw new Error('No action');
      await clearCommand.action(mockContext, '');
      expect(mockConfig.clearPinnedFiles).toHaveBeenCalled();
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({ type: MessageType.INFO }),
      );
    });
  });
});
