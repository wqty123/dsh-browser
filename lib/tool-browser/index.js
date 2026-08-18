/**
 * Model-facing browser tools over `ctx.browser`: `browser_open`,
 * `browser_snapshot`, `browser_execute`, `browser_content`,
 * `browser_screenshot`, and tab management (`browser_list_tabs`,
 * `browser_switch_tab`, `browser_close_tab`, `browser_reset`).
 *
 * The tool layer owns only the model-facing schema, argument validation, and
 * result formatting — never provider selection or page driving, which belong
 * to the seam. Session lifecycle is owned here at the plugin level: each
 * calling task (a DSH session) gets its own browser session — the first
 * `browser_open` (or any tool when no session exists) opens it, and later
 * tools in the same task reuse it. Concurrent tasks therefore never fight
 * over tabs, history, or navigation state.
 * @module dsh-browser/tool-browser
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
/** Plugin name used by loader diagnostics. */
export const name = 'tool-browser';
/** The tool registry, browser seam, and system-prompt registry this tool layer consumes. */
export const inject = ['tools', 'browser', 'systemPrompt'];
function createState() {
    return { sessionsByTask: new Map(), pendingOpens: new Map(), restrictedTo: undefined };
}
/** Every live state, for the test hook (introspection only, never shared). */
const liveStates = new Set();
/**
 * Guard one browser tool call against the active restriction. Refuses calls
 * not on the allow-list when a restriction is in effect.
 * @param state - the calling context's tool state.
 * @param toolName - the browser tool about to run.
 */
function assertAllowed(state, toolName) {
    const { restrictedTo } = state;
    if (restrictedTo === undefined)
        return;
    if (restrictedTo.includes(toolName))
        return;
    throw new Error(`browser action "${toolName}" is restricted (allow-list: ${restrictedTo.join(', ')})`);
}
/** Extract the agent from a tool-execution context, when one exists. */
function agentOf(exec) {
    return exec?.agent;
}
/**
 * The task key for a tool call: the calling DSH session id, or the shared
 * default key when the call carries no agent context (CLI probes, tests).
 * @param exec - the tool-execution context; only its optional agent id is read.
 */
function taskKey(exec) {
    return exec?.agent?.id ?? 'default';
}
/**
 * Resolve the calling task's browser session, opening one on first use.
 * Concurrent first calls for the same key share a single open. When the call
 * carries an agent, the session's lifetime is tied to the agent's scoped
 * context: it closes automatically when the agent (DSH session) is disposed,
 * so sessions and their windows never leak after a task ends.
 * @param browser - the seam service.
 * @param state - the calling context's tool state.
 * @param key - the task key (see {@link taskKey}).
 * @param agent - the calling agent, when any (its ctx owns the session).
 * @returns the task's session id.
 */
