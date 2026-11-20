/** Early, self-contained interception for documents served from the guest proxy. */
export function guestRuntimeScript(pageUrl: string): string {
  return `(() => {
  if (window.__dshGuestRuntime) return;
  window.__dshGuestRuntime = true;
  let real = ${JSON.stringify(pageUrl).replace(/</gu, '\\u003c')};
  const route = '/dsh-builtin-browser/browser-view/guest';
  const attempt = fn => { try { return fn(); } catch {} };
  const realURL = value => {
    const raw = String(value);
    const proxyURL = new URL(raw, location.origin + '/');
    if (proxyURL.origin === location.origin && proxyURL.pathname === route) {
      const inner = proxyURL.searchParams.get('u');
      if (inner) return new URL(inner);
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
      if (hostURL.origin === location.origin && hostURL.pathname === route) return raw;
      const url = realURL(raw);
      return /^https?:$/.test(url.protocol) ? route + '?u=' + encodeURIComponent(url.href) : raw;
    } catch { return value; }
  };
  window.__dshGuestToProxy = toProxy;
  const nativeFetch = window.fetch && window.fetch.bind(window);
  window.__dshGuestFetch = nativeFetch;
  attempt(() => {
    window.fetch = (input, init) => {
      try {
        const isRequest = input instanceof Request;
        const url = toProxy(isRequest ? input.url : input);
        if (!/^https?:$/.test(new URL(url, location.href).protocol)) return nativeFetch(input, init);
        const headers = new Headers(init && init.headers || (isRequest ? input.headers : undefined));
        headers.set('x-dsh-guest-sub', '1');
        const options = Object.assign({}, init, { headers, mode: 'same-origin' });
        return nativeFetch(isRequest ? new Request(new URL(url, location.href), input) : url, options);
      } catch (error) { return Promise.reject(error); }
    };
  });
  attempt(() => {
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
      const result = open.call(this, method, toProxy(url), ...args);
      attempt(() => this.setRequestHeader('x-dsh-guest-sub', '1'));
      return result;
    };
  });
  attempt(() => {
    navigator.sendBeacon = (url, data) => {
      try {
        nativeFetch(toProxy(url), { method: 'POST', body: data, keepalive: true,
          headers: { 'x-dsh-guest-sub': '1' } }).catch(() => {});
        return true;
      } catch { return false; }
    };
  });
  attempt(() => { window.open = url => { attempt(() => location.assign(toProxy(url || real))); return window; }; });
  for (const name of ['pushState', 'replaceState']) attempt(() => {
    const original = history[name];
    history[name] = function(state, title, url) {
      if (url == null) return original.call(this, state, title, url);
      const next = attempt(() => realURL(url));
      const result = original.call(this, state, title, toProxy(url));
      if (next && /^https?:$/.test(next.protocol)) real = next.href;
      return result;
    };
  });
  attempt(() => window.addEventListener('popstate', () => {
    const next = attempt(() => realURL(location.href));
    if (next) real = next.href;
  }));
  attempt(() => {
    const set = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
      return set.call(this, name, /^(src|href|action)$/i.test(name) ? toProxy(value) : value);
    };
  });
  for (const [name, prop] of [['HTMLImageElement', 'src'], ['HTMLScriptElement', 'src'],
    ['HTMLIFrameElement', 'src'], ['HTMLLinkElement', 'href'], ['HTMLSourceElement', 'src']]) attempt(() => {
    const proto = window[name].prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
    if (!descriptor || !descriptor.set) return;
    Object.defineProperty(proto, prop, Object.assign({}, descriptor, {
      set(value) { descriptor.set.call(this, toProxy(value)); }
    }));
  });
  attempt(() => {
    const proxyResource = value => {
      if (/^(#|data:|blob:|about:|javascript:)/i.test(value.trim())) return value;
      return toProxy(value);
    };
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
    const rewriteResource = node => {
      if (!node || node.nodeType !== 1 || /^(A|FORM)$/.test(node.tagName)) return;
      for (const attribute of ['src', 'href', 'srcset', 'poster']) attempt(() => {
        const value = node.getAttribute(attribute);
        if (!value || !value.trim()) return;
        const next = attribute === 'srcset' ? proxySrcset(value) : proxyResource(value);
        if (next !== value) node.setAttribute(attribute, next);
      });
    };
    const rewriteTree = node => {
      rewriteResource(node);
      if (node && node.querySelectorAll) {
        for (const descendant of node.querySelectorAll('[src],[href],[srcset],[poster]')) rewriteResource(descendant);
      }
    };
    const observer = new MutationObserver(records => {
      for (const record of records) attempt(() => {
        if (record.type === 'attributes') rewriteResource(record.target);
        else for (const node of record.addedNodes) rewriteTree(node);
      });
    });
    observer.observe(document, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['src', 'href', 'srcset', 'poster', 'action'] });
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
      location.assign(toProxy(href));
    });
  }, true));
  const prepareForm = (form, submitter) => {
    const action = submitter && submitter.getAttribute('formaction') || form.getAttribute('action') || real;
    const method = (submitter && submitter.getAttribute('formmethod') || form.getAttribute('method') || 'GET').toUpperCase();
    const url = realURL(action);
    if (!/^https?:$/.test(url.protocol)) return false;
    if (method === 'GET') {
      const params = new URLSearchParams();
      const data = submitter ? new FormData(form, submitter) : new FormData(form);
      for (const [key, value] of data) params.append(key, typeof value === 'string' ? value : value.name);
      url.search = params.toString();
      location.assign(toProxy(url.href));
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
