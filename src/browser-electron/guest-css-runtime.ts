import { rewriteCss } from './guest-css.ts'

export function guestCssRuntimeScript(): string {
  return `
    const cssBase = sheet => {
      for (let current = sheet; current; current = current.parentStyleSheet) {
        if (current.href) return realURL(current.href).href;
      }
      return document.baseURI ? realURL(document.baseURI).href : real;
    };
    const proxyCss = (value, base = cssBase()) => (${rewriteCss.toString()})(String(value), raw => {
      if (!raw.trim() || raw.trim().startsWith('#')) return undefined;
      try {
        const existing = new URL(raw, location.href);
        if (existing.origin === location.origin && existing.pathname === route) return undefined;
        const resolved = new URL(raw, base);
        return /^https?:$/.test(resolved.protocol) ? toProxy(resolved.href) : undefined;
      } catch { return undefined; }
    });
    const isStyle = node => node && node.nodeType === 1 && node.tagName === 'STYLE';
    const rewriteStyleText = node => {
      if (!isStyle(node)) return;
      const before = node.textContent, after = proxyCss(before);
      if (after !== before) node.textContent = after;
    };
    for (const [name, property] of [['Node', 'textContent'], ['Node', 'nodeValue'], ['CharacterData', 'data']]) attempt(() => {
      const proto = window[name].prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, property);
      if (!descriptor || !descriptor.set) return;
      Object.defineProperty(proto, property, Object.assign({}, descriptor, {
        set(value) {
          const css = isStyle(this) || (this.nodeType === 3 && isStyle(this.parentNode));
          descriptor.set.call(this, css && value != null ? proxyCss(value) : value);
        }
      }));
    });
    for (const name of ['CSSStyleSheet', 'CSSGroupingRule', 'CSSKeyframesRule']) attempt(() => {
      const proto = window[name].prototype;
      for (const method of ['insertRule', 'replace', 'replaceSync', 'appendRule', 'addRule']) {
        const original = proto[method];
        if (typeof original !== 'function') continue;
        proto[method] = function(...args) {
          const index = method === 'addRule' ? 1 : 0;
          if (args.length > index) args[index] = proxyCss(args[index], cssBase(this.parentStyleSheet || this));
          return original.apply(this, args);
        };
      }
    });
    attempt(() => {
      const proto = CSSStyleDeclaration.prototype, original = proto.setProperty;
      proto.setProperty = function(name, value, priority) {
        return original.call(this, name, value == null ? value : proxyCss(value, cssBase(this.parentRule?.parentStyleSheet)), priority);
      };
      for (const property of Object.getOwnPropertyNames(proto)) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, property);
        if (!descriptor?.set) continue;
        Object.defineProperty(proto, property, Object.assign({}, descriptor, {
          set(value) { descriptor.set.call(this, value == null ? value : proxyCss(value, cssBase(this.parentRule?.parentStyleSheet))); }
        }));
      }
    });
    for (const name of ['HTMLElement', 'SVGElement']) attempt(() => {
      const proto = window[name].prototype, descriptor = Object.getOwnPropertyDescriptor(proto, 'style');
      if (!descriptor?.set) return;
      Object.defineProperty(proto, 'style', Object.assign({}, descriptor, {
        set(value) { descriptor.set.call(this, value == null ? value : proxyCss(value)); }
      }));
    });
    attempt(() => {
      const original = Element.prototype.insertAdjacentText;
      Element.prototype.insertAdjacentText = function(position, value) {
        return original.call(this, position, isStyle(this) ? proxyCss(value) : value);
      };
    });
  `
}