async function ensureSession(browser, state, key, agent) {
    const existing = state.sessionsByTask.get(key);
    if (existing !== undefined)
        return existing;
    const pending = state.pendingOpens.get(key);
    if (pending !== undefined)
        return pending;
    // The task key rides along as the session label so the window title shows
    // which task's page is currently visible to the human.
    const opening = browser.open(key).then(session => {
        // Tie the session's lifetime to the agent's scoped context FIRST: when
        // the agent (and its DSH session) is disposed, the effect's disposer
        // runs and closes the browser session. Registration happens once per
        // session (only on first open for the key). If the agent is already
        // gone, close the fresh session instead of leaking it.
        state.sessionsByTask.set(key, session);
        state.pendingOpens.delete(key);
        try {
            if (agent?.ctx !== undefined) {
                agent.ctx.effect(() => () => {
                    const current = state.sessionsByTask.get(key);
                    if (current === undefined)
                        return;
                    state.sessionsByTask.delete(key);
                    void browser.close(current).catch(() => { });
                });
            }
            else if (key === 'default') {
                // Agentless / CLI probe: close the session on process exit so the
                // window is not orphaned.
                process.on('exit', () => {
                    void browser.close(session).catch(() => { });
                });
            }
        }
        catch (error) {
            // effect() failed — undo the registration so future calls retry.
            state.sessionsByTask.delete(key);
            void browser.close(session).catch(() => { });
            throw error;
        }
        return session;
    }, error => { state.pendingOpens.delete(key); throw error; });
    state.pendingOpens.set(key, opening);
    return opening;
}
/** Coerce a tool-provided string value back to boolean/number only when lossless. */
function parseFillValue(v) {
    if (v === 'true')
        return true;
    if (v === 'false')
        return false;
    if (v !== undefined && /^-?\d+(\.\d+)?$/.test(v) && String(Number(v)) === v)
        return Number(v);
    return v ?? '';
}
/** Format a snapshot element list for the model. */
function formatSnapshot(snapshot) {
    const lines = snapshot.elements.map(el => `[${el.ref}] ${el.kind}: ${el.label}${el.frame === true ? ' (iframe)' : ''} (${el.x},${el.y})`);
    const header = `URL: ${snapshot.url}${snapshot.title !== undefined ? `\nTitle: ${snapshot.title}` : ''}`;
    const body = lines.length > 0 ? lines.join('\n') : '(no interactive elements found)';
    const tail = snapshot.truncated === true ? '\n(snapshot truncated)' : '';
    const banner = snapshot.challenge?.blocked === true
        ? `\n\nCHALLENGE: ${snapshot.challenge.reason ?? 'human-verification'}. Do NOT keep retrying — ask the human to complete it in the shared browser window, then re-snapshot.`
        : '';
    return `${header}\n\n${body}${tail}${banner}`;
}
/** Register all browser tools with `ctx.tools`. */
export function apply(ctx, config = {}) {
    const timeoutMs = config.timeoutMs ?? 60_000;
    // Per-context state: sessions, in-flight opens, and the restriction are
    // scoped to THIS plugin apply, so parallel contexts never share sessions
    // or leak restrictions into each other.
    const state = createState();
    liveStates.add(state);
    ctx.effect(() => () => { liveStates.delete(state); });
    // Re-apply resets the restriction: an omitted allowedActions lifts it.
    state.restrictedTo = config.allowedActions !== undefined ? [...config.allowedActions] : undefined;
    ctx.systemPrompt.section({
        name: 'tool:browser',
        // Tool guidance band is 100-199; 150 keeps clear of the common 110/120
        // tool sections so ordering does not depend on plugin load sequence.
        order: 150,
        text: 'Use the browser_* tools to operate the built-in browser. Each task gets its own browser session AND its own window (with a real toolbar: address bar, back/forward/reload, tab strip) — the human can see it, use it like any browser, and take over at any time; your tabs and history are isolated from other tasks, so do not assume another task\'s navigation state is visible to you. Understand a page with browser_a11y (semantic roles/names/states — the best structure map) or browser_snapshot (numbered interactive elements), then drive it: browser_click/browser_type accept a target {by: css|text|xpath, value} for semantic locating, or coordinates from browser_screenshot for visual targeting. For form filling prefer browser_fill (batch) or browser_set_value/browser_check/browser_select/browser_clear (single control, target-based); verify with browser_get_value. Use browser_scrape for structured extraction from list pages instead of hand-written browser_execute. After navigating on slow sites, browser_wait for the page. Keep the human informed of what you are doing on the page. If a snapshot or browser_challenge reports a human-verification challenge (CAPTCHA), stop retrying and ask the human to complete it in the browser window, then re-check.',
    });
    ctx.tools.register(defineTool({
        name: 'browser_open',
        description: 'Open a URL in the shared browser window. Opens this task\'s browser session on first use; optionally opens in a new tab. Returns the resulting page snapshot.',
        parameters: {
            url: { type: 'string', required: true, description: 'The URL to open (HTTP/HTTPS).' },
            newTab: { type: 'boolean', description: 'Open in a new tab instead of the active one.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    url: { type: 'string', required: true },
                    title: { type: 'string' },
                    truncated: { type: 'boolean' },
                    elements: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                ref: { type: 'number', required: true },
                                kind: { type: 'string', required: true },
                                label: { type: 'string', required: true },
                                x: { type: 'number', required: true },
                                y: { type: 'number', required: true },
                                frame: { type: 'boolean' },
                            },
                        },
                    },
                    challenge: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            blocked: { type: 'boolean', required: true },
                            kind: { type: 'string' },
                            reason: { type: 'string' },
                        },
                    },
                },
            },
            render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }],
        },
        timeoutMs,
        isConcurrencySafe: () => false, // opens tabs / navigates; exclusive within a task
        async execute(args, exec) {
            assertAllowed(state, 'browser_open');
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
            await browser.openUrl(session, {
                url: args.url,
                ...args.newTab === true ? { newTab: true } : {},
            }, exec.signal);
            const snapshot = await browser.snapshot(session, exec.signal);
            return {
                url: snapshot.url,
                ...snapshot.title !== undefined ? { title: snapshot.title } : {},
                elements: snapshot.elements.map(el => ({ ref: el.ref, kind: el.kind, label: el.label, x: el.x, y: el.y, ...el.frame === true ? { frame: true } : {} })),
                truncated: snapshot.truncated,
                ...snapshot.challenge !== undefined ? { challenge: snapshot.challenge } : {},
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_snapshot',
        description: 'Return an AI-friendly snapshot of the current shared-browser page: numbered interactive elements (inputs, buttons, links) the model can cite. Use this to understand an interactive page before driving it.',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    url: { type: 'string', required: true },
                    title: { type: 'string' },
                    truncated: { type: 'boolean' },
                    elements: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                ref: { type: 'number', required: true },
                                kind: { type: 'string', required: true },
                                label: { type: 'string', required: true },
                                x: { type: 'number', required: true },
                                y: { type: 'number', required: true },
                                frame: { type: 'boolean' },
                            },
                        },
                    },
                    challenge: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            blocked: { type: 'boolean', required: true },
                            kind: { type: 'string' },
                            reason: { type: 'string' },
                        },
                    },
                },
            },
            render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }],
        },
        timeoutMs,
        isConcurrencySafe: () => true,
        async execute(_args, exec) {
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
            const snapshot = await browser.snapshot(session, exec.signal);
            return {
                url: snapshot.url,
                ...snapshot.title !== undefined ? { title: snapshot.title } : {},
                elements: snapshot.elements.map(el => ({ ref: el.ref, kind: el.kind, label: el.label, x: el.x, y: el.y, ...el.frame === true ? { frame: true } : {} })),
                truncated: snapshot.truncated,
                ...snapshot.challenge !== undefined ? { challenge: snapshot.challenge } : {},
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_a11y',
        description: 'Read the page\'s accessibility tree: every interactive node with its semantic role (button/link/textbox/checkbox/…), accessible name, current value, and states (enabled/disabled/checked/expanded/…), plus coordinates. Prefer this over browser_snapshot to understand a page\'s structure and find the right element: roles and names tell you WHAT each node is, and the coordinates let you drive it with browser_click/browser_type. Penetrates same-origin iframes and shadow roots.',
        parameters: {
            includeHidden: { type: 'boolean', description: 'Include hidden elements (default false).' },
            maxNodes: { type: 'number', description: 'Maximum nodes (default 500, range 10-5000).' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    url: { type: 'string', required: true },
                    title: { type: 'string' },
                    count: { type: 'number', required: true },
                    truncated: { type: 'boolean' },
                    nodes: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                ref: { type: 'number', required: true },
                                role: { type: 'string', required: true },
                                name: { type: 'string', required: true },
                                value: { type: 'string' },
                                states: { type: 'array', required: true, items: { type: 'string' } },
                                depth: { type: 'number', required: true },
                                tag: { type: 'string', required: true },
                                x: { type: 'number', required: true },
                                y: { type: 'number', required: true },
                                frame: { type: 'boolean' },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => {
                const nodes = value.nodes;
                const lines = nodes.map(n => {
                    const valuePart = n.value !== undefined && n.value !== null ? ` value="${String(n.value).slice(0, 60)}"` : '';
                    return `[${n.ref}] ${n.role} "${n.name}"${valuePart} (${n.x},${n.y}) states=[${n.states.join(',')}]${n.frame === true ? ' (iframe)' : ''}`;
                });
                const header = `URL: ${value.url}${value.title !== undefined ? `\nTitle: ${value.title}` : ''}`;
                return [{ type: 'text', text: `${header}\n\n${lines.length > 0 ? lines.join('\n') : '(no accessible interactive nodes)'}${value.truncated === true ? '\n(truncated)' : ''}` }];
            },
        },
        timeoutMs,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
            const result = await browser.a11y(session, {
                ...args.includeHidden === true ? { includeHidden: true } : {},
                ...args.maxNodes !== undefined ? { maxNodes: args.maxNodes } : {},
            }, exec.signal);
            return {
                url: result.url,
                ...result.title !== undefined ? { title: result.title } : {},
                count: result.count,
                truncated: result.truncated,
                nodes: result.nodes.map(n => ({
                    ref: n.ref,
                    role: n.role,
                    name: n.name,
                    ...n.value !== null ? { value: n.value } : {},
                    states: [...n.states],
                    depth: n.depth,
                    tag: n.tag,
                    x: n.x,
                    y: n.y,
                    ...n.frame === true ? { frame: true } : {},
                })),
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_challenge',
        description: 'Check whether a human-verification challenge (CAPTCHA / bot detection: Cloudflare "Just a moment", reCAPTCHA, hCaptcha, Turnstile) is blocking the current page. When blocked, do NOT keep retrying automated steps — ask the human to complete the verification in the shared browser window, then re-check with browser_snapshot.',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    blocked: { type: 'boolean', required: true },
                    kind: { type: 'string' },
                    reason: { type: 'string' },
                    hint: { type: 'string' },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: value.blocked
                        ? `Challenge detected: ${value.reason ?? value.kind ?? 'human-verification'}. ${value.hint ?? ''}`
                        : 'No human-verification challenge detected.',
                }],
        },
        timeoutMs,
        isConcurrencySafe: () => true,
        async execute(_args, exec) {
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
            const challenge = await browser.detectChallenge(session, exec.signal);
            return {
                blocked: challenge.blocked,
                ...challenge.kind !== undefined ? { kind: challenge.kind } : {},
                ...challenge.reason !== undefined ? { reason: challenge.reason } : {},
                hint: challenge.blocked
                    ? 'Ask the human to complete the verification in the shared browser window (the page is visible to them), then re-check with browser_snapshot.'
                    : '',
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_wait',
        description: 'Wait until the shared-browser page is ready: load complete, and optionally the expected URL and/or a CSS selector present (top document or same-origin iframes). Use after browser_open on slow sites instead of snapshotting a white page — wait for the URL you navigated to first. Returns ready=true/false with a short reason; a miss is not an error.',
        parameters: {
            timeoutMs: { type: 'number', description: 'Maximum wait in ms (default 30000).' },
            url: { type: 'string', description: 'Expected page URL (exact or prefix), e.g. the URL you opened.' },
            selector: { type: 'string', description: 'CSS selector that must exist.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ready: { type: 'boolean', required: true },
                    reason: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.ready ? 'Page ready.' : `Wait timed out: ${value.reason}` }],
        },
        timeoutMs,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
            const result = await browser.waitFor(session, {
                ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
                ...args.url !== undefined ? { url: args.url } : {},
                ...args.selector !== undefined ? { selector: args.selector } : {},
            }, exec.signal);
            return { ready: result.ready, reason: result.reason };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_execute',
        description: 'Execute JavaScript in the shared-browser page context. This is the primary way to interact with page elements: focus, fill inputs (use the native value setter for framework-controlled inputs, then dispatch an input event), click buttons (element.click() or a constructed MouseEvent). Returns the evaluation result by value, or the exception text.',
        parameters: {
            script: { type: 'string', required: true, description: 'The JavaScript expression to evaluate in the page context.' },
            args: { type: 'array', items: { type: 'string' }, description: 'Optional arguments injected into the script scope as arguments[0..n].' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    value: { type: 'string' },
                    exception: { type: 'string' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.ok ? `Result: ${String(value.value)}` : `Exception: ${value.exception}` }],
        },
        timeoutMs,
        isConcurrencySafe: () => false, // page JS can be stateful
        async execute(args, exec) {
            assertAllowed(state, 'browser_execute');
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
            const result = await browser.execute(session, {
                script: args.script,
                args: args.args ?? [],
            }, exec.signal);
            if (result.ok) {
                const raw = result.value;
                const value = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
                return { ok: true, value };
            }
            return { ok: false, exception: result.exception };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_content',
        description: 'Fetch the current shared-browser page content in a chosen format: html (raw DOM), markdown (structured reading), txt (plain text), or json. Optionally scope to a CSS selector and cap the length. Use this to read page content, not to interact.',
        parameters: {
            format: { type: 'string', required: true, enum: ['html', 'markdown', 'txt', 'json'], description: 'Output format.' },
            selector: { type: 'string', description: 'CSS selector limiting the fetch to one region (e.g. #main).' },
            maxChars: { type: 'number', description: 'Maximum characters of returned content.' },
            timeoutMs: { type: 'number', description: 'Evaluation timeout in ms (default 30000).' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    content: { type: 'string', required: true },
                    truncated: { type: 'boolean', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.content + (value.truncated ? '\n(truncated)' : '') }],
        },
        timeoutMs,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
            const result = await browser.content(session, {
                format: args.format,
                ...args.selector !== undefined ? { selector: args.selector } : {},
                ...args.maxChars !== undefined ? { maxChars: args.maxChars } : {},
                ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
            }, exec.signal);
            return { content: result.content, truncated: result.truncated };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_scrape',
        description: 'Extract structured data from a page: give the container CSS selector (item) and a field map (name -> selector, optionally selector@attr to take an attribute; a@href yields the absolute URL). Returns one object per item. Static CSS queries only — no arbitrary code runs — so it is safe on any page. Use for list pages (search results, cards, tables) instead of hand-writing browser_execute.',
        parameters: {
            item: { type: 'string', required: true, description: 'CSS selector of each result container (e.g. "div.card").' },
            fields: {
                type: 'object',
                required: true,
                additionalProperties: true,
                description: 'Field map: name -> selector[@attr] (e.g. {"title": "h3", "url": "a@href"}).',
            },
            timeoutMs: { type: 'number', description: 'Wait budget for the item selector in ms (default 5000).' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    count: { type: 'number', required: true },
                    items: {
                        type: 'array',
                        required: true,
                        items: { type: 'object', additionalProperties: true },
                    },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `${value.count} item(s):\n${JSON.stringify(value.items, null, 2)}`,
                }],
        },
        timeoutMs,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            assertAllowed(state, 'browser_scrape');
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
            const fields = (args.fields ?? {});
            const result = await browser.scrape(session, {
                item: args.item,
                fields: Object.entries(fields).map(([name, selector]) => ({ name, selector })),
                ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
            }, exec.signal);
            return { count: result.count, items: result.items.map(it => ({ ...it })) };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_click',
        description: 'Click in the shared browser. Two ways: (1) semantic target — pass target {by: css|text|xpath, value, index?} and the element is located, scrolled into view and clicked at its center; (2) viewport coordinates (x/y) — use with browser_screenshot when a vision model locates an element on the screenshot (covers icons, image buttons, and canvas that DOM locators cannot target). Provide exactly one of target or x/y.',
        parameters: {
            target: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    by: { type: 'string', enum: ['css', 'text', 'xpath'], description: 'Locator kind (default css). text matches an element\'s own visible text, exact first then contains.' },
                    value: { type: 'string', required: true, description: 'The CSS selector, visible text, or XPath expression.' },
                    index: { type: 'number', description: '0-based index of the match (default 0).' },
                },
                description: 'Locate the element semantically and click it (css/text/xpath).',
            },
            x: { type: 'number', description: 'Viewport x coordinate (CSS px), e.g. from a vision model reading the screenshot.' },
            y: { type: 'number', description: 'Viewport y coordinate (CSS px).' },
        },
        output: {
            schema: { type: 'object', additionalProperties: false, properties: { clicked: { type: 'boolean', required: true } } },
            render: (_args, value) => [{ type: 'text', text: value.clicked ? 'Clicked.' : 'Click failed.' }],
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            assertAllowed(state, 'browser_click');
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
            const target = args.target;
            if (target !== undefined && typeof target.value === 'string' && target.value !== '') {
                await browser.click(session, {
                    target: {
                        by: (target.by === 'text' || target.by === 'xpath' ? target.by : 'css'),
                        value: target.value,
                        ...target.index !== undefined ? { index: target.index } : {},
                    },
                }, exec.signal);
            }
            else {
                if (typeof args.x !== 'number' || typeof args.y !== 'number') {
                    throw new Error('browser_click: provide a target (css/text/xpath) or x/y coordinates');
                }
                await browser.click(session, { x: args.x, y: args.y }, exec.signal);
            }
            return { clicked: true };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_type',
        description: 'Type text into the focused element of the shared browser, or into a located element (pass target {by: css|text|xpath, value, index?} to focus it first). Text is inserted at the focus via CDP Input.insertText. For setting whole field values (and React-controlled inputs) prefer browser_set_value; use browser_key for Enter/Tab/arrows.',
        parameters: {
            text: { type: 'string', required: true, description: 'The text to insert.' },
            target: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    by: { type: 'string', enum: ['css', 'text', 'xpath'], description: 'Locator kind (default css).' },
                    value: { type: 'string', required: true, description: 'The CSS selector, visible text, or XPath expression.' },
                    index: { type: 'number', description: '0-based index of the match (default 0).' },
                },
                description: 'Focus this element first, then type (css/text/xpath).',
            },
        },
        output: {
            schema: { type: 'object', additionalProperties: false, properties: { typed: { type: 'boolean', required: true } } },
            render: (_args, value) => [{ type: 'text', text: value.typed ? `Typed ${String(_args.text).length} chars.` : 'Type failed.' }],
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            assertAllowed(state, 'browser_type');
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
            const target = args.target;
            if (target !== undefined && typeof target.value === 'string' && target.value !== '') {
                await browser.type(session, {
                    text: args.text,
                    target: {
                        by: (target.by === 'text' || target.by === 'xpath' ? target.by : 'css'),
                        value: target.value,
                        ...target.index !== undefined ? { index: target.index } : {},
                    },
                }, exec.signal);
            }
            else {
                await browser.type(session, { text: args.text }, exec.signal);
            }
            return { typed: true };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_scroll',
        description: 'Scroll the shared-browser page: by pixel deltas (deltaX/deltaY), to a CSS selector\'s element, or to the top/bottom. Use to reveal below-the-fold content before snapshotting or clicking.',
        parameters: {
            deltaX: { type: 'number', description: 'Horizontal scroll delta in CSS pixels.' },
            deltaY: { type: 'number', description: 'Vertical scroll delta in CSS pixels.' },
            selector: { type: 'string', description: 'Scroll the element matching this CSS selector into view.' },
            toTop: { type: 'boolean', description: 'Scroll to the top of the page.' },
            toBottom: { type: 'boolean', description: 'Scroll to the bottom of the page.' },
        },
        output: {
            schema: { type: 'object', additionalProperties: false, properties: { scrolled: { type: 'boolean', required: true } } },
            render: (_args, value) => [{ type: 'text', text: value.scrolled ? 'Scrolled.' : 'Scroll failed.' }],
        },
        timeoutMs,
        isConcurrencySafe: () => false, // mutates page scroll state; exclusive within a task
        async execute(args, exec) {
            assertAllowed(state, 'browser_scroll');
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
            await browser.scroll(session, {
                ...args.deltaX !== undefined ? { deltaX: args.deltaX } : {},
                ...args.deltaY !== undefined ? { deltaY: args.deltaY } : {},
                ...args.selector !== undefined ? { selector: args.selector } : {},
                ...args.toTop === true ? { toTop: true } : {},
                ...args.toBottom === true ? { toBottom: true } : {},
            }, exec.signal);
            return { scrolled: true };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_back',
        description: 'Go back one step in the shared-browser page history. A no-op when there is no previous entry.',
        parameters: {},
        output: {
            schema: { type: 'object', additionalProperties: false, properties: { back: { type: 'boolean', required: true } } },
            render: (_args, value) => [{ type: 'text', text: value.back ? 'Went back.' : 'Failed.' }],
        },
        timeoutMs,
        isConcurrencySafe: () => false, // mutates page state; exclusive within a task
        async execute(_args, exec) {
            assertAllowed(state, 'browser_back');
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
            await browser.back(session, exec.signal);
            return { back: true };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_forward',
        description: 'Go forward one step in the shared-browser page history. A no-op when there is no next entry.',
        parameters: {},
        output: {
            schema: { type: 'object', additionalProperties: false, properties: { forward: { type: 'boolean', required: true } } },
            render: (_args, value) => [{ type: 'text', text: value.forward ? 'Went forward.' : 'Failed.' }],
        },
        timeoutMs,
        isConcurrencySafe: () => false, // mutates page state; exclusive within a task
        async execute(_args, exec) {
            assertAllowed(state, 'browser_forward');
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
            await browser.forward(session, exec.signal);
            return { forward: true };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_refresh',
        description: 'Reload the current page in the shared browser (like a browser\'s refresh button). Use after a page got stuck, to apply script changes, or to re-fetch a page.',
        parameters: {},
        output: {
            schema: { type: 'object', additionalProperties: false, properties: { refreshed: { type: 'boolean', required: true } } },
            render: (_args, value) => [{ type: 'text', text: value.refreshed ? 'Page reloaded.' : 'Failed.' }],
        },
        timeoutMs,
        isConcurrencySafe: () => false, // reloads the page; exclusive within a task
        async execute(_args, exec) {
            assertAllowed(state, 'browser_refresh');
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
            await browser.reload(session, exec.signal);
            return { refreshed: true };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_key',
        description: 'Press one named key in the shared-browser page (Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space). Use after focusing an input to submit a chat box (Enter), move focus (Tab), or navigate a list (arrows).',
        parameters: {
            key: { type: 'string', required: true, enum: ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space'], description: 'The key to press.' },
        },
        output: {
            schema: { type: 'object', additionalProperties: false, properties: { pressed: { type: 'boolean', required: true } } },
            render: (_args, value) => [{ type: 'text', text: value.pressed ? `Pressed ${String(_args.key)}.` : 'Key press failed.' }],
        },
        timeoutMs,
        isConcurrencySafe: () => false, // mutates page state; exclusive within a task
        async execute(args, exec) {
            assertAllowed(state, 'browser_key');
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
            await browser.key(session, { key: args.key }, exec.signal);
            return { pressed: true };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_fill',
        description: 'Fill a form in one batch: pass fields with a CSS selector or name/label/placeholder text and the value to set (string, number, or boolean for checkbox/radio; for selects or radio groups pass the option value or visible text). Values are applied with the native setter plus input/change events, so React/Vue controlled inputs update correctly. Optionally submit the containing form. Prefer this over hand-written browser_execute for form filling; per-field failures are reported instead of throwing.',
        parameters: {
            fields: {
                type: 'array',
                required: true,
                items: {
                    type: 'object',
                    additionalProperties: true,
                    properties: {
                        selector: { type: 'string', description: 'CSS selector; when present, candidates are scoped to it.' },
                        name: { type: 'string', description: 'Match by the field\'s name attribute.' },
                        label: { type: 'string', description: 'Match by associated <label> text or aria-label.' },
                        placeholder: { type: 'string', description: 'Match by placeholder text.' },
                        kind: { type: 'string', enum: ['text', 'textarea', 'checkbox', 'radio', 'select'], description: 'Field kind; defaults to text.' },
                        value: { type: 'string', description: 'Value to set (string form; booleans/numbers accepted as strings).' },
                    },
                },
            },
            submit: { type: 'boolean', description: 'Submit the containing form after filling (default false).' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    fields: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                ok: { type: 'boolean', required: true },
                                target: { type: 'string', required: true },
                                method: { type: 'string' },
                                error: { type: 'string' },
                            },
                        },
                    },
                    submitted: { type: 'boolean', required: true },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: (() => {
                        const fields = value.fields;
                        const failed = fields.filter(f => !f.ok);
                        const lines = fields.map(f => `${f.ok ? 'OK' : 'FAIL'} ${f.target}${f.ok ? ` (${f.method ?? 'input'})` : `: ${f.error ?? 'unknown error'}`}`);
                        const head = failed.length === 0
                            ? `Filled ${fields.length}/${fields.length} fields${value.submitted ? ' and submitted the form' : ''}.`
                            : `Filled ${fields.length - failed.length}/${fields.length} fields; ${failed.length} failed:`;
                        return head + '\n' + lines.join('\n');
                    })(),
                }],
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            assertAllowed(state, 'browser_fill');
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
            const fields = (args.fields ?? []).map((f) => ({
                ...f.selector !== undefined ? { selector: f.selector } : {},
                ...f.name !== undefined ? { name: f.name } : {},
                ...f.label !== undefined ? { label: f.label } : {},
                ...f.placeholder !== undefined ? { placeholder: f.placeholder } : {},
                ...f.kind !== undefined ? { kind: f.kind } : {},
                value: parseFillValue(f.value),
            }));
            const result = await browser.fillForm(session, {
                fields,
                ...args.submit === true ? { submit: true } : {},
            }, exec.signal);
            return {
                fields: result.fields.map(f => ({ ok: f.ok, target: f.target, ...f.method !== undefined ? { method: f.method } : {}, ...f.error !== undefined ? { error: f.error } : {} })),
                submitted: result.submitted,
            };
        },
    }));
    // ---------------------------------------------------------------------------
    // Single-control form primitives, all target-based (css/text/xpath).
    // ---------------------------------------------------------------------------
    const targetParam = {
        type: 'object',
        required: true,
        additionalProperties: false,
        properties: {
            by: { type: 'string', enum: ['css', 'text', 'xpath'], description: 'Locator kind (default css). text matches an element\'s own visible text, exact first then contains.' },
            value: { type: 'string', required: true, description: 'The CSS selector, visible text, or XPath expression.' },
            index: { type: 'number', description: '0-based index of the match (default 0).' },
        },
        description: 'Locate the element (css/text/xpath).',
    };
    ctx.tools.register(defineTool({
        name: 'browser_set_value',
        description: 'Set the value of ONE input/textarea/select/contenteditable, located by css/text/xpath. Uses the native setter plus input/change events, so React/Vue controlled inputs update correctly. For selects pass the option value or visible text. For a whole form at once prefer browser_fill.',
        parameters: {
            target: targetParam,
            value: { type: 'string', required: true, description: 'The value to set (string form; numbers/booleans accepted).' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    method: { type: 'string', required: true, description: 'How the value was applied: input/textarea/select/contenteditable.' },
                    value: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: `Set via ${value.method}.` }],
        },
        timeoutMs,
        isConcurrencySafe: () => false, // mutates a field; exclusive within a task
        async execute(args, exec) {
            assertAllowed(state, 'browser_set_value');
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
            const target = args.target;
            const result = await browser.setValue(session, {
                target: {
                    by: (target.by === 'text' || target.by === 'xpath' ? target.by : 'css'),
                    value: target.value,
                    ...target.index !== undefined ? { index: target.index } : {},
                },
                value: parseFillValue(args.value),
            }, exec.signal);
            return { method: result.method, value: result.value };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_check',
        description: 'Check (or uncheck, with checked=false) a checkbox or radio button, located by css/text/xpath.',
        parameters: {
            target: targetParam,
            checked: { type: 'boolean', description: 'Desired state (default true = check).' },
        },
        output: {
            schema: { type: 'object', additionalProperties: false, properties: { checked: { type: 'boolean', required: true } } },
            render: (_args, value) => [{ type: 'text', text: value.checked ? 'Checked.' : 'Unchecked.' }],
        },
        timeoutMs,
        isConcurrencySafe: () => false, // mutates a field; exclusive within a task
        async execute(args, exec) {
            assertAllowed(state, 'browser_check');
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
            const target = args.target;
            const result = await browser.check(session, {
                target: {
                    by: (target.by === 'text' || target.by === 'xpath' ? target.by : 'css'),
                    value: target.value,
                    ...target.index !== undefined ? { index: target.index } : {},
                },
                ...args.checked !== undefined ? { checked: args.checked } : {},
            }, exec.signal);
            return { checked: result.checked };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_select',
        description: 'Select one option of a <select>, located by css/text/xpath — by option value, visible text, or 0-based index (provide exactly one).',
        parameters: {
            target: targetParam,
            optionValue: { type: 'string', description: 'Match the option by its value attribute.' },
            optionText: { type: 'string', description: 'Match the option by its visible text.' },
            optionIndex: { type: 'number', description: 'Match the option by its 0-based index.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    value: { type: 'string', required: true },
                    text: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: `Selected "${value.text}".` }],
        },
        timeoutMs,
        isConcurrencySafe: () => false, // mutates a field; exclusive within a task
        async execute(args, exec) {
            assertAllowed(state, 'browser_select');
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
            const target = args.target;
            const result = await browser.selectOption(session, {
                target: {
                    by: (target.by === 'text' || target.by === 'xpath' ? target.by : 'css'),
                    value: target.value,
                    ...target.index !== undefined ? { index: target.index } : {},
                },
                ...args.optionValue !== undefined ? { optionValue: args.optionValue } : {},
                ...args.optionText !== undefined ? { optionText: args.optionText } : {},
                ...args.optionIndex !== undefined ? { optionIndex: args.optionIndex } : {},
            }, exec.signal);
            return { value: result.value, text: result.text };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_clear',
        description: 'Clear an input/textarea/contenteditable, or uncheck a checkbox/radio, located by css/text/xpath.',
        parameters: {
            target: targetParam,
        },
        output: {
            schema: { type: 'object', additionalProperties: false, properties: { cleared: { type: 'boolean', required: true } } },
            render: (_args, value) => [{ type: 'text', text: value.cleared ? 'Cleared.' : 'Failed.' }],
        },
        timeoutMs,
        isConcurrencySafe: () => false, // mutates a field; exclusive within a task
        async execute(args, exec) {
            assertAllowed(state, 'browser_clear');
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
            const target = args.target;
            await browser.clearField(session, {
                target: {
                    by: (target.by === 'text' || target.by === 'xpath' ? target.by : 'css'),
                    value: target.value,
                    ...target.index !== undefined ? { index: target.index } : {},
                },
            }, exec.signal);
            return { cleared: true };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_get_value',
        description: 'Read the current value of one input/textarea/select/contenteditable, located by css/text/xpath. Use to VERIFY that a fill worked (e.g. before submitting).',
        parameters: {
            target: targetParam,
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    value: { type: 'string' },
                    checked: { type: 'boolean', description: 'For checkbox/radio.' },
                    selectedText: { type: 'string', description: 'For <select>.', },
                },
            },
            render: (_args, value) => [{ type: 'text', text: (() => {
                        if (value.checked !== undefined)
                            return `checked=${value.checked}`;
                        if (value.selectedText !== undefined)
                            return `selected: ${value.selectedText}`;
                        return `value: ${value.value ?? '(none)'}`;
                    })() }],
        },
        timeoutMs,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            assertAllowed(state, 'browser_get_value');
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
            const target = args.target;
            const result = await browser.getValue(session, {
                target: {
                    by: (target.by === 'text' || target.by === 'xpath' ? target.by : 'css'),
                    value: target.value,
                    ...target.index !== undefined ? { index: target.index } : {},
                },
            }, exec.signal);
            return {
                ...result.value !== null ? { value: result.value } : {},
                ...result.checked !== undefined ? { checked: result.checked } : {},
                ...result.selectedText !== undefined ? { selectedText: result.selectedText } : {},
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_screenshot',
        description: 'Capture the current shared-browser page as a screenshot (PNG default, JPEG optional). Use for visual confirmation of layout, charts, designs, or CAPTCHAs, or to feed a vision tool (read_image) that locates elements visually. Supports full-page capture, save-to-file, JPEG encoding, and downscaling (maxWidth/maxHeight) to cut vision-tool token cost. JPEG is only available on the self-hosted native path; the desktop-shell path returns PNG.',
        parameters: {
            fullPage: { type: 'boolean', description: 'Capture the full scrollable page instead of the viewport (default false).' },
            savePath: { type: 'string', description: 'Absolute file path to also save the image to (e.g. for read_image vision location).' },
            format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format (default png; jpeg is self-hosted native path only).' },
            quality: { type: 'number', description: 'JPEG quality 1-100 (default 80); ignored for PNG.' },
            maxWidth: { type: 'number', description: 'Downscale to fit within this width (aspect preserved).' },
            maxHeight: { type: 'number', description: 'Downscale to fit within this height (aspect preserved).' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    dataUrl: { type: 'string', required: true, description: 'Base64 PNG data URL of the screenshot.' },
                    path: { type: 'string', description: 'The file path the screenshot was saved to, when savePath was given.' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: `Screenshot captured (${Math.round(value.dataUrl.length * 3 / 4 / 1024)} KiB)${value.path !== undefined ? ` saved to ${value.path}` : ''}.` }],
        },
        timeoutMs,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
            const shot = await browser.screenshot(session, {
                ...args.fullPage === true ? { fullPage: true } : {},
                ...args.savePath !== undefined ? { savePath: args.savePath } : {},
                ...args.format !== undefined ? { format: args.format } : {},
                ...args.quality !== undefined ? { quality: args.quality } : {},
                ...args.maxWidth !== undefined ? { maxWidth: args.maxWidth } : {},
                ...args.maxHeight !== undefined ? { maxHeight: args.maxHeight } : {},
            }, exec.signal);
            return {
                dataUrl: shot.dataUrl,
                ...shot.path !== undefined ? { path: shot.path } : {},
            };
        },
    }));
    if (config.tabTools !== false) {
        ctx.tools.register(defineTool({
            name: 'browser_list_tabs',
            description: 'List the shared-browser session\'s tabs with their URLs and which is active.',
            parameters: {},
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        tabs: {
                            type: 'array',
                            required: true,
                            items: {
                                type: 'object',
                                additionalProperties: false,
                                properties: {
                                    id: { type: 'string', required: true },
                                    url: { type: 'string', required: true },
                                    active: { type: 'boolean', required: true },
                                },
                            },
                        },
                    },
                },
                render: (_args, value) => [{
                        type: 'text',
                        text: value.tabs
                            .map(t => `${t.active ? '*' : ' '} ${t.id} ${t.url}`).join('\n'),
                    }],
            },
            timeoutMs,
            isConcurrencySafe: () => true,
            async execute(_args, exec) {
                const browser = ctx.get('browser');
                if (browser === undefined)
                    throw new Error('tool-browser: browser service unavailable');
                const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
                const tabs = await browser.listTabs(session);
                return { tabs: tabs.map(t => ({ id: t.id, url: t.url, active: t.active })) };
            },
        }));
        ctx.tools.register(defineTool({
            name: 'browser_switch_tab',
            description: 'Switch the shared browser to a tab by id (from browser_list_tabs).',
            parameters: {
                tabId: { type: 'string', required: true, description: 'The tab id to switch to.' },
            },
            output: {
                schema: { type: 'object', additionalProperties: false, properties: { switched: { type: 'boolean', required: true } } },
                render: (_args, value) => [{ type: 'text', text: value.switched ? 'Switched.' : 'Tab not found.' }],
            },
            timeoutMs,
            isConcurrencySafe: () => false, // mutates the active tab; exclusive within a task
            async execute(args, exec) {
                assertAllowed(state, 'browser_switch_tab');
                const browser = ctx.get('browser');
                if (browser === undefined)
                    throw new Error('tool-browser: browser service unavailable');
                const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
                await browser.switchTab(session, args.tabId);
                return { switched: true };
            },
        }));
        ctx.tools.register(defineTool({
            name: 'browser_close_tab',
            description: 'Close a tab in the shared browser by id. Closing the active tab activates the next.',
            parameters: {
                tabId: { type: 'string', required: true, description: 'The tab id to close.' },
            },
            output: {
                schema: { type: 'object', additionalProperties: false, properties: { closed: { type: 'boolean', required: true } } },
                render: (_args, value) => [{ type: 'text', text: value.closed ? 'Closed.' : 'Tab not found.' }],
            },
            timeoutMs,
            isConcurrencySafe: () => false, // mutates the tab list; exclusive within a task
            async execute(args, exec) {
                assertAllowed(state, 'browser_close_tab');
                const browser = ctx.get('browser');
                if (browser === undefined)
                    throw new Error('tool-browser: browser service unavailable');
                const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
                await browser.closeTab(session, args.tabId);
                return { closed: true };
            },
        }));
        ctx.tools.register(defineTool({
            name: 'browser_reset',
            description: 'Close every tab in the shared browser and start fresh with one blank tab.',
            parameters: {},
            output: {
                schema: { type: 'object', additionalProperties: false, properties: { reset: { type: 'boolean', required: true } } },
                render: (_args, value) => [{ type: 'text', text: value.reset ? 'Browser reset.' : 'Failed.' }],
            },
            timeoutMs,
            isConcurrencySafe: () => false, // closes every tab; exclusive within a task
            async execute(_args, exec) {
                assertAllowed(state, 'browser_reset');
                const browser = ctx.get('browser');
                if (browser === undefined)
                    throw new Error('tool-browser: browser service unavailable');
                const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
                await browser.reset(session);
                return { reset: true };
            },
        }));
    }
    ctx.tools.register(defineTool({
        name: 'browser_history',
        description: 'List the shared browser session\'s recorded operation history (navigate/execute/click/type), newest last, with per-step success/error. Use to understand what the agent did and to pick a step to replay.',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    entries: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                seq: { type: 'number', required: true },
                                action: { type: 'string', required: true },
                                ok: { type: 'boolean', required: true },
                                params: { type: 'object', additionalProperties: true, required: true },
                                result: { type: 'string' },
                                error: { type: 'string' },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => {
                const entries = value.entries;
                if (entries.length === 0)
                    return [{ type: 'text', text: '(no recorded operations yet)' }];
                return [{
                        type: 'text',
                        text: entries.map(e => {
                            const rawParams = JSON.stringify(e.params);
                            const shownParams = rawParams.length > 300 ? rawParams.slice(0, 300) + '…' : rawParams;
                            return `#${e.seq} ${e.action} ${e.ok ? 'ok' : 'FAIL'} ${shownParams}${e.result !== undefined ? ` -> ${e.result}` : ''}${e.error !== undefined ? ` !! ${e.error}` : ''}`;
                        }).join('\n'),
                    }];
            },
        },
        timeoutMs,
        isConcurrencySafe: () => true,
        async execute(_args, exec) {
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
            const entries = await browser.history(session);
            const rendered = entries.map(e => {
                const params = JSON.parse(JSON.stringify(e.params));
                // Typed text / set values (possibly passwords) are kept verbatim in
                // the provider's history so replay can re-issue them, but must not be
                // echoed back to the model: mask them in the tool output, preserving
                // the length.
                if (e.action === 'type' && typeof params.text === 'string') {
                    params.text = '*'.repeat(Math.min(params.text.length, 64)) + ` (${params.text.length} chars)`;
                }
                if (e.action === 'setValue' && typeof params.value === 'string') {
                    params.value = '*'.repeat(Math.min(params.value.length, 64)) + ` (${params.value.length} chars)`;
                }
                // Replay of type/setValue carries the same sensitive fields.
                if (e.action === 'replay' && params.of === 'type' && typeof params.text === 'string') {
                    params.text = '*'.repeat(Math.min(params.text.length, 64)) + ` (${params.text.length} chars)`;
                }
                if (e.action === 'replay' && params.of === 'setValue' && typeof params.value === 'string') {
                    params.value = '*'.repeat(Math.min(params.value.length, 64)) + ` (${params.value.length} chars)`;
                }
                // Execute scripts may embed form tokens / credentials; mask script,
                // args, and result for both direct execute and replay-of-execute.
                const isExecute = e.action === 'execute' || (e.action === 'replay' && params.of === 'execute');
                if (isExecute) {
                    if (typeof params.script === 'string') {
                        params.script = `/* ${params.script.length} chars redacted */`;
                    }
                    if (Array.isArray(params.args)) {
                        params.args = params.args.map(() => '***');
                    }
                }
                const row = {
                    seq: e.seq,
                    action: e.action,
                    ok: e.ok,
                    params,
                };
                if (isExecute && typeof e.result === 'string') {
                    row.result = `[${e.result.length} chars redacted]`;
                }
                else if (e.result !== undefined) {
                    row.result = e.result;
                }
                if (e.error !== undefined)
                    row.error = e.error;
                return row;
            });
            return { entries: rendered };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_replay',
        description: 'Replay one recorded browser operation by its history sequence number (from browser_history). Navigate/click/type are re-issued against the current page; execute re-runs its script. The replayed step is appended to history as a new entry.',
        parameters: {
            seq: { type: 'number', required: true, description: 'The history entry sequence number to replay.' },
        },
        output: {
            schema: { type: 'object', additionalProperties: false, properties: { replayed: { type: 'boolean', required: true } } },
            render: (_args, value) => [{ type: 'text', text: value.replayed ? 'Replayed.' : 'Replay failed.' }],
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            assertAllowed(state, 'browser_replay');
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
            await browser.replay(session, args.seq);
            return { replayed: true };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_download',
        description: 'Download a URL to a local file, keeping the browser session\'s cookies and login state. Use for fetching files behind authentication or from the current page context. Available on the self-hosted browser; the desktop shell delegates downloads to the real browser UI.',
        parameters: {
            url: { type: 'string', required: true, description: 'The URL to download.' },
            savePath: { type: 'string', required: true, description: 'Absolute path of the file to write.' },
        },
        output: {
            schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true } } },
            render: (_args, value) => [{ type: 'text', text: `Downloaded to ${value.path}.` }],
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            assertAllowed(state, 'browser_download');
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
            const result = await browser.download(session, { url: args.url, savePath: args.savePath }, exec.signal);
            return { path: result.path };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_session',
        description: 'Show THIS task\'s browser session: its id and open tabs. Each task (DSH session) has its own browser session, so this reflects what your task drives. The window is shared with the human and other tasks, but tab sets and history are isolated per task.',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    session: { type: 'string', required: true },
                    tabs: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                id: { type: 'string', required: true },
                                url: { type: 'string', required: true },
                                active: { type: 'boolean', required: true },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `Session ${value.session}\n${value.tabs.map(t => `${t.active ? '*' : ' '} ${t.id} ${t.url}`).join('\n')}`,
                }],
        },
        timeoutMs,
        isConcurrencySafe: () => true,
        async execute(_args, exec) {
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
            const tabs = await browser.listTabs(session);
            return { session, tabs: tabs.map(t => ({ id: t.id, url: t.url, active: t.active })) };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_reset_session',
        description: 'Reset THIS task\'s browser session: close it entirely so the next browser_* call starts a fresh session with one blank tab. Other tasks\' sessions are untouched. Use when a session is in a bad state or you want a clean slate.',
        parameters: {},
        output: {
            schema: { type: 'object', additionalProperties: false, properties: { reset: { type: 'boolean', required: true } } },
            render: (_args, value) => [{ type: 'text', text: value.reset ? 'This task\'s browser session was closed; the next call starts fresh.' : 'Failed.' }],
        },
        timeoutMs,
        isConcurrencySafe: () => false, // closes the whole session; exclusive within a task
        async execute(_args, exec) {
            assertAllowed(state, 'browser_reset_session');
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const key = taskKey(exec);
            const session = state.sessionsByTask.get(key);
            if (session !== undefined) {
                try {
                    await browser.close(session);
                }
                finally {
                    // Always forget the mapping so the next call opens a fresh session,
                    // even if the provider close threw (the session is half-closed).
                    state.sessionsByTask.delete(key);
                }
            }
            return { reset: true };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_restrict',
        description: 'Restrict which browser actions are allowed, to prevent stray clicks/navigation. Pass a list of browser tool names (e.g. ["browser_snapshot","browser_content","browser_click"]) — any other browser_* call is refused. Pass an empty list or omit to lift the restriction. Read-only tools (snapshot/content/screenshot/session) are never blocked. IMPORTANT: this is a SOFT guardrail against accidental actions, NOT a security boundary — you (the model) can lift it yourself with an empty list.',
        parameters: {
            allowed: {
                type: 'array',
                items: { type: 'string' },
                description: 'Allow-list of browser tool names; empty clears the restriction.',
            },
        },
        output: {
            schema: { type: 'object', additionalProperties: false, properties: { restrictedTo: { type: 'array', required: true, items: { type: 'string' } } } },
            render: (_args, value) => [{ type: 'text', text: value.restrictedTo.length > 0 ? `Restricted to: ${value.restrictedTo.join(', ')}` : 'Restriction lifted.' }],
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            // Always allowed so the guard can be lifted.
            const allowed = args.allowed ?? [];
            const unknown = allowed.filter((t) => !t.startsWith('browser_'));
            if (unknown.length > 0) {
                throw new Error(`browser_restrict: unknown tool name(s) ${unknown.map(t => `"${t}"`).join(', ')} (must start with "browser_")`);
            }
            // Empty list (or omitted) lifts the restriction; a non-empty list is the
            // new allow-list. Scoped to this plugin apply (this Cordis context).
            // In DSH each agent has its own context, so the restriction never leaks
            // between tasks.
            state.restrictedTo = allowed.length === 0 ? undefined : [...allowed];
            return { restrictedTo: state.restrictedTo === undefined ? [] : [...state.restrictedTo] };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_auth',
        description: 'Export or restore the browser session\'s cookies (login state). Use "flush" to get a JSON cookie list (save it to a private file to persist logins), or "restore" with that list to put logins back (e.g. after the browser host restarted). Available on the self-hosted browser. Exported cookies are LIVE CREDENTIALS: treat them as secrets — do not echo them into the conversation, keep them out of logs, and store the list in a private file.',
        parameters: {
            action: { type: 'string', required: true, enum: ['flush', 'restore'], description: 'flush = export cookies; restore = import cookies.' },
            cookies: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Cookie list to restore (required when action=restore).' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    cookies: { type: 'array', items: { type: 'object', additionalProperties: true } },
                    restored: { type: 'number' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.cookies !== undefined ? `Exported ${value.cookies.length} cookies — LIVE CREDENTIALS; store privately and never echo them.` : `Restored ${value.restored} cookies.` }],
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            assertAllowed(state, 'browser_auth');
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec));
            if (args.action === 'flush') {
                const cookies = await browser.flushAuth(session);
                return { cookies: cookies.map(c => ({ ...c })) };
            }
            const list = (args.cookies ?? []);
            const restored = await browser.restoreAuth(session, list);
            return { restored };
        },
    }));
}
/** Test hook: inspect and reset session mappings across every live plugin apply. */
export const internals = {
    /** A copy of every live apply's per-task session map (task key -> provider session id). */
    get sessions() {
        const merged = new Map();
        for (const state of liveStates) {
            for (const [key, session] of state.sessionsByTask)
                merged.set(key, session);
        }
        return merged;
    },
    /** Drop one task's mapping (across live applies) without closing the provider session. */
    clearSession(key = 'default') {
        for (const state of liveStates)
            state.sessionsByTask.delete(key);
    },
};
