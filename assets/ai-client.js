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

/** 清理粘贴的 API Key（去 BOM、零宽字符、误粘贴的 Bearer 前缀等） */
export function sanitizeApiKey(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, '')
    .replace(/^Bearer\s*/i, '')
    .replace(/[^\x21-\x7E]/g, ''); // 仅保留可打印 ASCII
}

function assertHeaderLatin1(value, label) {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 255) {
      throw new Error(
        `${label} 含有非法字符（如中文或特殊符号）。请从控制台重新复制 API Key，不要包含空格或中文。`
      );
    }
  }
}

export class AIClient {
  constructor({ provider, apiKey, model, baseUrl }) {
    this.provider = provider;
    this.apiKey = sanitizeApiKey(apiKey);
    this.model = model;
    this.baseUrl = (baseUrl || PROVIDERS[provider]?.baseUrl || '').replace(/\/$/, '').trim();
  }

  async *streamChat(messages, { maxTokens = 800, temperature = 0.85, signal } = {}) {
    if (!this.apiKey) {
      throw new Error('API Key 为空或无效，请检查后重新输入。');
    }

    const auth = `Bearer ${this.apiKey}`;
    assertHeaderLatin1(auth, 'API Key');

    let res;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: auth,
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
    } catch (err) {
      if (err instanceof TypeError && /ISO-8859-1|headers/i.test(err.message)) {
        throw new Error(
          'API Key 含有浏览器无法发送的非法字符。请从控制台重新复制 Key，确保无中文、无空格、无「Bearer」前缀。'
        );
      }
      throw err;
    }

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
