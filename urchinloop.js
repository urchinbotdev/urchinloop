/**
 * UrchinLoop — Full Portable Implementation
 *
 * An agentic reasoning engine: think-act-observe loop with persistent memory,
 * tool execution, and chain-of-thought. Platform-agnostic: use with OpenAI,
 * Anthropic, or any LLM; store in memory, localStorage, Redis, etc.
 *
 * @see README.md for architecture and usage
 * @license MIT
 */

/* ─────────────────────────────────────────────────────────────────────────
 * CONSTANTS & REGEX
 * ───────────────────────────────────────────────────────────────────────── */

const TOOL_REGEX = /<<TOOL:(\w+)(?::([\s\S]+?))?>>/g;
const TOOL_REGEX_SINGLE = /<<TOOL:(\w+)(?::([\s\S]+?))?>>/;
const THINK_REGEX = /<<THINK>>([\s\S]+?)<<\/THINK>>/;
const MAX_CONTEXT_CHARS = 80000;
const MAX_HISTORY = 30;
const MAX_CHAT_HISTORY = 200;
const MAX_CONDENSED_CHARS = 4000;
const MAX_SESSION_SUMMARIES = 20;
const MAX_SESSION_CHARS = 1500;

/* ─────────────────────────────────────────────────────────────────────────
 * IN-MEMORY STORAGE (default — replace with your backend)
 * ───────────────────────────────────────────────────────────────────────── */

function createMemoryStorage() {
  const store = {};
  return {
    async get(keys) {
      if (Array.isArray(keys)) {
        return keys.reduce((acc, k) => ({ ...acc, [k]: store[k] }), {});
      }
      return { [keys]: store[keys] };
    },
    async set(data) {
      Object.assign(store, data);
    },
  };
}

/* ─────────────────────────────────────────────────────────────────────────
 * CONTEXT & MESSAGE UTILITIES
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * Trim messages to stay within context window budget
 */
function trimMessagesToBudget(messages, budget = MAX_CONTEXT_CHARS) {
  let total = messages.reduce((s, m) => s + (m.content || '').length, 0);
  let i = 0;
  while (total > budget && i < messages.length - 2) {
    const old = messages[i].content.length;
    messages[i].content = messages[i].content.slice(0, 200) + '…[trimmed]';
    total -= old - messages[i].content.length;
    i++;
  }
  return messages;
}

/**
 * Summarize large tool results to avoid context overflow
 */
function summarizeToolResult(toolName, result) {
  const raw = JSON.stringify(result);
  if (raw.length <= 3000) return raw;
  if (toolName === 'FETCH_URL' && result.contentPreview) {
    return JSON.stringify({ ...result, contentPreview: (result.contentPreview || '').slice(0, 2500) + '…[truncated]' });
  }
  return raw.slice(0, 2500) + '…[truncated]';
}

/**
 * Extract JSON from LLM output (handles markdown wrapping)
 */
function extractJSON(raw) {
  let cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch (_) {}
  }
  return null;
}

/* ─────────────────────────────────────────────────────────────────────────
 * SEMANTIC MEMORY — embeddings + cosine similarity with keyword fallback
 * ───────────────────────────────────────────────────────────────────────── */

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

async function getEmbedding(text, settings) {
  const apiKey = settings.llmApiKey || settings.apiKey;
  if (!apiKey) return null;
  const baseUrl = settings.llmBaseUrl || 'https://api.openai.com/v1';
  const embUrl = baseUrl.replace(/\/chat\/completions\/?$/, '') + '/embeddings';
  try {
    const res = await fetch(embUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 2000) }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.data?.[0]?.embedding || null;
  } catch (_) {
    return null;
  }
}

function keywordFallback(query, memory) {
  const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (keywords.length === 0) return { matches: [], method: 'keyword' };
  const matches = [];
  for (const [key, value] of Object.entries(memory)) {
    if (key.startsWith('_')) continue;
    const combined = `${key} ${value}`.toLowerCase();
    const matchCount = keywords.filter(kw => combined.includes(kw)).length;
    if (matchCount > 0) {
      matches.push({ key, value: String(value).slice(0, 200), relevance: matchCount / keywords.length });
    }
  }
  matches.sort((a, b) => b.relevance - a.relevance);
  return { matches: matches.slice(0, 10), method: 'keyword' };
}

