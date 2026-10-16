import { describe, expect, it } from "vitest";
import {
  capturedInvocationScopes,
  createInvocationScopes,
  finishTransformerOutput,
  introducedTemplateScopes,
  prepareTransformerInput,
  ScopeStore,
  scopesResolveBinding,
} from "../src/index.js";

describe("macro invocation scope model", () => {
  it("flips the introduction scope and retains the use-site scope on captures", () => {
    const store = new ScopeStore();
    const lexical = store.freshScope("lexical", "call-site binding");
    const original = store.singleton(lexical);
    const invocation = createInvocationScopes(store);
    const prepared = prepareTransformerInput(store, original, invocation);
    expect(store.has(prepared, lexical)).toBe(true);
    expect(store.has(prepared, invocation.useSite)).toBe(true);
    expect(store.has(prepared, invocation.introduction)).toBe(true);

    const captured = finishTransformerOutput(store, prepared, invocation);
    expect(captured).toBe(
      capturedInvocationScopes(store, original, invocation),
    );
    expect(store.has(captured, lexical)).toBe(true);
    expect(store.has(captured, invocation.useSite)).toBe(true);
    expect(store.has(captured, invocation.introduction)).toBe(false);
  });

  it("gives introduced identifiers definition scopes plus introduction scope", () => {
    const store = new ScopeStore();
    const definition = store.freshScope("module", "definition module");
    const callSite = store.freshScope("lexical", "caller local");
    const invocation = createInvocationScopes(store);
    const introduced = introducedTemplateScopes(
      store,
      store.singleton(definition),
      invocation,
    );
    expect(store.has(introduced, definition)).toBe(true);
    expect(store.has(introduced, invocation.introduction)).toBe(true);
    expect(store.has(introduced, invocation.useSite)).toBe(false);
    expect(
      scopesResolveBinding(store, store.singleton(definition), introduced),
    ).toBe(true);
    expect(
      scopesResolveBinding(store, store.singleton(callSite), introduced),
    ).toBe(false);
  });

  it("keeps a captured local macro declaration and its captured use aligned", () => {
    const store = new ScopeStore();
    const localMacroRegion = store.freshScope("lexical", "local macro region");
    const original = store.singleton(localMacroRegion);
    const invocation = createInvocationScopes(store);
    const declaration = capturedInvocationScopes(store, original, invocation);
    const use = capturedInvocationScopes(store, original, invocation);
    expect(declaration).toBe(use);
    expect(scopesResolveBinding(store, declaration, use)).toBe(true);
  });

  it("lets generated declarations bind generated uses without capturing input", () => {
    const store = new ScopeStore();
    const definition = store.freshScope("module", "macro module");
    const generatedRegion = store.freshScope(
      "lexical",
      "generated declaration region",
    );
    const caller = store.freshScope("lexical", "caller");
    const invocation = createInvocationScopes(store);
    const introduced = introducedTemplateScopes(
      store,
      store.singleton(definition),
      invocation,
    );
    const declaration = store.add(introduced, generatedRegion);
    const generatedUse = store.add(introduced, generatedRegion);
    const capturedUse = capturedInvocationScopes(
      store,
      store.singleton(caller),
      invocation,
    );
    expect(scopesResolveBinding(store, declaration, generatedUse)).toBe(true);
    expect(scopesResolveBinding(store, declaration, capturedUse)).toBe(false);
  });

  it("allocates distinct use-site and introduction scopes for nested invocations", () => {
    const store = new ScopeStore();
    const original = store.empty();
    const outer = createInvocationScopes(store);
    const inner = createInvocationScopes(store);
    const afterOuter = capturedInvocationScopes(store, original, outer);
    const afterInner = capturedInvocationScopes(store, afterOuter, inner);
    expect(outer.introduction).not.toBe(inner.introduction);
    expect(outer.useSite).not.toBe(inner.useSite);
    expect(store.has(afterInner, outer.useSite)).toBe(true);
    expect(store.has(afterInner, inner.useSite)).toBe(true);
    expect(store.has(afterInner, outer.introduction)).toBe(false);
    expect(store.has(afterInner, inner.introduction)).toBe(false);
  });
});

