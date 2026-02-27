# UrchinLoop

**UrchinLoop** is an open-source agentic reasoning engine. It powers [urchinbot](https://x.com/urchinbot) but is designed to work anywhere — browser extensions, Telegram bots, CLIs, servers, or any JavaScript runtime.

UrchinLoop is not a chatbot wrapper. It is a deterministic think-act-observe loop with persistent memory, tool execution, chain-of-thought reasoning, and auto-context detection.

---

## Architecture

```
                    UrchinLoop Engine
  ┌─────────────────────────────────────────────┐
  │   ┌──────────┐    ┌──────────┐              │
  │   │  Memory   │    │  Context  │              │
  │   │  System   │    │  Builder  │              │
  │   └────┬─────┘    └─────┬────┘              │
  │        │                │                   │
  │        v                v                   │
  │   ┌─────────────────────────┐               │
  │   │      Message Builder    │               │
  │   │  (layers 1-5 injected)  │               │
  │   └────────────┬────────────┘               │
  │                v                            │
  │   ┌─────────────────────────┐               │
  │   │     Reasoning Loop      │               │
  │   │  THINK → ACT → OBSERVE → DECIDE         │
  │   │    ^                        │           │
  │   │    └────────────────────────┘           │
  │   │       (up to 12 iterations)             │
  │   └────────────┬────────────┘               │
  │                v                            │
  │   ┌─────────────────────────┐               │
  │   │    Post-Response Jobs   │               │
  │   └─────────────────────────┘               │
  └─────────────────────────────────────────────┘
           │              │              │
     ┌─────┘        ┌─────┘        ┌─────┘
     v              v              v
  ┌──────┐    ┌──────────┐    ┌─────────┐
  │ LLM  │    │  Tools   │    │ Storage │
  │ API  │    │ (16+)    │    │ (local) │
  └──────┘    └──────────┘    └─────────┘
```

---

## The Loop

Every request runs through this cycle:

### 1. Load Memory

Five layers of memory are loaded and injected into the LLM context:

| Layer | Source | Persistence | Size |
|-------|--------|-------------|------|
| Condensed History | Compressed narrative of all past conversations | Permanent, rewritten on overflow | Up to 4000 chars |
| Recent Messages | Last 30 chat messages at full fidelity | Session-persistent, rolls off | 30 messages |
| User Profile | Auto-extracted user knowledge (wallets, preferences, projects) | Permanent, auto-updated | Unlimited keys |
| Session Summaries | Bullet-point summaries of past sessions | Last 20 kept, 1500 chars each | 20 entries |
| Manual Memories | Explicitly saved via REMEMBER tool | Permanent until wiped | Unlimited keys |

### 2. Build Context

The engine constructs a rich context object from the environment: page URL, visible text, selected text, platform-specific extraction (Twitter, DexScreener, pump.fun, etc.), and uploaded files.

### 3. Reasoning Loop (THINK → ACT → OBSERVE → DECIDE)

The core loop runs up to 12 iterations:

```
for each step (max 12):
    1. Call LLM with system prompt + messages
    2. Extract <<THINK>> blocks (hidden reasoning, logged but not shown to user)
    3. Check for <<TOOL:NAME:param>> tags
    4. If tool found:
         - Execute the tool
         - Append tool result to message history
         - Continue to next step
    5. If no tool found:
         - Treat response as final answer
         - Break loop
```

### 4. Chain-of-Thought

The system prompt enforces mandatory `<<THINK>>` blocks:

```
<<THINK>>
The user wants to compare three tokens. I should:
1. Use MULTI_SCAN to scan all three at once
2. Check the deployer wallets for the riskiest one
3. Search for any news about these projects
4. Give a final comparison
<</THINK>>
```

### 5. Tool Protocol

Tools are invoked via text tags in the LLM response:

```
<<TOOL:SCAN_TOKEN:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU>>
<<TOOL:WEB_SEARCH:Solana token price>>
<<TOOL:REMEMBER>>   — tool without parameter
```

**Regex to match tools:**

```javascript
/<<TOOL:(\w+)(?::([\s\S]+?))?>>/
```

**Regex to match think blocks:**

```javascript
/<<THINK>>([\s\S]+?)<<\/THINK>>/
```

---

## Minimal Reference Implementation

Here's a portable, dependency-light core loop you can copy and adapt. Swap `callLLM` and `storage` for your platform.

```javascript
/**
 * UrchinLoop — minimal reference implementation
 * Replace callLLM and storage with your own (OpenAI, Anthropic, Redis, etc.)
 */

const TOOL_REGEX = /<<TOOL:(\w+)(?::([\s\S]+?))?>>/g;
const THINK_REGEX = /<<THINK>>([\s\S]+?)<<\/THINK>>/;

async function urchinLoop(userInput, options = {}) {
  const {
    systemPrompt = 'You are a helpful AI assistant with access to tools.',
    callLLM = async (system, messages) => { throw new Error('Provide callLLM'); },
    storage = { get: () => ({}), set: () => {} },
    tools = {},
    maxSteps = 12,
    history = [],
    pageContext = null,
  } = options;

  const messages = [];

  // Layer 1: Condensed history (if any)
  const { condensed } = await storage.get('condensed') || {};
  if (condensed) {
    messages.push({ role: 'user', content: `[Previous history:\n${condensed}]` });
    messages.push({ role: 'assistant', content: 'Understood.' });
  }

  // Layer 2: Recent history
  for (const h of history.slice(-30)) {
    messages.push({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text });
  }

  // Layer 3: Current message with context
  let userMsg = '';
  if (pageContext) {
    userMsg += `[Page: ${pageContext.title || ''} — ${pageContext.url || ''}]\n`;
    if (pageContext.selection) userMsg += `[Selected: ${pageContext.selection}]\n`;
  }
  userMsg += '\n' + userInput;
  messages.push({ role: 'user', content: userMsg.trim() });

  let finalAnswer = '';

  for (let step = 0; step < maxSteps; step++) {
    const raw = await callLLM(systemPrompt, messages);

    // Strip <<THINK>> (optional: log it for debugging)
    const thinkMatch = raw.match(THINK_REGEX);
    const cleaned = raw.replace(THINK_REGEX, '').trim();

    // Find all tool calls
    const matches = [...cleaned.matchAll(TOOL_REGEX)];

    if (matches.length === 0) {
      finalAnswer = cleaned;
      break;
    }

    // Execute tools (parallel)
    const toolJobs = matches.map(m => ({ name: m[1], param: (m[2] || '').trim() }));
    messages.push({ role: 'assistant', content: cleaned });

    let combinedResults = '';
    for (const job of toolJobs) {
      const handler = tools[job.name];
      let result;
      try {
        result = handler ? await handler(job.param) : { error: `Unknown tool: ${job.name}` };
      } catch (e) {
        result = { error: e.message };
      }
      combinedResults += `[Tool ${job.name}]: ${JSON.stringify(result)}\n`;
    }

    messages.push({ role: 'user', content: combinedResults });
  }

  return finalAnswer;
}

// Example tool registry
const exampleTools = {
  WEB_SEARCH: async (query) => {
    const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json`);
    const data = await res.json();
    return { results: data.RelatedTopics?.slice(0, 5) || [] };
  },
  REMEMBER: async (param) => {
    const { key, value } = JSON.parse(param);
    // storage.set(key, value);
    return { success: true, message: `Remembered "${key}"` };
  },
  RECALL: async (key) => {
    // const value = storage.get(key);
    return { value: 'stored value for ' + key };
  },
};
```

### Adding a New Tool

1. **Document in system prompt:**
   ```
   <<TOOL:MY_TOOL:param>> — Description of what it does.
   ```

2. **Add handler to tools object:**
   ```javascript
   tools.MY_TOOL = async (param) => {
     const result = await doSomething(param);
     return { success: true, data: result };
   };
   ```

3. **Tool results are fed back as:** `[Tool MY_TOOL]: {"success":true,"data":"..."}`

---

## Storage Keys

| Key | Description |
|-----|-------------|
| `condensed` | Compressed narrative of old conversations |
| `memory` | Session summaries + manual memories |
| `profile` | Auto-extracted user profile |
| `chatHistory` | Raw chat messages (max 200) |

---

## LLM Interface

UrchinLoop supports any LLM that speaks OpenAI-compatible or Anthropic API:

```javascript
async function callLLM(systemPrompt, messages, settings)
```

- `messages`: `[{ role: 'user'|'assistant', content: string }]`
- Returns: `string` (raw LLM response)
- Must handle `<<TOOL:...>>` in output — do not strip; the loop parses it

---

## Extending UrchinLoop

To port to another platform:

1. Replace `storage` with Redis, SQLite, filesystem, or in-memory
2. Replace `callLLM` with your LLM provider
3. Implement only the tools you need
4. Wire input/output (Telegram, CLI, HTTP)

The core loop, tool regex, and message flow stay the same.

---

## License

MIT

## Links

- [urchinbot on X](https://x.com/urchinbot)
- [Full implementation](../../urchinbot-extension/background.js) — see `urchinLoop()` around line 1126
