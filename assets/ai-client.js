/**
 * AI Client — DashScope (百炼) & OpenAI compatible streaming chat
 */
export const PROVIDERS = {
  bailian: {
    id: 'bailian',
    name: '阿里云百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      { id: 'qwen-plus', name: 'Qwen Plus' },
      { id: 'qwen-max', name: 'Qwen Max' },
      { id: 'qwen-turbo', name: 'Qwen Turbo' },
      { id: 'qwen3.5-plus', name: 'Qwen 3.5 Plus' },
    ],
    keyPlaceholder: 'sk-... (DashScope API Key)',
    keyLink: 'https://bailian.console.aliyun.com/?tab=api#/api-key',
  },
  openai: {
    id: 'openai',
    name: 'OpenAI GPT',
    baseUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
    ],
    keyPlaceholder: 'sk-... (OpenAI API Key)',
    keyLink: 'https://platform.openai.com/api-keys',
  },
};

export class AIClient {
  constructor({ provider, apiKey, model, baseUrl }) {
    this.provider = provider;
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = (baseUrl || PROVIDERS[provider]?.baseUrl || '').replace(/\/$/, '');
  }

  async *streamChat(messages, { maxTokens = 800, temperature = 0.85, signal } = {}) {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: true,
      }),
      signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      let msg = `API 请求失败 (${res.status})`;
      try {
        const j = JSON.parse(errText);
        msg = j.error?.message || j.message || msg;
      } catch {
        if (errText) msg += `: ${errText.slice(0, 200)}`;
      }
      if (res.status === 0 || msg.includes('Failed to fetch')) {
        throw new Error(
          '网络或 CORS 错误。百炼通常可直接调用；OpenAI 可能需要配置代理 Base URL。'
        );
      }
      throw new Error(msg);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          /* skip malformed chunks */
        }
      }
    }
  }

  async chat(messages, opts = {}) {
    let text = '';
    for await (const chunk of this.streamChat(messages, opts)) {
      text += chunk;
    }
    return text;
  }
}