async function semanticRecallWithEmbeddings(query, memory, storage, settings) {
  const queryEmb = await getEmbedding(query, settings);
  if (!queryEmb) return keywordFallback(query, memory);

  const { urchinEmbeddingCache = {} } = await storage.get('urchinEmbeddingCache');
  const matches = [];
  let cacheUpdated = false;

  for (const [key, value] of Object.entries(memory)) {
    if (key.startsWith('_')) continue;
    const text = `${key}: ${value}`;
    let emb = urchinEmbeddingCache[key];
    if (!emb) {
      emb = await getEmbedding(text, settings);
      if (emb) { urchinEmbeddingCache[key] = emb; cacheUpdated = true; }
    }
    if (emb) {
      const sim = cosineSimilarity(queryEmb, emb);
      if (sim > 0.25) matches.push({ key, value: String(value).slice(0, 200), relevance: Math.round(sim * 100) / 100 });
    }
  }

  if (cacheUpdated) {
    const keys = Object.keys(urchinEmbeddingCache);
    if (keys.length > 300) {
      for (const k of keys.slice(0, keys.length - 300)) delete urchinEmbeddingCache[k];
    }
    await storage.set({ urchinEmbeddingCache });
  }

  matches.sort((a, b) => b.relevance - a.relevance);
  return { matches: matches.slice(0, 10), method: 'embeddings' };
}

async function relevanceFilterMemories(userInput, memories, storage, settings, maxResults = 8) {
  const queryEmb = await getEmbedding(userInput, settings);
  const { urchinEmbeddingCache = {} } = await storage.get('urchinEmbeddingCache');
  const scored = [];
  let cacheUpdated = false;

  for (const [key, value] of Object.entries(memories)) {
    if (key.startsWith('_')) continue;
    const text = `${key}: ${String(value).slice(0, 500)}`;
    if (queryEmb) {
      let emb = urchinEmbeddingCache[key];
      if (!emb) {
        emb = await getEmbedding(text, settings);
        if (emb) { urchinEmbeddingCache[key] = emb; cacheUpdated = true; }
      }
      if (emb) {
        scored.push({ key, value, sim: cosineSimilarity(queryEmb, emb) });
        continue;
      }
    }
    const kw = userInput.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const combined = text.toLowerCase();
    const mc = kw.filter(w => combined.includes(w)).length;
    scored.push({ key, value, sim: kw.length > 0 ? (mc / kw.length) * 0.5 : 0 });
  }

  if (cacheUpdated) {
    const keys = Object.keys(urchinEmbeddingCache);
    if (keys.length > 300) {
      for (const k of keys.slice(0, keys.length - 300)) delete urchinEmbeddingCache[k];
    }
    await storage.set({ urchinEmbeddingCache });
  }

  scored.sort((a, b) => b.sim - a.sim);
  return scored.filter(s => s.sim > 0.2).slice(0, maxResults);
}

/* ─────────────────────────────────────────────────────────────────────────
 * BUILT-IN TOOLS (implement only what you need; override via options.tools)
 * ───────────────────────────────────────────────────────────────────────── */

async function webSearch(query, _ctx) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url);
    const data = await res.json();
    const results = [];
    if (data.AbstractText) {
      results.push({ title: data.Heading || query, snippet: data.AbstractText, url: data.AbstractURL });
    }
    if (data.RelatedTopics) {
      for (const topic of (data.RelatedTopics || []).slice(0, 5)) {
        if (topic.Text) results.push({ snippet: topic.Text, url: topic.FirstURL || '' });
        if (topic.Topics) {
          for (const sub of topic.Topics.slice(0, 2)) {
            if (sub.Text) results.push({ snippet: sub.Text, url: sub.FirstURL || '' });
          }
        }
      }
    }
    return { success: true, results: results.slice(0, 8) };
  } catch (e) {
    return { error: e.message };
  }
}

