export interface GuestStorageConfig { readonly token: string; readonly context: string }

/** Synchronous Web Storage remains isolated from the application's real origin. */
export function guestStorageScript(config: GuestStorageConfig): string {
  return `(() => {
    const config = ${JSON.stringify(config).replace(/</gu, '\\u003c')};
    const XHR = XMLHttpRequest, open = XHR.prototype.open, send = XHR.prototype.send, header = XHR.prototype.setRequestHeader;
    const endpoint = location.pathname + '?u=' + encodeURIComponent(real) + '&storage-token=' + encodeURIComponent(config.token);
    const rpc = (area, op, key, value) => {
      const xhr = new XHR();
      open.call(xhr, 'POST', endpoint, false);
      header.call(xhr, 'content-type', 'text/plain;charset=UTF-8');
      send.call(xhr, JSON.stringify({ area, op, key, value }));
      let response;
      try { response = JSON.parse(xhr.responseText); } catch { throw new DOMException('Guest storage is unavailable', 'UnknownError'); }
      if (xhr.status !== 200 || !response.ok) throw new DOMException('Guest storage request failed', response.name || 'UnknownError');
      return response.value;
    };
    for (const area of ['local', 'session']) {
      const storage = Object.create(Storage.prototype);
      const entries = () => rpc(area, 'entries');
      Object.defineProperties(storage, {
        getItem: { configurable: true, value: function(key) { if (!arguments.length) throw new TypeError('A key is required'); return rpc(area, 'get', String(key)); } },
        setItem: { configurable: true, value: function(key, value) { if (arguments.length < 2) throw new TypeError('A key and value are required'); rpc(area, 'set', String(key), String(value)); } },
        removeItem: { configurable: true, value: function(key) { if (!arguments.length) throw new TypeError('A key is required'); rpc(area, 'remove', String(key)); } },
        clear: { configurable: true, value: () => { rpc(area, 'clear'); } },
        key: { configurable: true, value: function(index) { if (!arguments.length) throw new TypeError('An index is required'); return entries()[Number(index) >>> 0]?.[0] ?? null; } },
        length: { configurable: true, get: () => entries().length }
      });
      const proxy = new Proxy(storage, {
        get: (target, key) => typeof key !== 'string' || key in target ? Reflect.get(target, key) : rpc(area, 'get', key) ?? undefined,
        set: (_, key, value) => { if (typeof key !== 'string') return false; rpc(area, 'set', key, String(value)); return true; },
        deleteProperty: (_, key) => { if (typeof key !== 'string') return false; rpc(area, 'remove', key); return true; },
        has: (target, key) => key in target || (typeof key === 'string' && rpc(area, 'get', key) !== null),
        ownKeys: target => [...Reflect.ownKeys(target), ...entries().map(pair => pair[0]).filter(key => !Object.hasOwn(target, key))],
        getOwnPropertyDescriptor: (target, key) => Object.getOwnPropertyDescriptor(target, key)
          || (typeof key === 'string' && rpc(area, 'get', key) !== null ? { configurable: true, enumerable: true, writable: true, value: rpc(area, 'get', key) } : undefined)
      });
      Object.defineProperty(window, area + 'Storage', { configurable: true, get: () => proxy });
    }
  })();`
}
