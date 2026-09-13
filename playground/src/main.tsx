import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Home } from "./home";
import { Playground } from "./playground";
import "./site.css";

/**
 * Two views, addressed by the fragment so a link can point at either.
 *
 * `#/play/<example>` opens the playground on one example, which is what makes
 * an example worth linking to from anywhere else. `#/code/<payload>` opens a
 * project carried in the link itself; see share.ts.
 */
type Route =
  | { view: "home"; exampleId: ""; gistId: ""; sharedCode: "" }
  | { view: "play"; exampleId: string; gistId: ""; sharedCode: "" }
  | { view: "gist"; exampleId: ""; gistId: string; sharedCode: "" }
  | { view: "code"; exampleId: ""; gistId: ""; sharedCode: string };

export function route(hash: string): Route {
  const parts = hash.replace(/^#\/?/u, "").split("/").filter(Boolean);
  if (parts[0] === "play")
    return {
      view: "play",
      exampleId: parts[1] ?? "",
      gistId: "",
      sharedCode: "",
    };
  if (parts[0] === "gist")
    return {
      view: "gist",
      exampleId: "",
      gistId: parts[1] ?? "",
      sharedCode: "",
    };
  if (parts[0] === "code")
    return {
      view: "code",
      exampleId: "",
      gistId: "",
      sharedCode: parts[1] ?? "",
    };
  return { view: "home", exampleId: "", gistId: "", sharedCode: "" };
}

function App() {
  const [location, setLocation] = useState(() => route(window.location.hash));

  useEffect(() => {
    const onChange = () => setLocation(route(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const go = (hash: string) => {
    window.location.hash = hash;
    setLocation(route(hash));
    window.scrollTo(0, 0);
  };

  return location.view !== "home" ? (
    <Playground
      exampleId={location.exampleId}
      gistId={location.gistId}
      sharedCode={location.sharedCode}
      onExample={(id) => {
        window.history.replaceState(null, "", `#/play/${id}`);
      }}
      onGist={(id) => go(`#/gist/${id}`)}
      onHome={() => go("#/")}
    />
  ) : (
    <Home onOpen={(id) => go(id === undefined ? "#/play" : `#/play/${id}`)} />
  );
}

createRoot(document.getElementById("root")!).render(<App />);