async function fetchUrl(url, _ctx) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url.trim(), {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; UrchinLoop/1.0)' },
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { success: true, url: url.trim(), contentPreview: text.slice(0, 8000) };
  } catch (e) {
    return { error: `Fetch failed: ${e.message}` };
  }
}

function createBuiltInTools(storage) {
  return {
    WEB_SEARCH: webSearch,

    FETCH_URL: fetchUrl,

    REMEMBER: async (param) => {
      try {
        const data = extractJSON(param) || JSON.parse(param);
        const { key, value } = data;
        if (!key) return { error: 'REMEMBER needs {"key":"...","value":"..."}' };
        const { urchinMemory = {} } = await storage.get('urchinMemory');
        urchinMemory[key] = value;
        await storage.set({ urchinMemory });
        return { success: true, message: `Remembered "${key}".` };
      } catch (e) {
        return { error: `Memory save failed: ${e.message}` };
      }
    },

    RECALL: async (param) => {
      try {
        const key = param.trim();
        const { urchinMemory = {} } = await storage.get('urchinMemory');
        if (key === 'all') {
          return { success: true, memory: urchinMemory };
        }
        return { success: true, key, value: urchinMemory[key] ?? 'Nothing saved under this key.' };
      } catch (e) {
        return { error: `Memory recall failed: ${e.message}` };
      }
    },

    SEARCH_MEMORY: async (query, ctx) => {
      try {
        const { urchinMemory = {}, urchinProfile = {} } = await storage.get(['urchinMemory', 'urchinProfile']);
        const combined = {
          ...urchinMemory,
          ...Object.fromEntries(Object.entries(urchinProfile).map(([k, v]) => [`profile_${k}`, v])),
        };
        const settings = ctx?.settings || {};
        return { success: true, query, ...(await semanticRecallWithEmbeddings(query, combined, storage, settings)) };
      } catch (e) {
        return { error: `Memory search failed: ${e.message}` };
      }
    },
  };
}

/* ─────────────────────────────────────────────────────────────────────────
 * LLM CALLER (default — OpenAI-compatible; replace with your provider)
 * ───────────────────────────────────────────────────────────────────────── */

