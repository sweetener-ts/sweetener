import { basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import React, { useEffect, useMemo, useRef, useState } from "react";
import CompilerWorker from "./compiler-worker?worker";
import type { CompileResponse } from "./compiler-worker";
import { examples, type PlaygroundFile } from "./examples";
import { loadGistProject, resolveGistLoad } from "./gist";
import { formatPlaygroundFile } from "./format";
import { decodeSharedProject, encodeSharedProject } from "./share";
import { sweetHighlighting } from "./sweet-syntax";

const worker = new CompilerWorker();
let requestId = 0;

const editorTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", background: "#fff" },
  ".cm-content": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    lineHeight: "1.5",
    padding: "12px 0",
  },
  ".cm-gutters": {
    background: "#fff",
    borderRight: "1px solid #e1e4e8",
    color: "#8c959f",
  },
  ".cm-line": { padding: "0 12px" },
  ".cm-activeLine, .cm-activeLineGutter": { background: "#f6f8fa" },
});

function Editor({
  value,
  readOnly,
  onChange,
}: {
  value: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  const change = useRef(onChange);
  change.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    view.current = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          // The left pane is .sts and the right is the TypeScript it became,
          // so only one of them is Sweetener.
          readOnly
            ? javascript({ typescript: true, jsx: true })
            : sweetHighlighting,
          keymap.of([...defaultKeymap, indentWithTab]),
          editorTheme,
          EditorState.readOnly.of(Boolean(readOnly)),
          EditorView.editable.of(!readOnly),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              change.current?.(update.state.doc.toString());
          }),
        ],
      }),
    });
    return () => view.current?.destroy();
  }, [readOnly]);

  useEffect(() => {
    const current = view.current;
    if (!current || current.state.doc.toString() === value) return;
    current.dispatch({
      changes: { from: 0, to: current.state.doc.length, insert: value },
    });
  }, [value]);

  return <div className="editor" ref={host} />;
}

function copyFiles(files: PlaygroundFile[]) {
  return files.map((file) => ({ ...file }));
}

/** A project opened from outside the shipped examples: a Gist or a link. */
type LoadedProject = {
  source: "gist" | "shared";
  name: string;
  summary: string;
  entryFileName: string;
  files: PlaygroundFile[];
};

function formatBytes(count: number): string {
  return count < 1024 ? `${count} B` : `${(count / 1024).toFixed(1)} KB`;
}

