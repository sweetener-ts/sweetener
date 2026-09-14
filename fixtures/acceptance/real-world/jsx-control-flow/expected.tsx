
// The classic JSX transform calls these; nothing names them in the source.
import { Fragment, h, render } from "./jsx-runtime.js";

export type Item = { readonly id: string; readonly name: string };

void h;
void Fragment;

export const list = (items: readonly Item[], loading: boolean) => (
  <ul>
    {(loading) ?
      <li>loading</li>
     :
      <li>ready</li>
    }
    {(items.length === 0) ?
      <li>nothing here</li>
     : null}
    {(items).map(( item, index) =>
      <li key={item.id}>{index}: {item.name}</li>
    )}
  </ul>
);

export const rendered: readonly string[] = [
  render(list([{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }], false)),
  render(list([], true)),
];