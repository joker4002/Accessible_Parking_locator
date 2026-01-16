const BASE_URL = '/api/ai';

export type BackboardAssistant = {
  assistant_id: string;
};

export type BackboardThread = {
  thread_id: string;
};

export type BackboardMessageResponse = {
  thread_id?: string;
  message_id?: string;
  role?: string;
  content?: string;
  message?: string;
  status?: string;
  run_id?: string;
};

export class BackboardHttpError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'BackboardHttpError';
    this.status = status;
    this.body = body;
  }
}

async function parseErrorBody(res: Response): Promise<unknown> {
  const ct = res.headers.get('content-type') ?? '';
  try {
    if (ct.includes('application/json')) return await res.json();
  } catch {
    // ignore
  }
  try {
    const t = await res.text();
    return t;
  } catch {
    return null;
  }
}

function extractErrorMessage(body: unknown): string | null {
  if (!body) return null;
  if (typeof body === 'string') return body;
  if (typeof body !== 'object') return null;

  const anyBody = body as Record<string, unknown>;
  const err = anyBody.error;
  if (err && typeof err === 'object') {
    const msg = (err as Record<string, unknown>).message;
    if (typeof msg === 'string' && msg.trim()) return msg;
  }
  const detail = anyBody.detail;
  if (typeof detail === 'string' && detail.trim()) return detail;
  const message = anyBody.message;
  if (typeof message === 'string' && message.trim()) return message;

  return null;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await parseErrorBody(res);
    const msg = extractErrorMessage(body);
    throw new BackboardHttpError(msg ? msg : `Request failed (${res.status})`, res.status, body);
  }
  return (await res.json()) as T;
}

export async function backboardSendMessage(args: {
  thread_id: string;
  content: string;
  memory?: 'Auto' | 'off' | 'Readonly';
  llm_provider?: string;
  model_name?: string;
  web_search?: 'Auto' | 'off';
  send_to_llm?: boolean;
}): Promise<BackboardMessageResponse> {
  return await fetchJson<BackboardMessageResponse>('/api/ai/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(args)
  });
}

const LS_ASSISTANT_ID = 'kingstonaccess_backboard_assistant_id';
const LS_THREAD_ID = 'kingstonaccess_backboard_thread_id';

export async function backboardGetOrCreateThread(): Promise<{ assistant_id: string; thread_id: string }> {
  const existingAssistantId = localStorage.getItem(LS_ASSISTANT_ID);
  const existingThreadId = localStorage.getItem(LS_THREAD_ID);
  if (existingAssistantId && existingThreadId) return { assistant_id: existingAssistantId, thread_id: existingThreadId };

  const created = await fetchJson<{ assistant_id: string; thread_id: string }>('/api/ai/thread', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({})
  });

  localStorage.setItem(LS_ASSISTANT_ID, created.assistant_id);
  localStorage.setItem(LS_THREAD_ID, created.thread_id);

  return { assistant_id: created.assistant_id, thread_id: created.thread_id };
}

export async function backboardResetThread(): Promise<void> {
  localStorage.removeItem(LS_ASSISTANT_ID);
  localStorage.removeItem(LS_THREAD_ID);
  // Also reset the server-side cached thread
  try {
    await fetch('/api/ai/reset-thread', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
  } catch {
    // Ignore errors - server reset is best-effort
  }
}
