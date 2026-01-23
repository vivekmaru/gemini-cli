/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  Config,
  debugLogger,
  promptIdContext,
  StreamJsonFormatter,
  JsonStreamEventType,
  uiTelemetryService,
  GeminiEventType,
  executeToolCall,
  recordToolCallInteractions,
  coreEvents,
  CoreEvent,
  FatalInputError,
} from '@google/gemini-cli-core';
import type {
  UserFeedbackPayload,
  ToolCallRequestInfo,
  CompletedToolCall,
} from '@google/gemini-cli-core';
import { LoadedSettings } from '../config/settings.js';
import { handleSlashCommand } from '../nonInteractiveCliCommands.js';
import { handleAtCommand } from '../ui/hooks/atCommandProcessor.js';
import { handleMaxTurnsExceededError } from '../utils/errors.js';
import { ConsolePatcher } from '../ui/utils/ConsolePatcher.js';
import { isSlashCommand } from '../ui/utils/commandUtils.js';
import stripAnsi from 'strip-ansi';
import type { Content, Part } from '@google/genai';
import open from 'open';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function startWebServer(config: Config, settings: LoadedSettings) {
  const app = express();
  // Allow port to be set via environment variable or default to 3000,
  // but if 3000 is taken, it should ideally search for an open port.
  // For now, simple implementation.
  const portEnv = process.env['PORT'];
  const port = portEnv ? parseInt(portEnv, 10) : 3000;
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  app.use(express.static(path.join(__dirname, 'public')));

  wss.on('connection', (ws: WebSocket) => {
    debugLogger.log('Web client connected');
    const streamFormatter = new StreamJsonFormatter();

    ws.on('message', async (message: string) => {
      const input = message.toString();
      debugLogger.log(`Received message: ${input}`);

      try {
        await processRequest(config, settings, input, ws, streamFormatter);
      } catch (error) {
         debugLogger.error('Error processing request:', error);
         const errorMessage = error instanceof Error ? error.message : String(error);
         ws.send(streamFormatter.formatEvent({
           type: JsonStreamEventType.RESULT, // Use RESULT for fatal errors in stream
           timestamp: new Date().toISOString(),
           status: 'error',
           error: {
             type: 'Error',
             message: errorMessage
           },
           stats: { // Dummy stats
             total_tokens: 0,
             input_tokens: 0,
             output_tokens: 0,
             cached: 0,
             input: 0,
             duration_ms: 0,
             tool_calls: 0
           }
         }));
      }
    });
  });

  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    const listeningPort = typeof address === 'string' ? address : address?.port;
    const url = `http://localhost:${listeningPort}`;
    console.log(`Gemini CLI Web Server running at ${url}`);

    // Spawn a web version as requested
    open(url).catch(err => {
        debugLogger.error("Failed to open browser:", err);
    });
  });
}

