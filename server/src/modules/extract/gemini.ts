import { config } from '../../config/env';
import { ExternalServiceError } from '../../lib/errors';
import { createLogger } from '../../lib/logger';

const log = createLogger('gemini');

export interface GeminiCandidate {
  title?: string;
  event_type?: string;
  due_date?: string;
  due_time?: string;
  timezone?: string;
  confidence?: number;
  needs_clarification?: boolean;
}

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';

function buildPrompt(todayIsoDate: string, userTimezone: string, text: string): string {
  return [
    'You are a deadline extraction engine. Extract every deadline or scheduled commitment mentioned in the input.',
    'Return ONLY a JSON array. Each element must have exactly these fields:',
    '{"title": string, "event_type": "exam"|"submission"|"hackathon"|"other", "due_date": "YYYY-MM-DD", "due_time": "HH:MM", "timezone": IANA zone, "confidence": number between 0 and 1, "needs_clarification": boolean}',
    `Today is ${todayIsoDate}. If the year is not stated, choose the next occurrence.`,
    `If no time is stated, use 23:59 and set needs_clarification true. Use "${userTimezone}" as the default timezone unless another is clearly implied.`,
    'If nothing is found return [].',
    '',
    'Input:',
    text.slice(0, 12000)
  ].join('\n');
}

function stripFences(raw: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(raw.trim());
  return fenced ? fenced[1] : raw.trim();
}

export function geminiConfigured(): boolean {
  return Boolean(config.geminiApiKey);
}

export async function extractWithGemini(
  options: { text: string; timezone: string; imageBase64?: string; imageMime?: string }
): Promise<GeminiCandidate[]> {
  const key = config.geminiApiKey;
  if (!key) throw new ExternalServiceError('Gemini', 'GEMINI_API_KEY is not configured');

  const today = new Date().toISOString().slice(0, 10);
  const promptText = buildPrompt(today, options.timezone, options.text ?? '');

  const parts: Array<Record<string, unknown>> = [{ text: promptText }];
  if (options.imageBase64 && options.imageMime) {
    parts.push({ inline_data: { mime_type: options.imageMime, data: options.imageBase64 } });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  let response: Response;
  try {
    response = await fetch(`${API_ROOT}/${config.geminiModel}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 4096, responseMimeType: 'application/json' }
      }),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timeout);
    throw new ExternalServiceError('Gemini', (err as Error).message);
  }
  clearTimeout(timeout);

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    log.warn(`Gemini HTTP ${response.status}`, detail.slice(0, 400));
    throw new ExternalServiceError('Gemini', `Gemini request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const raw = payload.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  if (!raw.trim()) return [];

  try {
    const parsed = JSON.parse(stripFences(raw)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is GeminiCandidate => typeof item === 'object' && item !== null);
  } catch {
    log.warn('Gemini returned non-JSON content');
    throw new ExternalServiceError('Gemini', 'Unparseable response');
  }
}