async function defaultCallLLM(systemPrompt, messages, settings = {}) {
  const apiKey = settings.llmApiKey || settings.apiKey;
  const model = settings.llmModel || settings.model || 'gpt-4o-mini';
  const baseUrl = settings.llmBaseUrl || 'https://api.openai.com/v1/chat/completions';

  if (!apiKey) throw new Error('No LLM API key configured. Set llmApiKey in settings.');

  const body = JSON.stringify({
    model,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    temperature: 0.7,
    max_tokens: 8192,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  try {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`LLM API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') throw new Error('LLM request timed out.');
    throw e;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * MEMORY LAYERS (load & inject per README)
 * ───────────────────────────────────────────────────────────────────────── */

async function loadMemoryLayers(storage, options) {
  const history = options.history || [];
  const pageContext = options.pageContext || {};
  const context = options.context || [];

  const {
    urchinCondensed = '',
    urchinMemory = {},
    urchinProfile = {},
    urchinSkills = [],
  } = await storage.get(['urchinCondensed', 'urchinMemory', 'urchinProfile', 'urchinSkills']);

  const messages = [];

  // Layer 1: Condensed history
  if (urchinCondensed && urchinCondensed.length > 0) {
    messages.push({
      role: 'user',
      content: `[Previous conversation history (condensed):\n${urchinCondensed}]`,
    });
    messages.push({ role: 'assistant', content: 'Understood — I remember our previous conversations.' });
  }

  // Layer 2: Recent messages (last 30)
  for (const h of history.slice(-MAX_HISTORY)) {
    messages.push({
      role: h.role === 'user' ? 'user' : 'assistant',
      content: h.text,
    });
  }

  // Layer 3: Current user message with context
  let userMsg = '';
  if (pageContext.url) {
    userMsg += `[Page: ${pageContext.title || ''} — ${pageContext.url}]\n`;
    if (pageContext.selection) userMsg += `[Selected text: ${pageContext.selection}]\n`;
    if (pageContext.visibleText) userMsg += `[Page content: ${String(pageContext.visibleText).slice(0, 3000)}]\n`;
  }
  if (context.length > 0) {
    userMsg += '\nCaptured context:\n' + context.map(c => `[${c.type}] ${c.value}`).join('\n') + '\n';
  }
  userMsg += '\n' + (options.userInput || '');
  messages.push({ role: 'user', content: userMsg.trim() });

  // Layer 4: User profile (capped at 50 keys)
  if (urchinProfile && Object.keys(urchinProfile).length > 0) {
    const profileEntries = Object.entries(urchinProfile).slice(-50);
    if (Object.keys(urchinProfile).length > 50) {
      await storage.set({ urchinProfile: Object.fromEntries(profileEntries) });
    }
    const profileStr = profileEntries.map(([k, v]) => `  ${k}: ${v}`).join('\n');
    messages[messages.length - 1].content += `\n\n[User profile (permanent):\n${profileStr}]`;
  }

  // Layer 5: Relevance-filtered session summaries + manual memories
  const sessionKeys = Object.keys(urchinMemory).filter(k => k.startsWith('session_')).sort().reverse();
  const manualKeys = Object.keys(urchinMemory).filter(k => !k.startsWith('session_') && !k.startsWith('_'));

  if (manualKeys.length > 100) {
    const toRemove = manualKeys.slice(0, manualKeys.length - 100);
    for (const k of toRemove) delete urchinMemory[k];
    await storage.set({ urchinMemory });
  }

  const allMemEntries = {};
  for (const k of sessionKeys.slice(0, 20)) allMemEntries[k] = urchinMemory[k];
  const currentManualKeys = Object.keys(urchinMemory).filter(k => !k.startsWith('session_') && !k.startsWith('_'));
  for (const k of currentManualKeys) allMemEntries[k] = urchinMemory[k];

  const totalEntries = Object.keys(allMemEntries).length;
  const settings = options.settings || {};

  if (totalEntries <= 6) {
    if (sessionKeys.length > 0) {
      const sessStr = sessionKeys.slice(0, 10).map(k => urchinMemory[k]).join('\n---\n');
      messages[messages.length - 1].content += `\n\n[Past session summaries:\n${sessStr}]`;
    }
    if (currentManualKeys.length > 0) {
      const manStr = currentManualKeys.map(k => `  ${k}: ${urchinMemory[k]}`).join('\n');
      messages[messages.length - 1].content += `\n\n[Saved memories:\n${manStr}]`;
    }
  } else {
    const relevant = await relevanceFilterMemories(options.userInput || '', allMemEntries, storage, settings, 10);
    const relevantSessions = relevant.filter(r => r.key.startsWith('session_'));
    const relevantManual = relevant.filter(r => !r.key.startsWith('session_'));

    const sessionSet = new Set(relevantSessions.map(r => r.key));
    if (sessionKeys[0]) sessionSet.add(sessionKeys[0]);

    if (sessionSet.size > 0) {
      const sessStr = [...sessionSet].map(k => urchinMemory[k]).filter(Boolean).join('\n---\n');
      messages[messages.length - 1].content += `\n\n[Relevant session summaries (${sessionSet.size}/${sessionKeys.length} total):\n${sessStr}]`;
    }
    if (relevantManual.length > 0) {
      const manStr = relevantManual.map(r => `  ${r.key}: ${r.value}`).join('\n');
      messages[messages.length - 1].content += `\n\n[Relevant memories (${relevantManual.length}/${currentManualKeys.length} total):\n${manStr}]`;
    } else if (currentManualKeys.length > 0 && currentManualKeys.length <= 10) {
      const manStr = currentManualKeys.map(k => `  ${k}: ${urchinMemory[k]}`).join('\n');
      messages[messages.length - 1].content += `\n\n[Saved memories:\n${manStr}]`;
    }
  }

  // Layer 6: Learned skills — filtered by score, with quality info
  const activeSkillNames = [];
  if (urchinSkills && urchinSkills.length > 0) {
    const viable = urchinSkills.filter(s => (s.score ?? 50) > 15);
    if (viable.length > 0) {
      const skillBlock = viable.map(s => {
        s.usageCount = (s.usageCount || 0) + 1;
        s.lastUsedAt = Date.now();
        activeSkillNames.push(s.name);
        return `  • ${s.name} [score:${s.score ?? 50}]: ${s.instruction}`;
      }).join('\n');
      messages[messages.length - 1].content += `\n\n[Learned skills (apply these):\n${skillBlock}]`;
      await storage.set({ urchinSkills });
    }
  }

  return { messages, activeSkillNames };
}

/* ─────────────────────────────────────────────────────────────────────────
 * POST-RESPONSE JOBS (background memory maintenance)
 * ───────────────────────────────────────────────────────────────────────── */

async function runPostResponseJobs(storage, messages, history, callLLM, settings, activeSkillNames = []) {
  const { urchinMemory = {}, urchinCondensed = '' } = await storage.get(['urchinMemory', 'urchinCondensed']);
  const convCount = parseInt(urchinMemory._convCount || '0', 10) + 1;
  urchinMemory._convCount = String(convCount);

  // A) Session summary — every 3rd conversation
  if (convCount % 3 === 0 && messages.length >= 3) {
    try {
      const summaryMessages = [
        ...messages.slice(-10),
        {
          role: 'user',
          content:
            'Summarize this conversation in 3-5 bullet points. Extract: key topics, decisions, entities mentioned. Be specific.',
        },
      ];
      const summary = await callLLM('You are a memory system. Output ONLY the bullet-point summary.', summaryMessages, settings);
      urchinMemory[`session_${Date.now()}`] = summary.slice(0, MAX_SESSION_CHARS);
      const sessionKeys = Object.keys(urchinMemory).filter(k => k.startsWith('session_')).sort();
      if (sessionKeys.length > MAX_SESSION_SUMMARIES) {
        for (const old of sessionKeys.slice(0, sessionKeys.length - MAX_SESSION_SUMMARIES)) {
          delete urchinMemory[old];
        }
      }
    } catch (_) {}
  }
  await storage.set({ urchinMemory });

  // B) Profile extraction — every 5th conversation
  if (convCount % 5 === 0 && messages.length >= 3) {
    try {
      const { urchinProfile = {} } = await storage.get('urchinProfile');
      const currentProfile = Object.entries(urchinProfile).map(([k, v]) => `${k}: ${v}`).join('\n') || '(empty)';
      const profileMessages = [
        {
          role: 'user',
          content:
            `Current profile:\n${currentProfile}\n\nRecent conversation:\n` +
            messages.slice(-6).map(m => `${m.role}: ${String(m.content).slice(0, 300)}`).join('\n') +
            '\n\nExtract NEW user info (name, preferences, projects). Return ONLY valid JSON. If nothing new, return {}.',
        },
      ];
      const profileRaw = await callLLM('Output ONLY a JSON object.', profileMessages, settings);
      const newProfile = extractJSON(profileRaw) || {};
      if (Object.keys(newProfile).length > 0) {
        await storage.set({ urchinProfile: { ...urchinProfile, ...newProfile } });
      }
    } catch (_) {}
  }

  // C) Condensation — when history exceeds 40 messages
  if (history.length > 40) {
    try {
      const oldMessages = history.slice(0, history.length - 30);
      const oldText = oldMessages.map(h => `[${h.role}] ${String(h.text).slice(0, 300)}`).join('\n');
      const condensePrompt = `Existing condensed:\n${urchinCondensed || '(none)'}\n\nNew to condense:\n${oldText}\n\nCompress into a dense narrative (max 2000 chars). Preserve key facts, entities, decisions.`;
      const condensed = await callLLM('You are a memory compressor. Output ONLY the compressed narrative.', [{ role: 'user', content: condensePrompt }], settings);
      await storage.set({ urchinCondensed: condensed.slice(0, MAX_CONDENSED_CHARS) });
    } catch (_) {
      const oldMessages = history.slice(0, history.length - 30);
      const oldText = oldMessages.map(h => `[${h.role}] ${String(h.text).slice(0, 200)}`).join('\n');
      const newCondensed = (urchinCondensed ? urchinCondensed + '\n---\n' : '') + oldText;
      await storage.set({ urchinCondensed: newCondensed.slice(-MAX_CONDENSED_CHARS) });
    }
  }

  // D) Skill self-evaluation — every 10th conversation, score and prune
  if (convCount % 10 === 0 && activeSkillNames.length > 0 && messages.length >= 4) {
    try {
      const { urchinSkills = [] } = await storage.get('urchinSkills');
      const activeForEval = urchinSkills.filter(s => activeSkillNames.includes(s.name));
      if (activeForEval.length > 0) {
        const recentConvo = messages.slice(-10).map(m => `${m.role}: ${String(m.content).slice(0, 400)}`).join('\n');
        const skillList = activeForEval.map(s =>
          `  "${s.name}": "${s.instruction}" (used ${s.usageCount || 0}x, score: ${s.score ?? 50})`
        ).join('\n');
        const evalPrompt = `Evaluate whether these learned skills helped in the recent conversation.\n\nActive skills:\n${skillList}\n\nRecent conversation:\n${recentConvo}\n\nScore each skill 0-100:\n- 80-100: clearly applied and helpful\n- 50-70: relevant but unclear impact\n- 20-49: irrelevant to user's needs\n- 0-19: actively wrong or user corrected the behavior\n\nOutput ONLY JSON: {"scores":{"skill-name": <number>}}`;
        const evalRaw = await callLLM('Output ONLY a JSON object with a "scores" field.', [{ role: 'user', content: evalPrompt }], settings);
        const evalResult = extractJSON(evalRaw);
        if (evalResult?.scores) {
          for (const [name, newScore] of Object.entries(evalResult.scores)) {
            const skill = urchinSkills.find(s => s.name === name);
            if (skill && typeof newScore === 'number') {
              const oldScore = skill.score ?? 50;
              skill.score = Math.round(oldScore * 0.6 + Math.max(0, Math.min(100, newScore)) * 0.4);
              skill.lastEvalAt = Date.now();
              skill.evalCount = (skill.evalCount || 0) + 1;
            }
          }
          const pruned = urchinSkills.filter(s => {
            if ((s.score ?? 50) <= 10 && (s.evalCount || 0) >= 2) return false;
            if ((s.usageCount || 0) > 30 && (s.score ?? 50) <= 20) return false;
            const age = Date.now() - (s.learnedAt || 0);
            if (age > 30 * 24 * 60 * 60 * 1000 && (s.usageCount || 0) === 0) return false;
            return true;
          });
          await storage.set({ urchinSkills: pruned });
        }
      }
    } catch (_) {}
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * REASONING LOOP (core THINK → ACT → OBSERVE → DECIDE)
 * ───────────────────────────────────────────────────────────────────────── */

async function urchinLoop(userInput, options = {}) {
  const {
    systemPrompt = getDefaultSystemPrompt(),
    callLLM = defaultCallLLM,
    storage = createMemoryStorage(),
    tools: customTools = {},
    maxSteps = 12,
    history = [],
    pageContext = null,
    context = [],
    settings = {},
    onStep = null,
    onThink = null,
    runPostJobs = true,
  } = options;

  const allTools = { ...createBuiltInTools(storage), ...customTools };
  const memResult = await loadMemoryLayers(storage, { userInput, history, pageContext, context, settings });
  const messages = memResult.messages || memResult;
  const activeSkillNames = memResult.activeSkillNames || [];
  trimMessagesToBudget(messages);

  let finalAnswer = '';
  const log = { steps: [], startTime: Date.now() };

  for (let step = 0; step < maxSteps; step++) {
    if (onStep) onStep(step + 1, maxSteps, messages);

    const raw = await callLLM(systemPrompt, messages, settings);
    log.steps.push({ step: step + 1, rawLength: raw.length });

    const thinkMatch = raw.match(THINK_REGEX);
    if (thinkMatch && onThink) onThink(thinkMatch[1].trim());
    const cleaned = raw.replace(THINK_REGEX, '').trim();

    const matches = [...cleaned.matchAll(TOOL_REGEX)];
    if (matches.length === 0) {
      finalAnswer = cleaned;
      break;
    }

    const toolJobs = matches.map(m => ({ name: m[1], param: (m[2] || '').trim() }));
    messages.push({ role: 'assistant', content: cleaned });

    const executeOne = async ({ name, param }) => {
      const handler = allTools[name];
      try {
        return handler ? await handler(param, { storage, settings }) : { error: `Unknown tool: ${name}` };
      } catch (e) {
        return { error: e.message };
      }
    };

    const toolResults = toolJobs.length > 1
      ? await Promise.all(toolJobs.map(executeOne))
      : [await executeOne(toolJobs[0])];

    let combinedResults = '';
    for (let i = 0; i < toolJobs.length; i++) {
      const { name } = toolJobs[i];
      const tr = toolResults[i];
      const summarized = summarizeToolResult(name, tr);
      combinedResults += `[Tool result for ${name}]: ${summarized}\n`;
      if (tr?.error) combinedResults += '\n[HINT: Tool failed. Try a different approach.]\n';
    }

    messages.push({ role: 'user', content: combinedResults.trim() });
  }

  // Persist chat history
  const newHistory = [...history, { role: 'user', text: userInput }, { role: 'assistant', text: finalAnswer }];
  const { urchinChatHistory = [] } = await storage.get('urchinChatHistory');
  const updated = [...urchinChatHistory, ...newHistory.slice(-2)];
  await storage.set({ urchinChatHistory: updated.slice(-MAX_CHAT_HISTORY) });

  // Post-response jobs (fire-and-forget)
  if (runPostJobs && finalAnswer) {
    setTimeout(() => {
      runPostResponseJobs(storage, messages, newHistory, callLLM, settings, activeSkillNames).catch(() => {});
    }, 100);
  }

  log.endTime = Date.now();
  return {
    answer: finalAnswer || 'No response.',
    log,
    requestId: `ul-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
 * DEFAULT SYSTEM PROMPT
 * ───────────────────────────────────────────────────────────────────────── */

function getDefaultSystemPrompt() {
  return `You are a helpful AI assistant with access to tools. You think step-by-step and use tools when needed.

MEMORY: You have access to condensed history, recent messages, user profile, session summaries, and saved memories. Use REMEMBER to save important facts. Use RECALL or SEARCH_MEMORY to retrieve them.

TOOLS — include the exact tag to invoke:
<<TOOL:WEB_SEARCH:query>> — Search the web for real-time info.
<<TOOL:FETCH_URL:url>> — Fetch and read webpage content.
<<TOOL:REMEMBER:{"key":"...","value":"..."}>> — Save to persistent memory.
<<TOOL:RECALL:key>> — Recall saved info. Use "all" for everything.
<<TOOL:SEARCH_MEMORY:query>> — Semantic search across memories (embeddings when available, keyword fallback).

RULES:
1. ALWAYS start non-trivial responses with <<THINK>>...your reasoning...<</THINK>>
2. Use tools when you need external data, don't guess.
3. Be concise. After using a tool, summarize the result clearly.
4. Only output one tool tag per tool use (you can use multiple tools in one response).
5. When unsure, say so. Never confidently state something you're not sure about.`;
}

/* ─────────────────────────────────────────────────────────────────────────
 * EXPORTS
 * ───────────────────────────────────────────────────────────────────────── */

// CommonJS (Node.js: require('./urchinloop.js'))
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    urchinLoop,
    createMemoryStorage,
    createBuiltInTools,
    defaultCallLLM,
    extractJSON,
    cosineSimilarity,
    getEmbedding,
    semanticRecallWithEmbeddings,
    keywordFallback,
    relevanceFilterMemories,
    TOOL_REGEX,
    TOOL_REGEX_SINGLE,
    THINK_REGEX,
  };
}

// Browser global
if (typeof window !== 'undefined') {
  window.UrchinLoop = {
    urchinLoop,
    createMemoryStorage,
    createBuiltInTools,
    defaultCallLLM,
    extractJSON,
    cosineSimilarity,
    getEmbedding,
    semanticRecallWithEmbeddings,
    keywordFallback,
    relevanceFilterMemories,
    TOOL_REGEX,
    TOOL_REGEX_SINGLE,
    THINK_REGEX,
  };
}
