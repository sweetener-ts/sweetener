import React from "react";
import { examples } from "./examples";
import { tokenize } from "./sweet-syntax";

function Code({ file, children }: { file?: string; children: string }) {
  return (
    <figure className="code">
      {file === undefined ? null : <figcaption>{file}</figcaption>}
      <pre>
        <code>
          {tokenize(children).map((token, index) =>
            token.kind === "plain" || token.kind === "punctuation" ? (
              token.text
            ) : (
              <span className={`tok-${token.kind}`} key={index}>
                {token.text}
              </span>
            ),
          )}
        </code>
      </pre>
    </figure>
  );
}

export function Home({ onOpen }: { onOpen: (id?: string) => void }) {
  return (
    <div className="page">
      <header className="masthead">
        <h1>Sweetener</h1>
        <p className="lede">Hygienic, declarative macros for TypeScript.</p>
        <p>
          Sweetener lets a project extend TypeScript syntax while leaving type
          checking, declaration generation, JavaScript emission, and editor
          semantics to the official TypeScript compiler. Files ending in{" "}
          <code>.sts</code> expand into ordinary TypeScript, with source maps
          and expansion traces connecting the result back to what you wrote.
        </p>
        <p className="actions">
          <button className="primary" onClick={() => onOpen()}>
            Open the playground
          </button>
          <a href="https://github.com/jimmyhmiller/sweetener">
            Source on GitHub
          </a>
        </p>
        <p className="notice">
          Alpha. The compiler and its release artifacts are complete; the
          packages are not published to npm yet.
        </p>
      </header>

      <section>
        <h2>Define your own syntax</h2>
        <p>
          Macros are syntax-aware transformations rather than text substitution.
          You write a pattern and the syntax it expands to, then import it
          explicitly for compile time.
        </p>
        <Code file="operators.sts">{`export operator (|>):expr {
  fixity infix;
  associativity left;
  precedence 35;

  rule { $value:expr |> $function:ident $(. $member:ident)* ($($argument:expr),*) } => {
    $function $(. $member)*($value #if(present $argument) {, $($argument),*})
  }

  rule { $value:expr |> $function:ident $(. $member:ident)* } => {
    $function $(. $member)*($value)
  }
}`}</Code>
        <Code file="main.sts">{`import { (|>) } from "./operators.sts" for syntax;

const result = [1, 2, 3] |> map((n) => n * 2) |> sum;`}</Code>
        <p>
          The import says <code>for syntax</code>, so it runs at compile time
          and never appears in the emitted TypeScript.
        </p>
      </section>

      <section>
        <h2>Hygiene, without asking for it</h2>
        <p>
          A name a macro introduces cannot capture, or be captured by, a name at
          the call site. Nothing is required of the macro author: introduced
          identifiers carry definition and introduction scopes, captured ones
          keep their call-site identity.
        </p>
        <Code>{`// A macro introduces \`inspected\`. So does the call site.
export const inspected = "mine";
export const largest = dbg(Math.max(...readings));

// Generated:
export const inspected = "mine";
export const largest = ((inspected_1) => { … })(Math.max(...readings));`}</Code>
      </section>

      <section>
        <h2>How it works</h2>
        <Code>{`.sts / .stsx
    ↓ lossless TypeScript-aware reader
delimiter trees
    ↓ hygienic, context-directed macro expansion
ordinary TypeScript + origin map + expansion trace
    ↓ official TypeScript compiler
.js + .d.ts + source maps + TypeScript diagnostics`}</Code>
        <p>
          Because expansion finishes before the type checker starts, generated
          code is checked exactly like code you wrote, and a diagnostic is
          reported at the position in the <code>.sts</code> file it came from.
        </p>
      </section>

      <section>
        <h2>Examples</h2>
        <p>
          Each one is a whole working program. They run here in a Web Worker,
          against the same compiler the command line uses.
        </p>
        <ul className="examples">
          {examples.map((item) => (
            <li key={item.id}>
              <button onClick={() => onOpen(item.id)}>{item.name}</button>
              <span>{item.summary}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>A relative of Sweet.js</h2>
        <p>
          Sweetener draws on <a href="https://www.sweetjs.org/">Sweet.js</a>,
          keeping its strongest ideas — concrete patterns and templates, syntax
          classes, lexical macros, explicit compile-time imports, and scope-set
          hygiene — while targeting TypeScript.
        </p>
        <p>
          Unlike Sweet.js it neither parses JavaScript itself nor runs arbitrary
          JavaScript during expansion. It emits TypeScript for the official
          compiler, and its macro language has no access to the filesystem,
          network, environment, clock, randomness, or an evaluator.
        </p>
      </section>

      <footer className="colophon">
        <span>Sweetener</span>
        <a href="https://github.com/jimmyhmiller/sweetener">GitHub</a>
      </footer>
    </div>
  );
}
