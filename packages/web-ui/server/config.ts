/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as dotenv from 'dotenv';

import type { TelemetryTarget } from '@google/gemini-cli-core';
import {
  AuthType,
  Config,
  type ConfigParameters,
  FileDiscoveryService,
  ApprovalMode,
  loadServerHierarchicalMemory,
  GEMINI_DIR,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  DEFAULT_GEMINI_MODEL,
  type ExtensionLoader,
  startupProfiler,
  PREVIEW_GEMINI_MODEL,
  homedir,
  GitService,
  debugLogger,
} from '@google/gemini-cli-core';

import type { Settings } from './settings.js';

export async function loadConfig(
  settings: Settings,
  extensionLoader: ExtensionLoader,
  sessionId: string,
): Promise<Config> {
  const workspaceDir = process.cwd();
  const adcFilePath = process.env['GOOGLE_APPLICATION_CREDENTIALS'];

  const folderTrust =
    settings.folderTrust === true ||
    process.env['GEMINI_FOLDER_TRUST'] === 'true';

  let checkpointing = process.env['CHECKPOINTING']
    ? process.env['CHECKPOINTING'] === 'true'
    : (settings.checkpointing?.enabled ?? false);

  if (checkpointing) {
    if (!(await GitService.verifyGitAvailability())) {
      debugLogger.warn(
        '[Config] Checkpointing is enabled but git is not installed. Disabling checkpointing.',
      );
      checkpointing = false;
    }
  }

  const configParams: ConfigParameters = {
    sessionId: sessionId,
    model: settings.general?.previewFeatures
      ? PREVIEW_GEMINI_MODEL
      : DEFAULT_GEMINI_MODEL,
    embeddingModel: DEFAULT_GEMINI_EMBEDDING_MODEL,
    sandbox: undefined,
    targetDir: workspaceDir,
    debugMode: process.env['DEBUG'] === 'true' || false,
    question: '',

    coreTools: settings.coreTools || undefined,
    excludeTools: settings.excludeTools || undefined,
    showMemoryUsage: settings.showMemoryUsage || false,
    approvalMode:
      process.env['GEMINI_YOLO_MODE'] === 'true'
        ? ApprovalMode.YOLO
        : ApprovalMode.DEFAULT,
    mcpServers: settings.mcpServers,
    cwd: workspaceDir,
    telemetry: {
      enabled: settings.telemetry?.enabled,
      target: settings.telemetry?.target as TelemetryTarget,
      otlpEndpoint:
        process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ??
        settings.telemetry?.otlpEndpoint,
      logPrompts: settings.telemetry?.logPrompts,
    },
    fileFiltering: {
      respectGitIgnore: settings.fileFiltering?.respectGitIgnore,
      enableRecursiveFileSearch:
        settings.fileFiltering?.enableRecursiveFileSearch,
    },
    ideMode: false,
    folderTrust,
    trustedFolder: true,
    extensionLoader,
    checkpointing,
    previewFeatures: settings.general?.previewFeatures,
    interactive: true,
    enableInteractiveShell: true,
  };

  const fileService = new FileDiscoveryService(workspaceDir);
  const { memoryContent, fileCount, filePaths } =
    await loadServerHierarchicalMemory(
      workspaceDir,
      [workspaceDir],
      false,
      fileService,
      extensionLoader,
      folderTrust,
    );
  configParams.userMemory = memoryContent;
  configParams.geminiMdFileCount = fileCount;
  configParams.geminiMdFilePaths = filePaths;
  const config = new Config({
    ...configParams,
  });

  await config.initialize();
  startupProfiler.flush(config);

  if (process.env['USE_CCPA']) {
    debugLogger.log('[Config] Using CCPA Auth:');
    try {
      if (adcFilePath) {
        path.resolve(adcFilePath);
      }
    } catch (e) {
      debugLogger.error(
        `[Config] USE_CCPA env var is true but unable to resolve GOOGLE_APPLICATION_CREDENTIALS file path ${adcFilePath}. Error ${e}`,
      );
    }
    await config.refreshAuth(AuthType.LOGIN_WITH_GOOGLE);
  } else if (process.env['GEMINI_API_KEY']) {
    debugLogger.log('[Config] Using Gemini API Key');
    await config.refreshAuth(AuthType.USE_GEMINI);
  } else {
      // Try to rely on default auth if configured in settings or existing env vars
      // For now, if no auth, we might fail later.
      // debugLogger.warn('No authentication method found in environment.');
  }

  return config;
}

export function loadEnvironment(): void {
  const envFilePath = findEnvFile(process.cwd());
  if (envFilePath) {
    dotenv.config({ path: envFilePath, override: true });
  }
}

function findEnvFile(startDir: string): string | null {
  let currentDir = path.resolve(startDir);
  while (true) {
    const geminiEnvPath = path.join(currentDir, GEMINI_DIR, '.env');
    if (fs.existsSync(geminiEnvPath)) {
      return geminiEnvPath;
    }
    const envPath = path.join(currentDir, '.env');
    if (fs.existsSync(envPath)) {
      return envPath;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir || !parentDir) {
      const homeGeminiEnvPath = path.join(process.cwd(), GEMINI_DIR, '.env');
      if (fs.existsSync(homeGeminiEnvPath)) {
        return homeGeminiEnvPath;
      }
      const homeEnvPath = path.join(homedir(), '.env');
      if (fs.existsSync(homeEnvPath)) {
        return homeEnvPath;
      }
      return null;
    }
    currentDir = parentDir;
  }
}