async function processRequest(
  config: Config,
  settings: LoadedSettings,
  input: string,
  ws: WebSocket,
  streamFormatter: StreamJsonFormatter
) {
    const prompt_id = Math.random().toString(36).substring(7);

    await promptIdContext.run(prompt_id, async () => {
        const consolePatcher = new ConsolePatcher({
            stderr: true,
            debugMode: config.getDebugMode(),
            onNewMessage: (_msg) => {
                // We could forward logs to the client if we wanted a debug console there
            },
        });
        consolePatcher.patch();

        const abortController = new AbortController();
        const startTime = Date.now();

        const handleUserFeedback = (payload: UserFeedbackPayload) => {
             // Map severity 'info' to 'warning' or handle differently if 'info' is not supported
             const severity = payload.severity === 'info' ? 'warning' : payload.severity;
             ws.send(streamFormatter.formatEvent({
                type: JsonStreamEventType.ERROR,
                timestamp: new Date().toISOString(),
                severity: severity,
                message: payload.message
             }));
        };
        coreEvents.on(CoreEvent.UserFeedback, handleUserFeedback);

        try {
            const geminiClient = config.getGeminiClient();

             // Emit init event
            ws.send(streamFormatter.formatEvent({
                type: JsonStreamEventType.INIT,
                timestamp: new Date().toISOString(),
                session_id: config.getSessionId(),
                model: config.getModel(),
            }));

            // Emit user message event
            ws.send(streamFormatter.formatEvent({
                type: JsonStreamEventType.MESSAGE,
                timestamp: new Date().toISOString(),
                role: 'user',
                content: input,
            }));

            let query: Part[] | undefined;

             if (isSlashCommand(input)) {
                const slashCommandResult = await handleSlashCommand(
                  input,
                  abortController,
                  config,
                  settings,
                );
                if (slashCommandResult) {
                  query = slashCommandResult as Part[];
                }
              }

              if (!query) {
                const { processedQuery, error } = await handleAtCommand({
                  query: input,
                  config,
                  addItem: (_item, _timestamp) => 0,
                  onDebugMessage: () => {},
                  messageId: Date.now(),
                  signal: abortController.signal,
                });

                if (error || !processedQuery) {
                  throw new FatalInputError(
                    error || 'Exiting due to an error processing the @ command.',
                  );
                }
                query = processedQuery as Part[];
              }

            let currentMessages: Content[] = [{ role: 'user', parts: query }];
            let turnCount = 0;

             while (true) {
                turnCount++;
                if (
                  config.getMaxSessionTurns() >= 0 &&
                  turnCount > config.getMaxSessionTurns()
                ) {
                  handleMaxTurnsExceededError(config);
                  break;
                }

                const toolCallRequests: ToolCallRequestInfo[] = [];
                const responseStream = geminiClient.sendMessageStream(
                  currentMessages[0]?.parts || [],
                  abortController.signal,
                  prompt_id,
                );

                for await (const event of responseStream) {
                    if (event.type === GeminiEventType.Content) {
                         const output = stripAnsi(event.value);
                         ws.send(streamFormatter.formatEvent({
                            type: JsonStreamEventType.MESSAGE,
                            timestamp: new Date().toISOString(),
                            role: 'assistant',
                            content: output,
                            delta: true,
                         }));
                    } else if (event.type === GeminiEventType.ToolCallRequest) {
                         ws.send(streamFormatter.formatEvent({
                            type: JsonStreamEventType.TOOL_USE,
                            timestamp: new Date().toISOString(),
                            tool_name: event.value.name,
                            tool_id: event.value.callId,
                            parameters: event.value.args,
                         }));
                        toolCallRequests.push(event.value);
                    }
                    else if (event.type === GeminiEventType.Error) {
                        ws.send(streamFormatter.formatEvent({
                            type: JsonStreamEventType.ERROR,
                            timestamp: new Date().toISOString(),
                            severity: 'error',
                            message: event.value.error.message
                        }));
                    }
                }

                if (toolCallRequests.length > 0) {
                     const toolResponseParts: Part[] = [];
                     const completedToolCalls: CompletedToolCall[] = [];

                     for (const requestInfo of toolCallRequests) {
                        const completedToolCall = await executeToolCall(
                          config,
                          requestInfo,
                          abortController.signal,
                        );
                        const toolResponse = completedToolCall.response;
                        completedToolCalls.push(completedToolCall);

                        ws.send(streamFormatter.formatEvent({
                            type: JsonStreamEventType.TOOL_RESULT,
                            timestamp: new Date().toISOString(),
                            tool_id: requestInfo.callId,
                            status: toolResponse.error ? 'error' : 'success',
                            output: typeof toolResponse.resultDisplay === 'string' ? toolResponse.resultDisplay : undefined,
                            error: toolResponse.error ? {
                                type: toolResponse.errorType || 'TOOL_EXECUTION_ERROR',
                                message: toolResponse.error.message
                            } : undefined
                        }));

                        if (toolResponse.responseParts) {
                             toolResponseParts.push(...toolResponse.responseParts);
                        }
                     }

                    // Record interactions
                     try {
                        const currentModel = geminiClient.getCurrentSequenceModel() ?? config.getModel();
                        geminiClient.getChat().recordCompletedToolCalls(currentModel, completedToolCalls);
                        await recordToolCallInteractions(config, completedToolCalls);
                     } catch (e) {
                         debugLogger.error('Error recording tool calls', e);
                     }

                    currentMessages = [{ role: 'user', parts: toolResponseParts }];

                } else {
                    // Turn complete
                    const metrics = uiTelemetryService.getMetrics();
                    const durationMs = Date.now() - startTime;
                    ws.send(streamFormatter.formatEvent({
                        type: JsonStreamEventType.RESULT,
                        timestamp: new Date().toISOString(),
                        status: 'success',
                        stats: streamFormatter.convertToStreamStats(metrics, durationMs)
                    }));
                    break;
                }
             }

        } finally {
            consolePatcher.cleanup();
            coreEvents.off(CoreEvent.UserFeedback, handleUserFeedback);
        }
    });
}
