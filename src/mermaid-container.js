// Mermaid 11.17.2 scopes rendered DOM IDs with the render ID. The pinned
// converter still queries pre-scope IDs. Adapt only its temporary container's
// selectors, never the live DOM IDs, source identities, or saved scene IDs.
export function unscopedMermaidId(id, containerId) {
  const prefix = `${containerId.slice(0, -'-container'.length)}-`;
  return containerId.endsWith('-container') && id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

export function mermaidContainer(container, renderId) {
  if (!/^[\w-]+$/.test(renderId)) throw new Error('Unexpected Mermaid render ID');
  const prefix = `${renderId}-`;
  const scoped = selector => selector
    .replace(/\[id=(["'])(.*?)\1\]/g, (_match, quote, id) => `[id=${quote}${prefix}${id}${quote}]`)
    .replace(/\[id\^=(["'])(.*?)\1\]/g, (_match, quote, id) => `[id^=${quote}${prefix}${id}${quote}]`)
    .replace(/(^|[\s>,])#([\w-]+)/g, (_match, before, id) => `${before}#${prefix}${id}`);
  const one = container.querySelector.bind(container);
  const all = container.querySelectorAll.bind(container);
  // Keep container identity for the converter's parent/transform traversal.
  container.querySelector = selector => one(scoped(selector)) || one(selector);
  container.querySelectorAll = selector => {
    const result = all(scoped(selector));
    return result.length ? result : all(selector);
  };
  return container;
}
