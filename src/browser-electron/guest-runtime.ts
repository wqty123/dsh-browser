import { guestReferenceHandlerScript } from '../browser-reference/page-script.ts'
import { guestStorageScript, type GuestStorageConfig } from './guest-storage-runtime.ts'
import { guestCssRuntimeScript } from './guest-css-runtime.ts'

/** Early, self-contained interception for documents served from the guest proxy. */
export function guestRuntimeScript(pageUrl: string, storage?: GuestStorageConfig, referrerPolicy = ''): string {
  return `(() => {
  if (window.__dshGuestRuntime) return;
  window.__dshGuestRuntime = true;
  let real = ${JSON.stringify(pageUrl).replace(/</gu, '\\u003c')};
  const route = '/dsh-builtin-browser/browser-view/isolated-guest';
  const attempt = fn => { try { return fn(); } catch {} };
  attempt(() => {
    const cache = { match: async () => undefined, matchAll: async () => [], keys: async () => [],
      add: async () => {}, addAll: async () => {}, put: async () => {}, delete: async () => false };
    const caches = { open: async () => cache, match: async () => undefined, has: async () => false,
      delete: async () => false, keys: async () => [] };
    Object.defineProperty(window, 'caches', { configurable: true, enumerable: true, get: () => caches });
  });
  ${storage === undefined ? '' : 'attempt(() => { ' + guestStorageScript(storage) + ' });'}
  const storageContext = ${JSON.stringify(storage?.context ?? '')};
  const contextual = value => {
    if (!storageContext) return value;
    const url = new URL(value, location.href);
    url.searchParams.set('storage-context', storageContext);
    return value.startsWith('/') ? url.pathname + url.search + url.hash : url.href;
  };
  const realURL = value => {
    const raw = String(value);
    const proxyURL = new URL(raw, location.origin + '/');
    if (proxyURL.origin === location.origin && proxyURL.pathname === route) {
      const inner = proxyURL.searchParams.get('u');
      if (inner) return new URL(inner);
    }
    const own = raw === '' || /^[?#]/.test(raw) ? undefined : new URL(raw, location.href);
    if (own && own.origin === location.origin && own.pathname === route && !own.searchParams.has('u')) {
      const url = new URL(real);
      url.search = own.search;
      url.hash = own.hash;
      return url;
    }
    let url = new URL(raw, real);
    if (url.origin === location.origin) {
      url = new URL(url.pathname + url.search + url.hash, new URL(real).origin);
    }
    return url;
  };
  const toProxy = value => {
    try {
      const raw = String(value);
      const hostURL = new URL(raw, location.origin + '/');
      if (hostURL.origin === location.origin && hostURL.pathname === route) return contextual(raw);
      const url = realURL(raw);
      return /^https?:$/.test(url.protocol) ? contextual(route + '?u=' + encodeURIComponent(url.href)) : raw;
    } catch { return value; }
  };
  window.__dshGuestToProxy = toProxy;
  const policies = ['no-referrer', 'no-referrer-when-downgrade', 'origin', 'origin-when-cross-origin', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin', 'unsafe-url'];
  const referrerPolicy = override => {
    if (policies.includes(override)) return override;
    const metas = attempt(() => [...document.querySelectorAll('meta[name="referrer" i]')]) || [];
    const last = value => String(value || '').split(',').map(item => item.trim().toLowerCase()).reverse().find(item => policies.includes(item));
    for (const meta of metas.reverse()) {
      const token = last(meta.content);
      if (token) return token;
    }
    return last(${JSON.stringify(referrerPolicy).replace(/</gu, '\\u003c')}) || '';
  };
  const requestInit = ['body', 'cache', 'credentials', 'duplex', 'headers', 'integrity', 'keepalive', 'method', 'mode', 'priority', 'redirect', 'referrer', 'referrerPolicy', 'signal', 'window'];
  const refererHeaders = (set, override) => {
    set('x-dsh-guest-referer', real);
    const policy = referrerPolicy(override);
    if (policy) set('x-dsh-guest-referrer-policy', policy);
  };
  const nativeFetch = window.fetch && window.fetch.bind(window);
  window.__dshGuestFetch = nativeFetch;
  attempt(() => {
    window.fetch = (input, init) => {
      try {
        const isRequest = input instanceof Request;
        const url = toProxy(isRequest ? input.url : input);
        if (!/^https?:$/.test(new URL(url, location.href).protocol)) return nativeFetch(input, init);
        const headers = new Headers(init && init.headers || (isRequest ? input.headers : undefined));
        headers.set('x-dsh-guest-headers', [...headers.keys()].filter(name => !name.startsWith('x-dsh-')).join(','));
        headers.set('x-dsh-guest-sub', '1');
        const source = init && requestInit.some(name => init[name] !== undefined) ? init : isRequest ? input : {};
        refererHeaders((name, value) => headers.set(name, value), source.referrer === '' ? 'no-referrer' : source.referrerPolicy || '');
        const options = Object.assign({}, init, { headers, mode: 'cors', credentials: 'omit' });
        return nativeFetch(isRequest ? new Request(new URL(url, location.href), input) : url, options);
      } catch (error) { return Promise.reject(error); }
    };
  });
  attempt(() => {
    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;
    const header = XMLHttpRequest.prototype.setRequestHeader;
    const names = new WeakMap();
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
      const result = open.call(this, method, toProxy(url), ...args);
      names.set(this, new Set());
      attempt(() => this.setRequestHeader('x-dsh-guest-sub', '1'));
      attempt(() => refererHeaders((name, value) => this.setRequestHeader(name, value)));
      return result;
    };
    XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
      const result = header.call(this, name, value);
      const key = String(name).toLowerCase();
      if (!key.startsWith('x-dsh-')) names.get(this)?.add(key);
      return result;
    };
    XMLHttpRequest.prototype.send = function(...args) {
      this.withCredentials = false;
      header.call(this, 'x-dsh-guest-headers', [...(names.get(this) || [])].join(','));
      return send.apply(this, args);
    };
  });
  attempt(() => {
    navigator.sendBeacon = (url, data) => {
      try {
        const headers = { 'x-dsh-guest-sub': '1' };
        refererHeaders((name, value) => { headers[name] = value; });
        nativeFetch(toProxy(url), { method: 'POST', body: data, keepalive: true, headers }).catch(() => {});
        return true;
      } catch { return false; }
    };
  });
  let childRequestId = 0;
  const childError = code => {
    const error = new Error(code + ': this sidebar supports URL-only tabs, not native child windows or opener relationships');
    error.name = 'NotSupportedError'; error.code = code;
    return error;
  };
  const childRequest = (mode, url) => {
    if (loadId === undefined) throw childError('sidebar-tab-owner-not-ready');
    parent.postMessage({ type: 'dsh.browser.guest.child.request', loadId, requestId: ++childRequestId, mode, url }, '*');
  };
  const nativeChild = url => {
    attempt(() => childRequest('native-opener', url));
    throw childError('BROWSER_NATIVE_CHILD_UNAVAILABLE');
  };
  const detached = features => String(features || '').split(',').some(feature => {
    const [key, value] = feature.trim().toLowerCase().split(/\\s*=\\s*/);
    return ['noopener', 'noreferrer'].includes(key) && !['0', 'no', 'false'].includes(value);
  });
  attempt(() => { window.open = (url, target = '_blank', features = '') => {
    const name = String(target || '_blank').toLowerCase();
    if (name !== '_self' && (name !== '_blank' || !detached(features))) return nativeChild(String(url || ''));
    const next = realURL(url == null || String(url) === '' ? 'about:blank' : url);
    if (!/^https?:$/.test(next.protocol)) throw childError('invalid-child-url');
    if (name === '_self') { location.assign(toProxy(next.href)); return window; }
    childRequest('url-only', next.href);
    return null;
  }; });
  for (const name of ['pushState', 'replaceState']) attempt(() => {
    const original = history[name];
    const reason = name === 'pushState' ? 'push' : 'replace';
    history[name] = function(state, title, url) {
      if (url == null) {
        const result = original.call(this, state, title, url);
        if (name === 'pushState') report(reason);
        return result;
      }
      const next = attempt(() => realURL(url));
      const result = original.call(this, state, title, toProxy(url));
      if (next && /^https?:$/.test(next.protocol)) real = next.href;
      report(reason);
      return result;
    };
  });
  let loadId;
  const documentId = String(Date.now()) + ':' + String(Math.random());
  let referenceRequestId = 0;
  const reference = ${guestReferenceHandlerScript()};
  const navType = () => {
    const entry = attempt(() => performance.getEntriesByType && performance.getEntriesByType('navigation')[0]);
    return entry && typeof entry.type === 'string' ? entry.type : undefined;
  };
  const report = (reason) => attempt(() => {
    const navigationType = navType();
    parent.postMessage({
      type: 'dsh.browser.guest.navigation',
      url: real,
      depth: history.length,
      loadId,
      documentId,
      ready: document.readyState !== 'loading',
      ...(typeof reason === 'string' && reason ? { reason } : {}),
      ...(navigationType ? { navigationType } : {}),
    }, '*');
  });
  attempt(() => window.addEventListener('message', event => {
    if (event.source !== parent || !event.data) return;
    if (event.data.type === 'dsh.browser.guest.navigation.request') {
      if (!Number.isSafeInteger(event.data.loadId) || event.data.loadId <= 0) return;
      loadId = event.data.loadId;
      report('sync');
    } else if (event.data.type === 'dsh.browser.guest.reference.request') {
      const data = event.data;
      if (event.origin !== location.origin || data.loadId !== loadId || loadId === undefined || data.documentId !== documentId
        || !Number.isSafeInteger(data.requestId) || data.requestId <= referenceRequestId) return;
      referenceRequestId = data.requestId;
      const ack = { type: 'dsh.browser.guest.reference.ack', requestId: data.requestId, loadId, documentId, url: real };
      try {
        const current = new URL(real), source = new URL(data.url);
        current.hash = ''; source.hash = '';
        if (current.href !== source.href || document.readyState === 'loading') throw new Error('source document is not ready');
        if (!data.spec || typeof data.spec !== 'object' || Array.isArray(data.spec) || !['text', 'highlight', 'element', 'summary'].includes(data.operation)) throw new Error('invalid reference command');
        if (data.operation !== 'element' && (!Number.isSafeInteger(data.spec.maxChars) || data.spec.maxChars <= 0
          || data.spec.maxChars > 2000000 || typeof data.spec.legacy !== 'boolean')) throw new Error('invalid text specification');
        if (data.operation === 'element' && (!['image', 'table'].includes(data.spec.kind)
          || !data.spec.anchor || typeof data.spec.anchor !== 'object' || Array.isArray(data.spec.anchor))) throw new Error('invalid element specification');
        if (data.operation === 'highlight' && (!Number.isSafeInteger(data.spec.start) || !Number.isSafeInteger(data.spec.end)
          || data.spec.start < 0 || data.spec.end <= data.spec.start)) throw new Error('invalid text positions');
        const value = data.operation === 'summary'
          ? { url: real, title: String(document.title || '').slice(0, 1000), snapshotHint: reference('text', { maxChars: 1500, legacy: false }).text, fresh: true }
          : reference(data.operation, data.spec);
        parent.postMessage({ ...ack, ok: true, value }, event.origin);
      } catch (error) { parent.postMessage({ ...ack, ok: false, reason: String(error).slice(0, 200) }, event.origin); }
    } else if (event.data.type === 'dsh.browser.guest.history') {
      if (event.data.delta === -1) history.back();
      else if (event.data.delta === 1) history.forward();
    }
  }));
  attempt(() => window.addEventListener('DOMContentLoaded', () => report('ready')));
  attempt(() => window.addEventListener('pageshow', event => { if (event && event.persisted) report('pageshow'); }));
  attempt(() => window.addEventListener('popstate', () => {
    const next = attempt(() => realURL(location.href));
    if (next) real = next.href;
    report('pop');
  }));
  attempt(() => {
    const proxyResource = value => {
      if (/^(#|data:|blob:|about:|javascript:)/i.test(value.trim())) return value;
      return toProxy(value);
    };
    ${guestCssRuntimeScript()}
    const proxySrcset = value => {
      let result = '', position = 0;
      while (position < value.length) {
        const start = position;
        while (position < value.length && /[\\s,]/.test(value[position])) position++;
        result += value.slice(start, position);
        if (position === value.length) break;
        const urlStart = position;
        while (position < value.length && !/\\s/.test(value[position])) position++;
        let urlEnd = position;
        while (urlEnd > urlStart && value[urlEnd - 1] === ',') urlEnd--;
        result += proxyResource(value.slice(urlStart, urlEnd)) + value.slice(urlEnd, position);
        if (urlEnd < position) continue;
        const descriptors = position;
        while (position < value.length && value[position] !== ',') position++;
        result += value.slice(descriptors, position);
      }
      return result;
    };
    const resourceAttribute = (name, value) => name.toLowerCase() === 'style' ? proxyCss(value)
      : name.toLowerCase() === 'srcset' ? proxySrcset(String(value)) : proxyResource(String(value));
    const set = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
      if (this.tagName === 'LINK' && /^integrity$/i.test(name)) {
        this.removeAttribute('integrity');
        return;
      }
      return set.call(this, name, /^(src|href|action|poster|srcset|style)$/i.test(name) ? resourceAttribute(name, value) : value);
    };
    for (const [name, prop] of [['HTMLImageElement', 'src'], ['HTMLScriptElement', 'src'],
      ['HTMLIFrameElement', 'src'], ['HTMLLinkElement', 'href'], ['HTMLSourceElement', 'src'],
      ['HTMLImageElement', 'srcset'], ['HTMLSourceElement', 'srcset'], ['HTMLVideoElement', 'poster']]) attempt(() => {
      const proto = window[name].prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
      if (!descriptor || !descriptor.set) return;
      Object.defineProperty(proto, prop, Object.assign({}, descriptor, {
        set(value) { descriptor.set.call(this, resourceAttribute(prop, value)); }
      }));
    });
    const rewriteResource = node => {
      if (!node || node.nodeType !== 1) return;
      if (node.tagName === 'LINK' && node.hasAttribute('integrity')) node.removeAttribute('integrity');
      rewriteStyleText(node);
      const attributes = /^(A|FORM)$/.test(node.tagName) ? ['style'] : ['src', 'href', 'srcset', 'poster', 'style'];
      for (const attribute of attributes) attempt(() => {
        const value = node.getAttribute(attribute);
        if (!value || !value.trim()) return;
        const next = resourceAttribute(attribute, value);
        if (next !== value) node.setAttribute(attribute, next);
      });
    };
    const rewriteTree = node => {
      rewriteResource(node);
      if (node && node.querySelectorAll) {
        for (const descendant of node.querySelectorAll('[src],[href],[srcset],[poster],[style],[integrity],style')) rewriteResource(descendant);
      }
    };
    for (const name of ['Node', 'Element', 'Document', 'DocumentFragment']) {
      for (const method of ['appendChild', 'insertBefore', 'replaceChild', 'append', 'prepend', 'before', 'after', 'replaceWith', 'replaceChildren', 'insertAdjacentElement']) attempt(() => {
        const proto = window[name].prototype;
        if (!Object.prototype.hasOwnProperty.call(proto, method)) return;
        const original = proto[method];
        proto[method] = function(...args) {
          if (isStyle(this)) args = args.map(value => {
            if (typeof value === 'string') return proxyCss(value);
            if (value && value.nodeType === 3) value.textContent = proxyCss(value.textContent);
            return value;
          });
          for (const node of args) if (node && typeof node === 'object') rewriteTree(node);
          return original.apply(this, args);
        };
      });
    }
    const html = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    let inert;
    const rewriteMarkup = (value, context) => {
      if (!inert) inert = document.implementation.createHTMLDocument('');
      const container = context && context.nodeType === 1
        ? inert.createElementNS(context.namespaceURI, context.localName) : inert.createElement('div');
      html.set.call(container, value);
      rewriteTree(container.content || container);
      return html.get.call(container);
    };
    for (const prop of ['innerHTML', 'outerHTML']) attempt(() => {
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, prop);
      Object.defineProperty(Element.prototype, prop, Object.assign({}, descriptor, {
        set(value) { descriptor.set.call(this, rewriteMarkup(value, prop === 'innerHTML' ? this : this.parentElement)); }
      }));
    });
    attempt(() => {
      const original = Element.prototype.insertAdjacentHTML;
      Element.prototype.insertAdjacentHTML = function(position, value) {
        const outside = /^(beforebegin|afterend)$/i.test(position);
        return original.call(this, position, rewriteMarkup(value, outside ? this.parentElement : this));
      };
    });
    attempt(() => {
      const original = window.Range.prototype.createContextualFragment;
      window.Range.prototype.createContextualFragment = function(value) {
        const context = this.startContainer.nodeType === 1 ? this.startContainer : this.startContainer.parentElement;
        return original.call(this, rewriteMarkup(value, context));
      };
    });
    const observer = new MutationObserver(records => {
      for (const record of records) attempt(() => {
        if (record.type === 'attributes') rewriteResource(record.target);
        else if (record.type === 'characterData') rewriteStyleText(record.target.parentNode);
        else for (const node of record.addedNodes) rewriteTree(node);
      });
    });
    observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true,
      attributeFilter: ['src', 'href', 'srcset', 'poster', 'action', 'style', 'integrity'] });
    rewriteTree(document.documentElement);
  });
  attempt(() => document.addEventListener('click', event => {
    attempt(() => {
      let node = event.target;
      while (node && node.tagName !== 'A') node = node.parentNode;
      if (!node || !node.hasAttribute('href') || node.hasAttribute('download')) return;
      const href = node.getAttribute('href');
      const url = realURL(href);
      if (!/^https?:$/.test(url.protocol)) return;
      event.preventDefault();
      const target = (node.getAttribute('target') || '_self').toLowerCase();
      if (target !== '_self') {
        const opener = /(?:^|\\s)opener(?:\\s|$)/i.test(node.getAttribute('rel') || '');
        try { if (target !== '_blank' || opener) nativeChild(url.href); else childRequest('url-only', url.href); }
        catch (error) { console.error('[dsh-browser]', error); }
        return;
      }
      location.assign(toProxy(href));
    });
  }, true));
  const prepareForm = (form, submitter) => {
    const action = submitter && submitter.getAttribute('formaction') || form.getAttribute('action') || real;
    const method = (submitter && submitter.getAttribute('formmethod') || form.getAttribute('method') || 'GET').toUpperCase();
    const url = realURL(action);
    if (!/^https?:$/.test(url.protocol)) return false;
    const target = (submitter && submitter.getAttribute('formtarget') || form.getAttribute('target') || '_self').toLowerCase();
    if (target !== '_self' && (target !== '_blank' || method !== 'GET'
      || /(?:^|\\s)opener(?:\\s|$)/i.test(form.getAttribute('rel') || ''))) {
      try { nativeChild(url.href); } catch (error) { console.error('[dsh-browser]', error); }
      return true;
    }
    if (method === 'GET') {
      const params = new URLSearchParams();
      const data = submitter ? new FormData(form, submitter) : new FormData(form);
      for (const [key, value] of data) params.append(key, typeof value === 'string' ? value : value.name);
      url.search = params.toString();
      if (target === '_blank') {
        try { childRequest('url-only', url.href); } catch (error) { console.error('[dsh-browser]', error); }
      } else location.assign(toProxy(url.href));
      return true;
    }
    form.setAttribute('action', toProxy(url.href));
    form.setAttribute('target', '_self');
    if (submitter && submitter.hasAttribute('formaction')) submitter.setAttribute('formaction', toProxy(url.href));
    if (submitter && submitter.hasAttribute('formtarget')) submitter.setAttribute('formtarget', '_self');
    return false;
  };
  attempt(() => document.addEventListener('submit', event => {
    attempt(() => { if (event.target && event.target.tagName === 'FORM' && prepareForm(event.target, event.submitter)) event.preventDefault(); });
  }, true));
  attempt(() => {
    const submit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function() {
      if (!attempt(() => prepareForm(this))) return submit.call(this);
    };
  });
})();`;
}
