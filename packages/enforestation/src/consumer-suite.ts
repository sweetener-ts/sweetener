import {
  bindingMacroResolver,
  createBindingConsumer,
  type BindingConsumer,
} from "./binding-parameter.js";
import {
  ConsumerRegistry,
  type MacroExtentResolver,
  type SyntaxConsumer,
} from "./consumer.js";
import { createJsxChildConsumer } from "./jsx-child.js";
import {
  createPrattExpressionConsumer,
  type MacroOperatorResolver,
} from "./pratt-expression.js";
import {
  createItemConsumer,
  createStatementConsumer,
  type StatementBlockConsumer,
} from "./statement-item.js";
import {
  createClassElementConsumer,
  createTypeConsumers,
} from "./type-class-element.js";
import type { SyntaxId } from "@sweetener/shared";
import type { OriginStore, Syntax } from "@sweetener/syntax";

/**
 * What the consumers need, and what connects them to macro expansion.
 *
 * The three resolvers are what a caller with macros in scope supplies. Left
 * out, the suite reads TypeScript and nothing else, which is what a test of
 * the grammar itself wants.
 */
export interface ConsumerSuiteOptions {
  readonly allocateSyntaxId: () => SyntaxId;
  readonly origins: OriginStore;
  /**
   * Claims a macro invocation and answers with its extent. One resolver
   * answers for every category; the suite narrows it where a consumer reads a
   * narrower set.
   */
  readonly resolveMacro?: MacroExtentResolver | undefined;
  readonly resolveMacroOperator?: MacroOperatorResolver | undefined;
  /**
   * Reports a statement operator standing in a run, so the run is left for the
   * expander to walk rather than committed to its ordinary reading.
   */
  readonly holdsStatementOperator?:
    ((children: readonly Syntax[]) => boolean) | undefined;
  /**
   * Enables the low-precedence comma operator, for a full Expression context.
   * The expander reads expressions in contexts where a comma separates rather
   * than sequences, so it leaves this off.
   */
  readonly allowComma?: boolean | undefined;
}

/**
 * The consumers, and a registry holding each under the category it reads.
 */
export interface ConsumerSuite {
  readonly type: SyntaxConsumer;
  readonly typeMember: SyntaxConsumer;
  readonly classElement: SyntaxConsumer;
  readonly expression: SyntaxConsumer;
  readonly binding: BindingConsumer;
  readonly statement: StatementBlockConsumer;
  readonly item: SyntaxConsumer;
  readonly jsxChild: SyntaxConsumer;
  readonly registry: ConsumerRegistry;
}

/**
 * Every syntax consumer, wired to the others the way each one needs.
 *
 * The wiring is the point. A consumer built alone reads a language that is not
 * TypeScript: without `consumeType` the expression consumer cannot read
 * `a as string[]`, and a statement holding one falls back to unexpanded
 * tokens. A test harness that assembled its own consumers therefore reported
 * gaps the real pipeline does not have, and could not have reported a gap the
 * missing consumer would have covered.
 *
 * So there is one place that knows how the layers meet, and both the expander
 * and the tests come through it.
 */
export function createConsumerSuite(
  options: ConsumerSuiteOptions,
): ConsumerSuite {
  const shared = {
    origins: options.origins,
    allocateSyntaxId: options.allocateSyntaxId,
  };
  const resolveMacro = options.resolveMacro;
  // Built before the consumers that need it: what stands to the right of `as`
  // and `satisfies` is a type, and the statement and item consumers build
  // expression consumers of their own, so it has to reach all of them.
  // Passing it only to the expression consumer left `const value = 1 as
  // number;` unparseable inside a function body while working at the top
  // level.
  //
  // The member consumer is given the extent resolver directly so a member
  // macro's own rule decides where its invocation ends; a member list
  // separates on `,`, which would otherwise cut an invocation holding one in
  // half. The type consumer is given a resolver that declines `classElement`,
  // the one category the extent resolver does not answer for.
  const typeConsumers = createTypeConsumers({
    ...shared,
    // A type macro standing in a typed capture is measured by its own rule.
    // Without this, only one shaped like a generic type (`list<string>`) would
    // read through; `wrap { string }` would stop at its brace.
    ...(resolveMacro === undefined
      ? {}
      : {
          resolveMacro: (category, cursor, context) =>
            category === "classElement"
              ? undefined
              : resolveMacro(category, cursor, context),
          resolveTypeMemberMacro: resolveMacro,
        }),
  });
  const type = typeConsumers.type;
  const consumerShared = {
    ...shared,
    consumeType: type,
    ...(resolveMacro === undefined ? {} : { resolveMacro }),
    ...(options.resolveMacroOperator === undefined
      ? {}
      : { resolveMacroOperator: options.resolveMacroOperator }),
    ...(options.allowComma === undefined
      ? {}
      : { allowComma: options.allowComma }),
  };
  const statementShared = {
    ...consumerShared,
    ...(options.holdsStatementOperator === undefined
      ? {}
      : { holdsStatementOperator: options.holdsStatementOperator }),
  };
  const expression = createPrattExpressionConsumer(consumerShared);
  const binding = createBindingConsumer({
    ...shared,
    ...(resolveMacro === undefined
      ? {}
      : { resolveMacro: bindingMacroResolver(resolveMacro) }),
  });
  const statement = createStatementConsumer(statementShared);
  const item = createItemConsumer(statementShared);
  const jsxChild = createJsxChildConsumer(shared);
  const classElement = createClassElementConsumer({
    ...shared,
    enforestStatementBlock: (block, blockContext, allowYield, allowAwait) =>
      statement.enforestBlock(block, blockContext, allowYield, allowAwait),
  });
  const typeMember = typeConsumers.typeMember;
  return Object.freeze({
    type,
    typeMember,
    classElement,
    expression,
    binding,
    statement,
    item,
    jsxChild,
    registry: new ConsumerRegistry([
      { category: "type", consumer: type },
      { category: "typeMember", consumer: typeMember },
      { category: "classElement", consumer: classElement },
      { category: "expr", consumer: expression },
      { category: "binding", consumer: binding },
      { category: "stmt", consumer: statement },
      { category: "item", consumer: item },
      { category: "jsxChild", consumer: jsxChild },
    ]),
  });
}
