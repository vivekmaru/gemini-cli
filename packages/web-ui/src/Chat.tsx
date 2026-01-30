import React, { useEffect, useState, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import { socket } from './api';

export function Chat() {
  const [messages, setMessages] = useState<{ role: string; content: string }[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    socket.on('messageChunk', (chunk) => {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === 'assistant' && isStreaming) {
            return [...prev.slice(0, -1), { ...last, content: last.content + chunk }];
        }
        return [...prev, { role: 'assistant', content: chunk }];
      });
      setIsStreaming(true);
    });

    socket.on('messageDone', () => {
      setIsStreaming(false);
    });

    return () => {
      socket.off('messageChunk');
      socket.off('messageDone');
    };
  }, [isStreaming]);

  const sendMessage = () => {
    if (!input.trim()) return;
    setMessages((prev) => [...prev, { role: 'user', content: input }]);
    socket.emit('sendMessage', input);
    setInput('');
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(scrollToBottom, [messages]);

  return (
    <div className="flex flex-col h-full bg-gray-900">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`p-3 rounded-lg max-w-[80%] ${
              msg.role === 'user'
                ? 'bg-blue-600 ml-auto text-white'
                : 'bg-gray-800 text-gray-200'
            }`}
          >
            {msg.role === 'user' ? (
                <div className="whitespace-pre-wrap font-sans">{msg.content}</div>
            ) : (
                <div className="prose prose-invert max-w-none">
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                </div>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <div className="p-4 bg-gray-900 border-t border-gray-800">
        <div className="flex gap-2">
          <textarea
            className="flex-1 bg-gray-800 text-white p-3 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
                if(e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                }
            }}
            placeholder="Ask Gemini..."
          />
          <button
            className="bg-blue-600 text-white p-3 rounded-lg hover:bg-blue-500"
            onClick={sendMessage}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
