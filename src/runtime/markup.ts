import { effect, type Signal } from "./signals.js";

/**
 * Markup produced by `<tag>` expressions and `view` components.
 *
 * In a browser `h()` builds real DOM nodes with fine-grained updates: every `{expression}` is a
 * thunk wrapped in an effect, so only the text or attribute that depends on a changed signal is
 * touched (no virtual DOM diffing). Without a DOM (Node, routes) it builds a light tree that
 * renders to an HTML string.
 */
export type Markup = VNode | { readonly nodeType: number };

export type Child = Markup | string | number | boolean | null | undefined | Child[] | (() => Child);

const VOID_ELEMENTS = new Set(["area", "br", "col", "hr", "img", "input", "link", "meta", "source", "wbr"]);

const dom = (): any => (globalThis as { document?: unknown }).document;

export class VNode {
  constructor(
    readonly tag: string,
    readonly attrs: Record<string, unknown>,
    readonly children: Child[],
  ) {}

  toString(): string {
    return renderVNode(this);
  }
}

export function h(tag: string, attrs: Record<string, unknown>, children: Child[] = []): Markup {
  const document = dom();
  if (!document) return new VNode(tag, attrs, children);
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (name.startsWith("on:")) {
      el.addEventListener(name.slice(3), (event: unknown) => {
        const result = (value as (e: unknown) => unknown)(event);
        if (result instanceof Promise) result.catch((e) => console.error(e));
      });
    } else if (name.startsWith("bind:")) {
      bind(el, name.slice(5), value as Signal<unknown>);
    } else if (typeof value === "function") {
      effect(() => setAttribute(el, name, (value as () => unknown)()));
    } else {
      setAttribute(el, name, value);
    }
  }
  for (const child of children) append(el, child);
  return el;
}

function bind(el: any, prop: string, sig: Signal<unknown>): void {
  effect(() => {
    const v = sig.value;
    if (el[prop] !== v) el[prop] = v ?? "";
  });
  el.addEventListener(prop === "checked" ? "change" : "input", () => {
    const raw = el[prop];
    sig.value = prop === "value" && (el.type === "number" || el.type === "range") ? Number(raw) : raw;
  });
}

function setAttribute(el: any, name: string, value: unknown): void {
  if (name === "value" || name === "checked") el[name] = value;
  else if (value === false || value === null || value === undefined) el.removeAttribute(name);
  else el.setAttribute(name, value === true ? "" : String(value));
}

function append(parent: any, child: Child): void {
  if (typeof child === "function") {
    // A dynamic region between two anchors, replaced whenever the thunk's signals change.
    const document = dom();
    const start = document.createTextNode("");
    const end = document.createTextNode("");
    parent.append(start, end);
    effect(() => {
      const value = (child as () => Child)();
      while (start.nextSibling && start.nextSibling !== end) start.nextSibling.remove();
      const fragment = document.createDocumentFragment();
      append(fragment, value);
      end.before(fragment);
    });
    return;
  }
  if (Array.isArray(child)) {
    for (const c of child) append(parent, c);
    return;
  }
  if (child === null || child === undefined || typeof child === "boolean") return;
  if (typeof child === "object") {
    parent.append(child);
    return;
  }
  parent.append(dom().createTextNode(String(child)));
}

/** Attach markup to the page (`target` is a CSS selector or element). Without a DOM, prints its HTML. */
export function mount(markup: Markup, target?: unknown): void {
  const document = dom();
  if (!document) {
    console.log(renderToString(markup));
    return;
  }
  const host =
    typeof target === "string"
      ? document.querySelector(target)
      : (target ?? (globalThis as { MK_MOUNT_TARGET?: unknown }).MK_MOUNT_TARGET ?? document.body);
  host.append(markup);
}

export function renderToString(markup: Child): string {
  if (markup instanceof VNode) return renderVNode(markup);
  if (typeof markup === "function") return renderToString((markup as () => Child)());
  if (Array.isArray(markup)) return markup.map(renderToString).join("");
  if (markup === null || markup === undefined || typeof markup === "boolean") return "";
  if (typeof markup === "object") return (markup as { outerHTML?: string }).outerHTML ?? "";
  return escapeHtml(String(markup));
}

export function isMarkup(value: unknown): value is Markup {
  return value instanceof VNode || (typeof value === "object" && value !== null && typeof (value as { nodeType?: unknown }).nodeType === "number");
}

function renderVNode(node: VNode): string {
  let attrs = "";
  for (const [name, raw] of Object.entries(node.attrs)) {
    if (name.startsWith("on:")) continue;
    const key = name.startsWith("bind:") ? name.slice(5) : name;
    const value = name.startsWith("bind:") ? (raw as Signal<unknown>).value : typeof raw === "function" ? (raw as () => unknown)() : raw;
    if (value === false || value === null || value === undefined) continue;
    attrs += value === true ? ` ${key}` : ` ${key}="${escapeHtml(String(value))}"`;
  }
  if (VOID_ELEMENTS.has(node.tag)) return `<${node.tag}${attrs}>`;
  return `<${node.tag}${attrs}>${node.children.map(renderToString).join("")}</${node.tag}>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
