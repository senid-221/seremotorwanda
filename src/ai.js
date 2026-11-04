/* SERE Moto — the booking conversation, held by a real language model.

   Nothing here is simulated: a question is only ever asked by the model the server is configured to
   call, over its own HTTPS API, with the key held on the server and never sent to the browser. When no
   key is configured the module says so with 503 ai_not_configured instead of inventing an answer, and
   when the provider refuses it passes the provider's own reason through as 502 ai_unavailable — the
   booking page then keeps asking the scripted questions it already knows how to ask.

   The model is given the facts and asked only for wording. Counts, prices, places and codes are
   computed by this server (see routes/assistant.js) and the model is shown them as data it must not
   contradict; the choices a passenger can tap are read from the division register, never from the
   model's reply, so a confident invention cannot become a bookable place. */
import { config, aiConfigured } from './config.js';
import { ApiError } from './validate.js';

async function chat({ messages, temperature = 0.4, maxTokens = 120 }) {
  if (!aiConfigured()) {
    throw new ApiError(503, 'ai_not_configured', 'Set AI_API_KEY to let SERE Moto ask and answer with a real model.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ai.timeoutMs);
  let response;
  try {
    response = await fetch(`${config.ai.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${config.ai.apiKey}`,
      },
      body: JSON.stringify({
        model: config.ai.model,
        temperature,
        max_tokens: maxTokens,
        messages,
      }),
    });
  } catch (error) {
    const why = error.name === 'AbortError' ? `took longer than ${config.ai.timeoutMs} ms` : error.message;
    throw new ApiError(502, 'ai_unavailable', `The language model could not be reached (${why}).`);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text().catch(() => '');
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const reason = body?.error?.message || body?.message || String(text || '').trim().slice(0, 160);
    throw new ApiError(502, 'ai_unavailable', `The language model refused the request with HTTP ${response.status}${reason ? `: ${reason}` : ''}`);
  }
  if (body === null) {
    throw new ApiError(502, 'ai_unavailable', 'The language model replied with something that is not JSON.');
  }
  const message = body.choices?.[0]?.message;
  const content = String(message?.content ?? '').trim();
  if (!content) {
    throw new ApiError(502, 'ai_unavailable', 'The language model answered with an empty message.');
  }
  return content;
}

/* Replies are asked for as JSON so one call can carry both the question and the answer line.
   A model that wraps its JSON in prose is read anyway; a model that answers with prose only is not. */
export async function phraseJson({ system, user }) {
  const content = await chat({
    messages: [
      { role: 'system', content: `${system}\n\nAnswer with a single JSON object and nothing else.` },
      { role: 'user', content: user },
    ],
    temperature: 0.5,
    maxTokens: 300,
  });
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new ApiError(502, 'ai_unavailable', 'The language model did not answer in the shape the booking page needs.');
  }
  let parsed;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    throw new ApiError(502, 'ai_unavailable', 'The language model sent JSON the server could not read.');
  }
  return parsed && typeof parsed === 'object' ? parsed : {};
}
