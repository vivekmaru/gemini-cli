import {
  Config,
  sessionId,
  SimpleExtensionLoader,
} from '@google/gemini-cli-core';
import { EventEmitter } from 'events';
import { loadConfig, loadEnvironment } from './config.js';
import { loadSettings } from './settings.js';
import { GenerateContentParameters } from '@google/genai';
import { v4 as uuidv4 } from 'uuid';

export class GeminiService extends EventEmitter {
  private config: Config | null = null;
  private projectRoot: string;

  constructor(projectRoot: string) {
    super();
    this.projectRoot = projectRoot;
  }

  async initialize(targetDir?: string) {
    loadEnvironment();
    const dir = targetDir || this.projectRoot;
    const settings = loadSettings(dir);
    const extensionLoader = new SimpleExtensionLoader([]);

    // We use the same sessionId for now, but in reality we should manage sessions per context
    this.config = await loadConfig(settings, extensionLoader, sessionId);

    // Config initialization is already done in loadConfig
  }

  async switchContext(targetDir: string) {
      await this.initialize(targetDir);
  }

  async sendMessage(message: string, onChunk: (chunk: string) => void) {
      if (!this.config) await this.initialize();

      const generator = this.config!.getContentGenerator();
      if (!generator) {
          throw new Error("Content Generator not initialized");
      }

      const request: GenerateContentParameters = {
          model: this.config!.getModel(),
          contents: [{ role: 'user', parts: [{ text: message }] }],
      };

      const userPromptId = uuidv4();
      const response = await generator.generateContent(request, userPromptId);

      // If it's just text
      onChunk(response.text || "");
  }
}