describe("template privacy", () => {
  it("marks introduced syntax private and captured syntax public", () => {
    const store = new ScopeStore();
    const definition = store.singleton(store.freshScope("module", "macro"));
    const callSite = store.singleton(store.freshScope("lexical", "caller"));
    const invocation = createInvocationScopes(store);

    const introduced = introducedTemplateScopes(store, definition, invocation);
    const captured = capturedInvocationScopes(store, callSite, invocation);

    expect(store.hasUnmatchedIntroduction(introduced)).toBe(true);
    expect(store.hasUnmatchedIntroduction(captured)).toBe(false);
    expect(store.hasUnmatchedIntroduction(callSite)).toBe(false);
  });

  it("treats a deliberately published identifier as public", () => {
    const store = new ScopeStore();
    const callSite = store.singleton(store.freshScope("lexical", "caller"));
    const invocation = createInvocationScopes(store);
    // `#capture` adds the introduction scope back onto call-site scopes so the
    // identifier binds at the call site on purpose.
    const published = store.add(
      capturedInvocationScopes(store, callSite, invocation),
      invocation.introduction,
    );
    expect(store.hasUnmatchedIntroduction(published)).toBe(false);
  });

  it("keeps outer template syntax private inside a nested expansion", () => {
    const store = new ScopeStore();
    const definition = store.singleton(store.freshScope("module", "macro"));
    const outer = createInvocationScopes(store);
    const inner = createInvocationScopes(store);
    const fromOuterTemplate = introducedTemplateScopes(
      store,
      definition,
      outer,
    );
    // The outer template's syntax is the inner macro's call site.
    const seenByInner = capturedInvocationScopes(
      store,
      fromOuterTemplate,
      inner,
    );
    expect(store.hasUnmatchedIntroduction(seenByInner)).toBe(true);
  });

  it("tells what a template wrote at an invocation made since a mark", () => {
    const store = new ScopeStore();
    const definition = store.singleton(store.freshScope("module", "macro"));
    const callSite = store.singleton(store.freshScope("lexical", "caller"));
    const before = createInvocationScopes(store);
    const mark = store.mark();
    const since = createInvocationScopes(store);
    const writtenSince = introducedTemplateScopes(store, definition, since);
    const writtenBefore = introducedTemplateScopes(store, definition, before);
    // A template wrote the outer syntax before the mark; the inner macro
    // wrote nothing, and only copied it.
    const copiedSince = capturedInvocationScopes(store, writtenBefore, since);
    const published = store.add(
      capturedInvocationScopes(store, callSite, since),
      since.introduction,
    );
    expect(store.introducedSince(writtenSince, mark)).toBe(true);
    expect(store.introducedSince(writtenBefore, mark)).toBe(false);
    expect(store.introducedSince(copiedSince, mark)).toBe(false);
    expect(store.introducedSince(published, mark)).toBe(false);
    expect(store.introducedSince(callSite, mark)).toBe(false);
  });

  it("answers the call site a published identifier binds at", () => {
    const store = new ScopeStore();
    const definition = store.singleton(store.freshScope("module", "macro"));
    const callSite = store.singleton(store.freshScope("lexical", "caller"));
    const invocation = createInvocationScopes(store);
    const captured = capturedInvocationScopes(store, callSite, invocation);
    const published = store.add(captured, invocation.introduction);
    const introduced = introducedTemplateScopes(store, definition, invocation);
    expect(store.publishedTo(published)).toBe(callSite);
    // Neither a copied capture nor template syntax was published: each keeps
    // the invocation scope that keeps it from binding the call site's names.
    expect(store.publishedTo(captured)).toBe(captured);
    expect(store.publishedTo(introduced)).toBe(introduced);
  });

  it("rejects a pairing that is not an introduction and use-site pair", () => {
    const store = new ScopeStore();
    const invocation = createInvocationScopes(store);
    const lexical = store.freshScope("lexical", "caller");
    expect(() =>
      store.pairInvocationScopes(lexical, invocation.useSite),
    ).toThrow(TypeError);
    expect(() =>
      store.pairInvocationScopes(invocation.introduction, lexical),
    ).toThrow(TypeError);
  });
});
