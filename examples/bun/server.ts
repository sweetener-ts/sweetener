import { showcase } from "../macro-suite/showcase.sts";

export function page(): string {
  const cards = showcase.cards
    .map(
      (card) =>
        `<article><small>${card.kind}</small><h2>${card.name}</h2><p>${card.result}</p></article>`,
    )
    .join("");
  return `<!doctype html><html><head><title>${showcase.title}</title><link rel="stylesheet" href="/theme.css"></head><body><main><h1>${showcase.title}</h1><p>${showcase.subtitle}</p><p class="hero">${showcase.hero}</p><section class="grid">${cards}</section></main></body></html>`;
}

if (import.meta.main) {
  const server = Bun.serve({
    port: Number(Bun.env.PORT ?? 3000),
    routes: {
      "/": new Response(page(), { headers: { "content-type": "text/html" } }),
      "/theme.css": new Response(
        await Bun.file(
          new URL("../macro-suite/theme.css", import.meta.url),
        ).text(),
        { headers: { "content-type": "text/css" } },
      ),
    },
  });
  console.log(`Sweetener + Bun: ${server.url.href}`);
}