export function Playground({
  exampleId: requested,
  gistId,
  sharedCode,
  onExample,
  onGist,
  onHome,
}: {
  exampleId: string;
  gistId: string;
  sharedCode: string;
  onExample: (id: string) => void;
  onGist: (id: string) => void;
  onHome: () => void;
}) {
  const initial = examples.find((item) => item.id === requested) ?? examples[0];
  const [exampleId, setExampleId] = useState(initial.id);
  const [entryFileName, setEntryFileName] = useState(initial.entryFileName);
  const [files, setFiles] = useState(() => copyFiles(initial.files));
  const [sourceTab, setSourceTab] = useState(initial.entryFileName);
  const [outputs, setOutputs] = useState<PlaygroundFile[]>([]);
  const [outputTab, setOutputTab] = useState(
    initial.entryFileName.endsWith("x") ? "main.tsx" : "main.ts",
  );
  const [diagnostics, setDiagnostics] = useState<string[]>(["Compiling…"]);
  const [compiling, setCompiling] = useState(true);
  const [loaded, setLoaded] = useState<LoadedProject>();
  const [gistReference, setGistReference] = useState("");
  const [loading, setLoading] = useState(Boolean(gistId || sharedCode));
  const [loadError, setLoadError] = useState("");
  const [gistReload, setGistReload] = useState(0);
  const [formatError, setFormatError] = useState("");
  const [shareStatus, setShareStatus] = useState("");

  const summary =
    loaded !== undefined
      ? loaded.summary
      : (examples.find((item) => item.id === exampleId)?.summary ?? "");
  const source =
    files.find((file) => file.fileName === sourceTab)?.source ?? "";
  const output =
    outputs.find((file) => file.fileName === outputTab)?.source ?? "";

  const compile = useMemo(() => {
    let timer: number | undefined;
    return (nextFiles: PlaygroundFile[], nextEntry: string) => {
      window.clearTimeout(timer);
      setCompiling(true);
      timer = window.setTimeout(() => {
        const id = ++requestId;
        const listener = (event: MessageEvent<CompileResponse>) => {
          if (event.data.id !== id) return;
          worker.removeEventListener("message", listener);
          setCompiling(false);
          if (event.data.error) {
            setOutputs([]);
            setDiagnostics([event.data.error]);
            return;
          }
          const result = event.data.result!;
          // A module of nothing but macro definitions expands to nothing:
          // macros are compile-time only. A tab onto an empty file suggests
          // the expansion produced something it did not.
          const written = result.outputs.filter(
            (file) => file.source.trim().length > 0,
          );
          setOutputs(written);
          setDiagnostics(result.diagnostics);
          setOutputTab((current) =>
            written.some((file) => file.fileName === current)
              ? current
              : (written.find((file) => file.fileName.startsWith("main."))
                  ?.fileName ??
                written[0]?.fileName ??
                ""),
          );
        };
        worker.addEventListener("message", listener);
        worker.postMessage({ id, files: nextFiles, entryFileName: nextEntry });
      }, 180);
    };
  }, []);

  useEffect(
    () => compile(files, entryFileName),
    [compile, entryFileName, files],
  );

  const openProject = (project: LoadedProject) => {
    setFormatError("");
    setShareStatus("");
    setLoaded(project);
    setExampleId(project.source);
    setEntryFileName(project.entryFileName);
    setFiles(copyFiles(project.files));
    setSourceTab(project.entryFileName);
    setOutputTab(project.entryFileName.endsWith("x") ? "main.tsx" : "main.ts");
  };

  const load = (
    request: (signal: AbortSignal) => Promise<LoadedProject>,
  ): (() => void) => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    request(controller.signal)
      .then((project) => {
        if (!controller.signal.aborted) openProject(project);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  };

  useEffect(() => {
    if (!gistId) return;
    return load(async (signal) => ({
      source: "gist",
      ...(await loadGistProject(gistId, signal)),
    }));
  }, [gistId, gistReload]);

  useEffect(() => {
    if (!sharedCode) return;
    return load(async () => ({
      source: "shared",
      name: "Shared code",
      summary: "Opened from a shared link.",
      ...(await decodeSharedProject(sharedCode)),
    }));
  }, [sharedCode]);

  const selectExample = (id: string) => {
    const next = examples.find((item) => item.id === id)!;
    setFormatError("");
    setShareStatus("");
    setExampleId(id);
    setLoaded(undefined);
    onExample(id);
    setEntryFileName(next.entryFileName);
    setFiles(copyFiles(next.files));
    setSourceTab(next.entryFileName);
    setOutputTab(next.entryFileName.endsWith("x") ? "main.tsx" : "main.ts");
  };

  const submitGist = (event: React.FormEvent) => {
    event.preventDefault();
    const request = resolveGistLoad(gistReference, gistId);
    if (request === undefined) {
      setLoadError("Enter a GitHub Gist URL or ID.");
      return;
    }
    setLoadError("");
    if (request.reload) setGistReload((current) => current + 1);
    else onGist(request.id);
  };

  const resetCurrent = () => {
    if (loaded === undefined) selectExample(exampleId);
    else openProject(loaded);
  };

  // The link replaces the address rather than navigating to it: the project
  // is already open, and reloading it would throw away the undo history.
  const share = async () => {
    const payload = await encodeSharedProject({ entryFileName, files });
    const url = new URL(window.location.href);
    url.hash = `#/code/${payload}`;
    window.history.replaceState(null, "", url);
    const size = formatBytes(url.href.length);
    try {
      await navigator.clipboard.writeText(url.href);
      setShareStatus(`Link copied (${size})`);
    } catch {
      setShareStatus(`Link is in the address bar (${size})`);
    }
  };

  const updateSource = (nextSource: string) => {
    setFormatError("");
    setFiles((current) =>
      current.map((file) =>
        file.fileName === sourceTab ? { ...file, source: nextSource } : file,
      ),
    );
  };

  const formatSource = async () => {
    try {
      updateSource(await formatPlaygroundFile(sourceTab, source));
    } catch (error) {
      setFormatError(error instanceof Error ? error.message : String(error));
    }
  };

  const formatOutput = async () => {
    try {
      const formatted = await formatPlaygroundFile(outputTab, output);
      setOutputs((current) =>
        current.map((file) =>
          file.fileName === outputTab ? { ...file, source: formatted } : file,
        ),
      );
      setFormatError("");
    } catch (error) {
      setFormatError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <main className="shell">
      <div className="playground-header">
        <header className="toolbar">
          <button className="home" onClick={onHome}>
            Sweetener
          </button>
          <label htmlFor="examples">Example</label>
          <select
            id="examples"
            value={exampleId}
            onChange={(event) => selectExample(event.target.value)}
          >
            {loaded !== undefined ? (
              <option value={loaded.source}>{loaded.name}</option>
            ) : null}
            {examples.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <button onClick={() => void share()}>Share</button>
          {shareStatus ? (
            <span className="share-status" role="status">
              {shareStatus}
            </span>
          ) : null}
          <form className="gist-loader" onSubmit={submitGist}>
            <input
              aria-label="GitHub Gist URL or ID"
              placeholder="Gist URL or ID"
              value={gistReference}
              onChange={(event) => {
                setGistReference(event.target.value);
                setLoadError("");
              }}
            />
            <button type="submit">Load Gist</button>
          </form>
          <span
            className={
              loading || compiling
                ? "state working"
                : loadError || formatError || diagnostics.length
                  ? "state error"
                  : "state ok"
            }
          >
            {loading
              ? sharedCode
                ? "Opening link…"
                : "Loading Gist…"
              : loadError
                ? sharedCode
                  ? "Link error"
                  : "Gist error"
                : formatError
                  ? "Format error"
                  : compiling
                    ? "Compiling…"
                    : diagnostics.length
                      ? `${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}`
                      : "No diagnostics"}
          </span>
          <button onClick={resetCurrent}>Reset</button>
        </header>
        {loadError ? (
          <div className="gist-error" role="alert">
            <b>
              {sharedCode
                ? "Could not open shared link."
                : "Could not load Gist."}
            </b>{" "}
            {loadError}
          </div>
        ) : null}
      </div>
      <section className="workspace">
        <section className="pane">
          <div className="pane-heading">
            <div className="pane-title">Source</div>
            <button
              aria-label={`Format ${sourceTab}`}
              onClick={() => void formatSource()}
              disabled={!source}
            >
              Format
            </button>
          </div>
          <div className="tabs" role="tablist">
            {files.map((file) => (
              <button
                className={sourceTab === file.fileName ? "active" : ""}
                onClick={() => setSourceTab(file.fileName)}
                key={file.fileName}
              >
                {file.fileName}
              </button>
            ))}
          </div>
          <Editor value={source} onChange={updateSource} />
          <footer
            className={
              loadError || formatError || diagnostics.length
                ? "details errors"
                : "details"
            }
          >
            <b>Diagnostics</b>
            <pre>
              {loading
                ? sharedCode
                  ? "Opening link…"
                  : "Loading Gist…"
                : formatError
                  ? formatError
                  : loadError
                    ? loadError
                    : compiling
                      ? "Compiling…"
                      : diagnostics.length
                        ? diagnostics.join("\n")
                        : "No diagnostics."}
            </pre>
          </footer>
        </section>
        <section className="pane">
          <div className="pane-heading">
            <div className="pane-title">Generated TypeScript</div>
            <button
              aria-label={`Format ${outputTab}`}
              onClick={() => void formatOutput()}
              disabled={compiling || !output}
            >
              Format
            </button>
          </div>
          <div className="tabs" role="tablist">
            {outputs.map((file) => (
              <button
                className={outputTab === file.fileName ? "active" : ""}
                onClick={() => setOutputTab(file.fileName)}
                key={file.fileName}
              >
                {file.fileName}
              </button>
            ))}
          </div>
          <Editor value={output} readOnly />
          <footer className="details output-info">
            <b>About</b>
            <pre>
              {summary}
              {"\n"}Expanded in your browser by the same compiler the command
              line uses.
            </pre>
          </footer>
        </section>
      </section>
    </main>
  );
}
